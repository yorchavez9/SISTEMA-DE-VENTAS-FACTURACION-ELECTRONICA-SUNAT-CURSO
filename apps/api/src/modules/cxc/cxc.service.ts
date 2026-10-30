import type { AntiguedadDto, CobroDto, CobroInput, CuentaPorCobrarDto, CuotaDto, EstadoCuentaDto, Moneda, Pagina } from '@sv/shared';
import type { Knex } from 'knex';
import { db, type Trx } from '../../database/db.js';
import { aImporte, dec, Decimal } from '../../shared/decimal.js';
import { ErrorApp, errores } from '../../shared/errors.js';
import { fechaLima } from '../../shared/fechas.js';
import { consumirAutorizacion } from '../auth/auth.service.js';
import { bloquearTurnoAbierto, registrarMovimiento } from '../caja/caja.service.js';

const diasEntre = (desde: string, hasta: string) => Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);

function estadoDe(monto: Decimal.Value, saldo: Decimal.Value): 'pendiente' | 'parcial' | 'pagada' {
  if (dec(saldo).isZero()) return 'pagada';
  return dec(saldo).eq(monto) ? 'pendiente' : 'parcial';
}

/** Turno abierto de una caja de la sucursal activa. */
async function turnoDeCaja(cajaId: number, sucursalId: number): Promise<number> {
  const c = await db('cajas as c')
    .leftJoin('turnos_caja as t', function () {
      this.on('t.caja_id', 'c.id').andOnVal('t.estado', 'abierto');
    })
    .where('c.id', cajaId)
    .first('c.sucursal_id', 't.id as turno_id');
  if (!c || Number(c.sucursal_id) !== sucursalId) throw errores.validacion({ cajaId: 'La caja no pertenece a la sucursal activa' });
  if (!c.turno_id) throw new ErrorApp(409, 'TURNO_NO_ABIERTO', 'Abre la caja para registrar cobros');
  return Number(c.turno_id);
}

async function tipoCambioHoy(): Promise<string> {
  const tc = await db('tipos_cambio').where('fecha', fechaLima()).first('venta');
  if (!tc) throw new ErrorApp(409, 'TIPO_CAMBIO_NO_REGISTRADO', `Registra el tipo de cambio de hoy (${fechaLima()}) para cobrar en otra moneda`);
  return String(tc.venta);
}

/** Convierte de la moneda de la cuota a la del pago con el tipo de cambio del día. */
const aMonedaPago = (monto: Decimal.Value, deMoneda: Moneda, aMoneda: Moneda, tc: string) =>
  deMoneda === aMoneda ? dec(monto) : aMoneda === 'PEN' ? dec(monto).times(tc).toDecimalPlaces(2) : dec(monto).div(tc).toDecimalPlaces(2);

/**
 * Registra un cobro y lo aplica a cuotas (todo en una transacción con el movimiento de caja).
 * Sin aplicaciones explícitas se pagan las cuotas de la misma moneda, de la más antigua a la más nueva.
 * No admite pagar más de lo adeudado.
 */
