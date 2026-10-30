import type { CajaDto, Moneda, ResumenTurnoDto } from '@sv/shared';
import type { Knex } from 'knex';
import { db, type Trx } from '../../database/db.js';
import { aImporte, dec, Decimal } from '../../shared/decimal.js';
import { ErrorApp, errores } from '../../shared/errors.js';

export type TipoMovimientoCaja = 'venta' | 'cobro' | 'ingreso' | 'egreso' | 'devolucion' | 'anulacion';

export async function listarCajas(sucursalId: number): Promise<CajaDto[]> {
  const filas = await db('cajas as c')
    .leftJoin('turnos_caja as t', function () {
      this.on('t.caja_id', 'c.id').andOnVal('t.estado', 'abierto');
    })
    .leftJoin('usuarios as u', 'u.id', 't.usuario_apertura_id')
    .where('c.sucursal_id', sucursalId)
    .orderBy('c.nombre')
    .select('c.id', 'c.nombre', 'c.sucursal_id', 'c.activo', 't.id as turno_id', 't.abierto_en', 'u.nombre as usuario');
  return filas.map((f: Record<string, unknown>) => ({
    id: Number(f.id),
    nombre: String(f.nombre),
    sucursalId: Number(f.sucursal_id),
    activo: Boolean(f.activo),
    turnoAbierto: f.turno_id ? { id: Number(f.turno_id), abiertoEn: new Date(f.abierto_en as string).toISOString(), usuario: String(f.usuario) } : null,
  }));
}

/** Bloquea el turno y verifica que esté abierto. Debe usarse dentro de la transacción del movimiento. */
export async function bloquearTurnoAbierto(trx: Trx, turnoId: number): Promise<{ id: number; caja_id: number; sucursal_id: number }> {
  const t = await trx('turnos_caja as t').join('cajas as c', 'c.id', 't.caja_id').where('t.id', turnoId).forUpdate().first('t.id', 't.estado', 't.caja_id', 'c.sucursal_id');
  if (!t) throw errores.noEncontrado('Turno de caja');
  if (t.estado !== 'abierto') throw new ErrorApp(409, 'TURNO_NO_ABIERTO', 'El turno de caja está cerrado');
  return { id: Number(t.id), caja_id: Number(t.caja_id), sucursal_id: Number(t.sucursal_id) };
}

/** Efectivo disponible en el turno para una moneda: inicial + movimientos en medios de tipo efectivo. */
export async function efectivoDisponible(conn: Knex, turnoId: number, moneda: Moneda): Promise<Decimal> {
  const saldo = await conn('turno_saldos').where({ turno_id: turnoId, moneda }).first('monto_inicial');
  const [{ suma }] = (await conn('movimientos_caja as m')
    .join('metodos_pago as p', 'p.id', 'm.metodo_pago_id')
    .where({ 'm.turno_id': turnoId, 'm.moneda': moneda, 'p.tipo': 'efectivo' })
    .sum({ suma: 'm.monto' })) as [{ suma: string | null }];
  return dec(saldo?.monto_inicial).plus(dec(suma));
}

export interface MovimientoCaja {
  turnoId: number;
  tipo: TipoMovimientoCaja;
  metodoPagoId: number;
  moneda: Moneda;
  /** Con signo: positivo entra, negativo sale. */
  monto: Decimal.Value;
  concepto: string;
  referencia?: string | null;
  origenTipo: string;
  origenId?: number | null;
  idempotencyKey?: string;
  usuarioId: number;
}

/**
 * Registra un movimiento en un turno abierto (dentro de la transacción del llamador).
 * Una salida de efectivo no puede superar el efectivo disponible de esa moneda.
 */
export async function registrarMovimiento(trx: Trx, m: MovimientoCaja): Promise<number> {
  await bloquearTurnoAbierto(trx, m.turnoId);
  const metodo = await trx('metodos_pago').where('id', m.metodoPagoId).first('tipo', 'activo', 'requiere_referencia', 'nombre');
  if (!metodo || !metodo.activo) throw errores.validacion({ metodoPagoId: 'Medio de pago inválido' });
  const monto = dec(m.monto);
  if (monto.isZero()) throw errores.validacion({ monto: 'El monto no puede ser 0' });

  if (metodo.tipo === 'efectivo' && monto.isNegative()) {
    const disponible = await efectivoDisponible(trx, m.turnoId, m.moneda);
    if (disponible.plus(monto).isNegative()) {
      throw new ErrorApp(409, 'EFECTIVO_INSUFICIENTE', `No hay suficiente efectivo en caja: disponible ${m.moneda} ${aImporte(disponible)}`, undefined, { disponible: aImporte(disponible) });
    }
  }
  try {
    const [id] = await trx('movimientos_caja').insert({
      turno_id: m.turnoId,
      tipo: m.tipo,
      metodo_pago_id: m.metodoPagoId,
      moneda: m.moneda,
      monto: aImporte(monto),
      concepto: m.concepto.slice(0, 255),
      referencia: m.referencia ?? null,
      origen_tipo: m.origenTipo,
      origen_id: m.origenId ?? null,
      idempotency_key: m.idempotencyKey ?? null,
      usuario_id: m.usuarioId,
    });
    return Number(id);
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      throw new ErrorApp(409, 'MOVIMIENTO_DUPLICADO', 'Ese movimiento ya fue registrado en caja');
    }
    throw err;
  }
}

export async function abrirTurno(datos: { cajaId: number; saldosIniciales: Array<{ moneda: Moneda; monto: string }> }, ctx: { sucursalId: number; usuarioId: number; idempotencyKey: string }): Promise<{ turnoId: number; repetido: boolean }> {
  const previo = await db('turnos_caja').where('idempotency_key', ctx.idempotencyKey).first('id');
  if (previo) return { turnoId: Number(previo.id), repetido: true };

  const caja = await db('cajas').where('id', datos.cajaId).first('id', 'sucursal_id', 'activo', 'nombre');
  if (!caja || Number(caja.sucursal_id) !== ctx.sucursalId) throw errores.validacion({ cajaId: 'Esa caja no es de la sucursal activa' });
  if (!caja.activo) throw errores.validacion({ cajaId: 'La caja está desactivada' });

  try {
    const turnoId = await db.transaction(async (trx) => {
      const [id] = await trx('turnos_caja').insert({ caja_id: datos.cajaId, usuario_apertura_id: ctx.usuarioId, idempotency_key: ctx.idempotencyKey });
      const monedas: Moneda[] = ['PEN', 'USD'];
      await trx('turno_saldos').insert(
        monedas.map((moneda) => ({ turno_id: id, moneda, monto_inicial: aImporte(datos.saldosIniciales.find((s) => s.moneda === moneda)?.monto ?? 0) })),
      );
      return Number(id);
    });
    return { turnoId, repetido: false };
  } catch (err) {
    if ((err as { code?: string; sqlMessage?: string }).code === 'ER_DUP_ENTRY') {
      const mismo = await db('turnos_caja').where('idempotency_key', ctx.idempotencyKey).first('id');
      if (mismo) return { turnoId: Number(mismo.id), repetido: true };
      throw new ErrorApp(409, 'TURNO_YA_ABIERTO', `La caja ${caja.nombre} ya tiene un turno abierto`);
    }
    throw err;
  }
}