export async function registrarCobro(datos: CobroInput, ctx: { sucursalId: number; operadorId: number; idempotencyKey: string }): Promise<{ cobro: CobroDto; repetido: boolean }> {
  const previo = await db('cobros').where('idempotency_key', ctx.idempotencyKey).first('id');
  if (previo) return { cobro: await obtenerCobro(Number(previo.id)), repetido: true };

  const turnoId = await turnoDeCaja(datos.cajaId, ctx.sucursalId);
  const metodo = await db('metodos_pago').where({ id: datos.metodoPagoId, activo: true }).first('requiere_referencia', 'nombre');
  if (!metodo) throw errores.validacion({ metodoPagoId: 'Medio de pago inválido' });
  if (metodo.requiere_referencia && !datos.referencia) throw errores.validacion({ referencia: `${metodo.nombre}: indica el número de operación` });

  const necesitaTc = datos.aplicaciones?.length
    ? (await db('cuotas as q').join('cuentas_por_cobrar as c', 'c.id', 'q.cxc_id').whereIn('q.id', datos.aplicaciones.map((a) => a.cuotaId)).pluck('c.moneda')).some((m: string) => m !== datos.moneda)
    : false;
  const tc = necesitaTc ? await tipoCambioHoy() : '1';

  try {
    const id = await db.transaction(async (trx) => {
      await bloquearTurnoAbierto(trx, turnoId);
      const cuotas = await trx('cuotas as q')
        .join('cuentas_por_cobrar as c', 'c.id', 'q.cxc_id')
        .where('c.cliente_id', datos.clienteId)
        .whereIn('q.estado', ['pendiente', 'parcial'])
        .modify((q) => (datos.aplicaciones?.length ? q.whereIn('q.id', datos.aplicaciones.map((a) => a.cuotaId)) : q.where('c.moneda', datos.moneda)))
        .orderBy([{ column: 'q.fecha_vencimiento' }, { column: 'q.cxc_id' }, { column: 'q.numero' }])
        .forUpdate()
        .select('q.id', 'q.cxc_id', 'q.monto', 'q.saldo', 'c.moneda');
      if (!cuotas.length) throw errores.validacion({ monto: `El cliente no tiene cuotas pendientes en ${datos.moneda}` });

      // Plan de aplicación (montos en la moneda de cada cuota).
      let plan: Array<{ cuota: (typeof cuotas)[number]; monto: Decimal }>;
      if (datos.aplicaciones?.length) {
        if (cuotas.length !== datos.aplicaciones.length) throw errores.validacion({ aplicaciones: 'Alguna cuota no es del cliente o ya está pagada' });
        plan = datos.aplicaciones.map((a) => {
          const cuota = cuotas.find((c: { id: number | string }) => Number(c.id) === a.cuotaId)!;
          if (dec(a.monto).gt(cuota.saldo)) throw errores.validacion({ aplicaciones: `La cuota ${a.cuotaId} tiene saldo ${cuota.saldo}` });
          return { cuota, monto: dec(a.monto) };
        });
        const equivalente = plan.reduce((acc, p) => acc.plus(aMonedaPago(p.monto, p.cuota.moneda, datos.moneda, tc)), dec(0));
        const tolerancia = dec(plan.filter((p) => p.cuota.moneda !== datos.moneda).length).times('0.01');
        if (equivalente.minus(datos.monto).abs().gt(tolerancia)) {
          throw errores.validacion({ monto: `El monto (${datos.monto}) no coincide con lo aplicado a las cuotas (${aImporte(equivalente)} ${datos.moneda})` });
        }
      } else {
        let restante = dec(datos.monto);
        const total = cuotas.reduce((a: Decimal, c: { saldo: string }) => a.plus(c.saldo), dec(0));
        if (restante.gt(total)) throw errores.validacion({ monto: `El monto supera la deuda pendiente en ${datos.moneda} (${aImporte(total)})` });
        plan = [];
        for (const cuota of cuotas) {
          if (restante.isZero()) break;
          const aplicar = Decimal.min(restante, cuota.saldo);
          plan.push({ cuota, monto: aplicar });
          restante = restante.minus(aplicar);
        }
      }

      const [cobroId] = await trx('cobros').insert({
        cliente_id: datos.clienteId,
        turno_id: turnoId,
        metodo_pago_id: datos.metodoPagoId,
        moneda: datos.moneda,
        monto: aImporte(datos.monto),
        tipo_cambio: tc,
        referencia: datos.referencia ?? null,
        usuario_id: ctx.operadorId,
        idempotency_key: ctx.idempotencyKey,
      });
      for (const p of plan) {
        await trx('cobro_aplicaciones').insert({ cobro_id: cobroId, cuota_id: p.cuota.id, monto: aImporte(p.monto) });
        const saldo = dec(p.cuota.saldo).minus(p.monto);
        await trx('cuotas').where('id', p.cuota.id).update({ saldo: aImporte(saldo), estado: estadoDe(p.cuota.monto, saldo) });
      }
      await recalcularCuentas(trx, [...new Set(plan.map((p) => Number(p.cuota.cxc_id)))]);
      await registrarMovimiento(trx, {
        turnoId,
        tipo: 'cobro',
        metodoPagoId: datos.metodoPagoId,
        moneda: datos.moneda,
        monto: datos.monto,
        concepto: `Cobro ${cobroId}`,
        referencia: datos.referencia,
        origenTipo: 'cobro',
        origenId: Number(cobroId),
        usuarioId: ctx.operadorId,
      });
      return Number(cobroId);
    });
    return { cobro: await obtenerCobro(id), repetido: false };
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      const otro = await db('cobros').where('idempotency_key', ctx.idempotencyKey).first('id');
      if (otro) return { cobro: await obtenerCobro(Number(otro.id)), repetido: true };
    }
    throw err;
  }
}

/** El saldo y el estado de cada cuenta salen de sus cuotas. */
async function recalcularCuentas(trx: Trx, cxcIds: number[]): Promise<void> {
  for (const id of cxcIds) {
    const [{ saldo }] = (await trx('cuotas').where('cxc_id', id).whereNot('estado', 'anulada').sum({ saldo: 'saldo' })) as [{ saldo: string | null }];
    const cxc = await trx('cuentas_por_cobrar').where('id', id).first('total');
    await trx('cuentas_por_cobrar').where('id', id).update({ saldo: aImporte(dec(saldo)), estado: estadoDe(cxc.total, dec(saldo)) });
  }
}

/** Anula un cobro: devuelve el saldo a las cuotas y registra la salida de caja. */
export async function anularCobro(
  id: number,
  datos: { motivo: string; cajaId: number; autorizacionToken?: string },
  ctx: { sucursalId: number; operadorId: number; permisos: Set<string> },
): Promise<CobroDto> {
  let autorizadoPor = ctx.operadorId;
  if (!ctx.permisos.has('cxc.anular')) {
    if (!datos.autorizacionToken) throw new ErrorApp(403, 'REQUIERE_AUTORIZACION', 'Anular un cobro requiere la autorización de un supervisor', undefined, { accion: 'anular' });
    autorizadoPor = await consumirAutorizacion(datos.autorizacionToken, 'anular', ctx.operadorId);
  }
  const turnoId = await turnoDeCaja(datos.cajaId, ctx.sucursalId);

  await db.transaction(async (trx) => {
    await bloquearTurnoAbierto(trx, turnoId);
    const cobro = await trx('cobros').where('id', id).forUpdate().first();
    if (!cobro) throw errores.noEncontrado('Cobro');
    if (cobro.estado === 'anulado') throw new ErrorApp(409, 'ESTADO_NO_PERMITE', 'El cobro ya está anulado');

    const aplicaciones = await trx('cobro_aplicaciones').where('cobro_id', id).select('cuota_id', 'monto');
    const cuotas = await trx('cuotas').whereIn('id', aplicaciones.map((a: { cuota_id: number }) => a.cuota_id)).forUpdate().select('id', 'cxc_id', 'monto', 'saldo', 'estado');
    for (const a of aplicaciones as Array<{ cuota_id: number | string; monto: string }>) {
      const q = cuotas.find((c: { id: number | string }) => Number(c.id) === Number(a.cuota_id))!;
      if (q.estado === 'anulada') throw new ErrorApp(409, 'ESTADO_NO_PERMITE', 'La venta de este cobro fue anulada');
      const saldo = dec(q.saldo).plus(a.monto);
      await trx('cuotas').where('id', q.id).update({ saldo: aImporte(saldo), estado: estadoDe(q.monto, saldo) });
    }
    await recalcularCuentas(trx, [...new Set(cuotas.map((c: { cxc_id: number | string }) => Number(c.cxc_id)))]);
    await registrarMovimiento(trx, {
      turnoId,
      tipo: 'anulacion',
      metodoPagoId: Number(cobro.metodo_pago_id),
      moneda: cobro.moneda,
      monto: dec(cobro.monto).negated(),
      concepto: `Anulación del cobro ${id}: ${datos.motivo}`,
      origenTipo: 'cobro',
      origenId: id,
      usuarioId: ctx.operadorId,
    });
    await trx('cobros').where('id', id).update({ estado: 'anulado', motivo_anulacion: datos.motivo, anulado_por: autorizadoPor });
  });
  return obtenerCobro(id);
}

// ---------- Consultas ----------