export async function resumen(turnoId: number, conn: Knex = db): Promise<ResumenTurnoDto> {
  const t = await conn('turnos_caja as t')
    .join('cajas as c', 'c.id', 't.caja_id')
    .join('usuarios as ua', 'ua.id', 't.usuario_apertura_id')
    .leftJoin('usuarios as uc', 'uc.id', 't.usuario_cierre_id')
    .where('t.id', turnoId)
    .first('t.*', 'c.nombre as caja_nombre', 'c.sucursal_id', 'ua.nombre as abierto_por', 'uc.nombre as cerrado_por');
  if (!t) throw errores.noEncontrado('Turno de caja');

  const saldos = await conn('turno_saldos').where('turno_id', turnoId).orderBy('moneda');
  const movimientos = await conn('movimientos_caja as m')
    .join('metodos_pago as p', 'p.id', 'm.metodo_pago_id')
    .join('usuarios as u', 'u.id', 'm.usuario_id')
    .where('m.turno_id', turnoId)
    .orderBy('m.id')
    .select('m.*', 'p.nombre as metodo', 'p.tipo as metodo_tipo', 'u.nombre as usuario');

  const efectivo = saldos.map((s: Record<string, unknown>) => {
    const deMoneda = movimientos.filter((m: Record<string, unknown>) => m.moneda === s.moneda && m.metodo_tipo === 'efectivo');
    const entradas = deMoneda.filter((m: { monto: string }) => dec(m.monto).gt(0)).reduce((a: Decimal, m: { monto: string }) => a.plus(m.monto), dec(0));
    const salidas = deMoneda.filter((m: { monto: string }) => dec(m.monto).isNegative()).reduce((a: Decimal, m: { monto: string }) => a.plus(dec(m.monto).abs()), dec(0));
    const esperado = dec(s.monto_inicial as string).plus(entradas).minus(salidas);
    return {
      moneda: s.moneda as Moneda,
      inicial: aImporte(s.monto_inicial as string),
      entradas: aImporte(entradas),
      salidas: aImporte(salidas),
      esperado: s.esperado == null ? aImporte(esperado) : String(s.esperado),
      contado: (s.contado as string | null) ?? null,
      diferencia: (s.diferencia as string | null) ?? null,
    };
  });

  const porMetodo = new Map<string, { metodo: string; tipo: string; moneda: Moneda; total: Decimal }>();
  for (const m of movimientos as Array<Record<string, string>>) {
    const clave = `${m.metodo}|${m.moneda}`;
    const actual = porMetodo.get(clave) ?? { metodo: m.metodo!, tipo: m.metodo_tipo!, moneda: m.moneda as Moneda, total: dec(0) };
    actual.total = actual.total.plus(m.monto!);
    porMetodo.set(clave, actual);
  }

  return {
    turno: {
      id: Number(t.id),
      caja: { id: Number(t.caja_id), nombre: t.caja_nombre },
      sucursalId: Number(t.sucursal_id),
      estado: t.estado,
      abiertoEn: new Date(t.abierto_en).toISOString(),
      abiertoPor: t.abierto_por,
      cerradoEn: t.cerrado_en ? new Date(t.cerrado_en).toISOString() : null,
      cerradoPor: t.cerrado_por ?? null,
      nota: t.nota_cierre ?? null,
    },
    efectivo,
    porMetodo: [...porMetodo.values()].map((p) => ({ ...p, tipo: p.tipo as ResumenTurnoDto['porMetodo'][number]['tipo'], total: aImporte(p.total) })),
    movimientos: (movimientos as Array<Record<string, unknown>>).map((m) => ({
      id: Number(m.id),
      fecha: new Date(m.fecha as string).toISOString(),
      tipo: String(m.tipo),
      metodo: String(m.metodo),
      moneda: m.moneda as Moneda,
      monto: String(m.monto),
      concepto: String(m.concepto),
      referencia: (m.referencia as string | null) ?? null,
      usuario: String(m.usuario),
    })),
  };
}

/** Cierra el turno con el arqueo de efectivo por moneda. Después ya no admite movimientos. */
export async function cerrarTurno(turnoId: number, datos: { contado: Array<{ moneda: Moneda; monto: string }>; nota?: string }, ctx: { usuarioId: number }): Promise<ResumenTurnoDto> {
  return db.transaction(async (trx) => {
    await bloquearTurnoAbierto(trx, turnoId);
    const actual = await resumen(turnoId, trx);
    const faltan = actual.efectivo.filter((e) => dec(e.esperado).gt(0) && !datos.contado.some((c) => c.moneda === e.moneda));
    if (faltan.length) throw errores.validacion({ contado: `Indica el efectivo contado en ${faltan.map((f) => f.moneda).join(' y ')}` });

    for (const e of actual.efectivo) {
      const contado = dec(datos.contado.find((c) => c.moneda === e.moneda)?.monto ?? 0);
      await trx('turno_saldos')
        .where({ turno_id: turnoId, moneda: e.moneda })
        .update({ esperado: e.esperado, contado: aImporte(contado), diferencia: aImporte(contado.minus(e.esperado)) });
    }
    await trx('turnos_caja').where('id', turnoId).update({
      estado: 'cerrado',
      usuario_cierre_id: ctx.usuarioId,
      cerrado_en: trx.raw('CURRENT_TIMESTAMP(3)'),
      nota_cierre: datos.nota ?? null,
    });
    return resumen(turnoId, trx);
  });
}