export async function obtenerCobro(id: number, conn: Knex = db): Promise<CobroDto> {
  const c = await conn('cobros as c')
    .join('clientes as cl', 'cl.id', 'c.cliente_id')
    .join('metodos_pago as m', 'm.id', 'c.metodo_pago_id')
    .join('usuarios as u', 'u.id', 'c.usuario_id')
    .where('c.id', id)
    .first('c.*', 'cl.razon_social', 'm.nombre as metodo', 'u.nombre as usuario');
  if (!c) throw errores.noEncontrado('Cobro');
  const aplicaciones = await conn('cobro_aplicaciones as a')
    .join('cuotas as q', 'q.id', 'a.cuota_id')
    .join('cuentas_por_cobrar as x', 'x.id', 'q.cxc_id')
    .where('a.cobro_id', id)
    .orderBy('a.id') // orden en que se aplicó el pago
    .select('a.cuota_id', 'a.monto', 'q.numero', 'x.venta_id', 'x.moneda');
  return {
    id: Number(c.id),
    fecha: new Date(c.fecha).toISOString(),
    cliente: { id: Number(c.cliente_id), razonSocial: c.razon_social },
    metodo: c.metodo,
    moneda: c.moneda,
    monto: c.monto,
    tipoCambio: String(c.tipo_cambio),
    referencia: c.referencia ?? null,
    estado: c.estado,
    motivoAnulacion: c.motivo_anulacion ?? null,
    usuario: c.usuario,
    aplicaciones: aplicaciones.map((a: Record<string, unknown>) => ({ cuotaId: Number(a.cuota_id), ventaId: Number(a.venta_id), numero: Number(a.numero), moneda: a.moneda as Moneda, monto: String(a.monto) })),
  };
}

async function cuentasConCuotas(filas: Array<Record<string, unknown>>): Promise<CuentaPorCobrarDto[]> {
  if (!filas.length) return [];
  const hoy = fechaLima();
  const cuotas = await db('cuotas').whereIn('cxc_id', filas.map((f) => Number(f.id))).orderBy(['cxc_id', 'numero']);
  return filas.map((f) => {
    const propias: CuotaDto[] = cuotas
      .filter((q: { cxc_id: number | string }) => Number(q.cxc_id) === Number(f.id))
      .map((q: Record<string, string>) => ({
        id: Number(q.id),
        numero: Number(q.numero),
        monto: q.monto!,
        saldo: q.saldo!,
        fechaVencimiento: q.fecha_vencimiento!,
        estado: q.estado as CuotaDto['estado'],
        diasVencida: ['pendiente', 'parcial'].includes(q.estado!) && q.fecha_vencimiento! < hoy ? diasEntre(q.fecha_vencimiento!, hoy) : 0,
      }));
    return {
      id: Number(f.id),
      ventaId: Number(f.venta_id),
      comprobante: (f.numero_completo as string | null) ?? (f.serie ? `${f.serie} (por emitir)` : null),
      cliente: { id: Number(f.cliente_id), razonSocial: String(f.razon_social), numDoc: String(f.num_doc) },
      moneda: f.moneda as Moneda,
      total: String(f.total),
      saldo: String(f.saldo),
      estado: f.estado as CuentaPorCobrarDto['estado'],
      fecha: new Date(f.created_at as string).toISOString(),
      venceUltima: String(f.vence_ultima),
      vencida: propias.some((q) => q.diasVencida > 0),
      cuotas: propias,
    };
  });
}

const consultaCuentas = () =>
  db('cuentas_por_cobrar as x')
    .join('clientes as cl', 'cl.id', 'x.cliente_id')
    .join('ventas as v', 'v.id', 'x.venta_id')
    .leftJoin('comprobantes as cp', function () {
      this.on('cp.venta_id', 'x.venta_id').andOn('cp.tipo_doc', 'v.tipo_comprobante');
    })
    .select('x.*', 'cl.razon_social', 'cl.num_doc', 'cp.numero_completo', 'cp.serie');

export async function listarCuentas(
  sucursalIds: number[],
  f: { page: number; pageSize: number; clienteId?: number; estado?: string; moneda?: Moneda; vencidas?: boolean; q?: string },
): Promise<Pagina<CuentaPorCobrarDto>> {
  const filtrar = (q: Knex.QueryBuilder) => {
    q.whereIn('v.sucursal_id', sucursalIds);
    if (f.clienteId) q.where('x.cliente_id', f.clienteId);
    if (f.estado) q.where('x.estado', f.estado);
    else q.whereIn('x.estado', ['pendiente', 'parcial']);
    if (f.moneda) q.where('x.moneda', f.moneda);
    if (f.q) q.where((w) => w.whereILike('cl.razon_social', `%${f.q!.replace(/[\\%_]/g, '')}%`).orWhere('cl.num_doc', 'like', `${f.q!.replace(/[\\%_]/g, '')}%`));
    if (f.vencidas) {
      q.whereExists(
        db('cuotas as q').whereRaw('q.cxc_id = x.id').whereIn('q.estado', ['pendiente', 'parcial']).andWhere('q.fecha_vencimiento', '<', fechaLima()),
      );
    }
  };
  const [{ total }] = (await db('cuentas_por_cobrar as x').join('clientes as cl', 'cl.id', 'x.cliente_id').join('ventas as v', 'v.id', 'x.venta_id').modify(filtrar).count({ total: '*' })) as [{ total: number }];
  const filas = await consultaCuentas().modify(filtrar).orderBy('x.vence_ultima').limit(f.pageSize).offset((f.page - 1) * f.pageSize);
  return { data: await cuentasConCuotas(filas), page: f.page, pageSize: f.pageSize, total: Number(total) };
}

export async function estadoCuenta(clienteId: number): Promise<EstadoCuentaDto> {
  const cliente = await db('clientes').where('id', clienteId).first();
  if (!cliente) throw errores.noEncontrado('Cliente');
  const cuentas = await cuentasConCuotas(await consultaCuentas().where('x.cliente_id', clienteId).orderBy('x.id', 'desc').limit(100));
  const ids = await db('cobros').where('cliente_id', clienteId).orderBy('id', 'desc').limit(50).pluck('id');
  const cobros = await Promise.all(ids.map((id: number | string) => obtenerCobro(Number(id))));

  const saldos = (['PEN', 'USD'] as Moneda[])
    .map((moneda) => {
      const activas = cuentas.filter((c) => c.moneda === moneda && ['pendiente', 'parcial'].includes(c.estado));
      const saldo = activas.reduce((a, c) => a.plus(c.saldo), dec(0));
      const vencido = activas.flatMap((c) => c.cuotas).filter((q) => q.diasVencida > 0).reduce((a, q) => a.plus(q.saldo), dec(0));
      return { moneda, saldo: aImporte(saldo), vencido: aImporte(vencido) };
    })
    .filter((s) => dec(s.saldo).gt(0));

  return {
    cliente: { id: Number(cliente.id), razonSocial: cliente.razon_social, numDoc: cliente.num_doc, limiteCredito: cliente.limite_credito ?? null, monedaCredito: cliente.moneda_credito ?? null },
    saldos,
    cuentas,
    cobros,
  };
}

/** Antigüedad de la deuda por moneda, según días de vencimiento de cada cuota. */
export async function antiguedad(sucursalIds: number[]): Promise<AntiguedadDto[]> {
  const hoy = fechaLima();
  const cuotas = await db('cuotas as q')
    .join('cuentas_por_cobrar as x', 'x.id', 'q.cxc_id')
    .join('ventas as v', 'v.id', 'x.venta_id')
    .whereIn('v.sucursal_id', sucursalIds)
    .whereIn('q.estado', ['pendiente', 'parcial'])
    .select('q.saldo', 'q.fecha_vencimiento', 'x.moneda');
  const tramos = new Map<Moneda, Record<'porVencer' | 'd1a30' | 'd31a60' | 'd61a90' | 'mas90', Decimal>>();
  for (const q of cuotas as Array<{ saldo: string; fecha_vencimiento: string; moneda: Moneda }>) {
    const t = tramos.get(q.moneda) ?? { porVencer: dec(0), d1a30: dec(0), d31a60: dec(0), d61a90: dec(0), mas90: dec(0) };
    const dias = q.fecha_vencimiento < hoy ? diasEntre(q.fecha_vencimiento, hoy) : 0;
    const clave = dias === 0 ? 'porVencer' : dias <= 30 ? 'd1a30' : dias <= 60 ? 'd31a60' : dias <= 90 ? 'd61a90' : 'mas90';
    t[clave] = t[clave].plus(q.saldo);
    tramos.set(q.moneda, t);
  }
  return [...tramos].map(([moneda, t]) => ({
    moneda,
    porVencer: aImporte(t.porVencer),
    d1a30: aImporte(t.d1a30),
    d31a60: aImporte(t.d31a60),
    d61a90: aImporte(t.d61a90),
    mas90: aImporte(t.mas90),
    total: aImporte(Object.values(t).reduce((a, b) => a.plus(b), dec(0))),
  }));
}
