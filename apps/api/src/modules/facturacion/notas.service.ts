import { calcularVenta, ErrorCalculo, MOTIVOS_NC, MOTIVOS_ND, type ItemCalculo, type NotaCreditoInput, type NotaDebitoInput, type SaldoNotaCreditoDto } from '@sv/shared';
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { db, type Trx } from '../../database/db.js';
import { encolar } from '../../jobs/outbox.js';
import { aCantidad, aImporte, dec } from '../../shared/decimal.js';
import { ErrorApp, errores } from '../../shared/errors.js';
import { fechaLima } from '../../shared/fechas.js';
import { bloquearTurnoAbierto, registrarMovimiento } from '../caja/caja.service.js';
import { mover } from '../inventario/inventario.service.js';

// Notas de crédito y débito sobre facturas y boletas aceptadas por SUNAT. La nota y todos sus efectos
// (stock, caja, cuenta por cobrar) se registran en una transacción; su envío a SUNAT va por el outbox.

/** Las NC rechazadas o que nunca se emitieron no consumen saldo del comprobante afectado. */
const NC_VIGENTE = (q: Knex.QueryBuilder) => q.whereNotIn('nc.estado', ['rechazado', 'error_validacion', 'anulado_interno']);

async function seriesNota(conn: Knex, sucursalId: number, tipo: '07' | '08', letra: string) {
  const filas = await conn('series').where({ sucursal_id: sucursalId, tipo_doc: tipo, aplica_a: letra, propia: true, activo: true }).orderBy('serie').select('id', 'serie', 'predeterminada');
  return filas.map((s: { id: number | string; serie: string; predeterminada: number }) => ({ id: Number(s.id), serie: s.serie, predeterminada: Boolean(s.predeterminada) }));
}

async function cargarAfectado(conn: Knex, id: number, bloquear = false) {
  const q = conn('comprobantes').where('id', id);
  const a = bloquear ? await q.forUpdate().first() : await q.first();
  if (!a) throw errores.noEncontrado('Comprobante');
  if (!['01', '03'].includes(a.tipo_doc)) throw new ErrorApp(409, 'ESTADO_NO_PERMITE', 'Solo se emiten notas sobre facturas y boletas');
  if (!['aceptado', 'observado'].includes(a.estado)) throw new ErrorApp(409, 'ESTADO_NO_PERMITE', 'El comprobante debe estar aceptado por SUNAT para emitir una nota');
  return a;
}

export async function saldo(afectadoId: number, sucursalId: number, conn: Knex = db): Promise<SaldoNotaCreditoDto> {
  const a = await cargarAfectado(conn, afectadoId);
  const lineas = await conn('comprobante_items as i').leftJoin('productos as p', 'p.id', 'i.producto_id').where('i.comprobante_id', afectadoId).orderBy('i.id').select('i.*', 'p.inventariable');
  const acreditadas = await conn('comprobante_items as ni')
    .join('comprobantes as nc', 'nc.id', 'ni.comprobante_id')
    .where('nc.tipo_doc', '07')
    .whereIn('ni.comprobante_item_origen_id', lineas.map((l: { id: number }) => l.id))
    .modify(NC_VIGENTE)
    .groupBy('ni.comprobante_item_origen_id')
    .select('ni.comprobante_item_origen_id as origen')
    .sum({ cantidad: 'ni.cantidad' });
  const [{ total: acreditado }] = (await conn('notas as n').join('comprobantes as nc', 'nc.id', 'n.comprobante_id').where({ 'n.comprobante_afectado_id': afectadoId, 'n.tipo': '07' }).modify(NC_VIGENTE).sum({ total: 'nc.total' })) as [{ total: string | null }];
  const cxc = a.venta_id ? await conn('cuentas_por_cobrar').where('venta_id', a.venta_id).first('saldo') : null;
  const letra = a.tipo_doc === '01' ? 'F' : 'B';

  return {
    comprobanteId: Number(a.id),
    numero: a.numero_completo,
    moneda: a.moneda,
    total: a.total,
    acreditado: aImporte(dec(acreditado)),
    saldo: aImporte(dec(a.total).minus(dec(acreditado))),
    formaPago: a.forma_pago,
    saldoCxc: cxc ? cxc.saldo : null,
    lineas: lineas.map((l: Record<string, unknown>) => {
      const ya = acreditadas.find((x: { origen: number | string }) => Number(x.origen) === Number(l.id));
      const usada = dec((ya as { cantidad?: string } | undefined)?.cantidad);
      return {
        id: Number(l.id),
        descripcion: String(l.descripcion),
        unidad: String(l.unidad),
        cantidad: String(l.cantidad),
        acreditada: aCantidad(usada),
        disponible: aCantidad(dec(l.cantidad as string).minus(usada)),
        precioUnitario: String(l.precio_unitario),
        inventariable: Boolean(l.inventariable),
      };
    }),
    seriesNc: await seriesNota(conn, sucursalId, '07', letra),
    seriesNd: await seriesNota(conn, sucursalId, '08', letra),
  };
}

function elegirSerie(series: Array<{ id: number; predeterminada: boolean }>, pedida: number | undefined, nombre: string): number {
  if (pedida) {
    if (!series.some((s) => s.id === pedida)) throw errores.validacion({ serieId: `Serie inválida para ${nombre} de este comprobante` });
    return pedida;
  }
  const s = series.find((x) => x.predeterminada) ?? series[0];
  if (!s) throw errores.validacion({ serieId: `No hay series propias de ${nombre} para este tipo de comprobante en la sucursal (Configuración → Series)` });
  return s.id;
}

async function turnoDe(trx: Trx, cajaId: number, sucursalId: number): Promise<number> {
  const t = await trx('turnos_caja as t').join('cajas as c', 'c.id', 't.caja_id').where({ 't.caja_id': cajaId, 't.estado': 'abierto', 'c.sucursal_id': sucursalId }).first('t.id');
  if (!t) throw new ErrorApp(409, 'TURNO_NO_ABIERTO', 'Abre la caja de esta sucursal para mover dinero');
  await bloquearTurnoAbierto(trx, Number(t.id));
  return Number(t.id);
}

/** Recalcula saldo y estado de una cuenta por cobrar a partir de sus cuotas. */
async function recalcularCxc(trx: Trx, cxcId: number): Promise<void> {
  const [{ saldo: s, total: t }] = (await trx('cuotas').where('cxc_id', cxcId).whereNot('estado', 'anulada').sum({ saldo: 'saldo', total: 'monto' })) as [{ saldo: string | null; total: string | null }];
  const saldoD = dec(s);
  const estado = saldoD.isZero() ? 'pagada' : saldoD.eq(dec(t)) ? 'pendiente' : 'parcial';
  await trx('cuentas_por_cobrar').where('id', cxcId).update({ saldo: aImporte(saldoD), total: aImporte(dec(t)), estado });
}

interface Contexto {
  sucursalId: number;
  operadorId: number;
  idempotencyKey: string;
}

async function crearComprobanteNota(
  trx: Trx,
  a: Record<string, unknown>,
  tipo: '07' | '08',
  serieId: number,
  calculo: ReturnType<typeof calcularVenta>,
  lineas: Array<{ origenId: number | null; productoId: number | null; codigo: string | null; descripcion: string; unidad: string }>,
  ctx: Contexto,
): Promise<number> {
  const serie = await trx('series').where('id', serieId).first('serie');
  const [id] = await trx('comprobantes').insert({
    sucursal_id: ctx.sucursalId,
    venta_id: a.venta_id ?? null,
    tipo_doc: tipo,
    serie_id: serieId,
    serie: serie.serie,
    fecha_emision: fechaLima(),
    moneda: a.moneda,
    tipo_cambio: a.tipo_cambio,
    forma_pago: 'contado',
    cliente_tipo_doc: a.cliente_tipo_doc,
    cliente_num_doc: a.cliente_num_doc,
    cliente_razon_social: a.cliente_razon_social,
    cliente_direccion: a.cliente_direccion,
    cliente_email: a.cliente_email,
    op_gravada: calculo.opGravada,
    op_exonerada: calculo.opExonerada,
    op_inafecta: calculo.opInafecta,
    igv: calculo.igv,
    total: calculo.total,
    modo_envio: 'individual',
    estado: 'pendiente',
    idempotency_key: randomUUID(),
    emitido_por: ctx.operadorId,
  });
  await trx('comprobante_items').insert(
    calculo.lineas.map((l, i) => ({
      comprobante_id: id,
      comprobante_item_origen_id: lineas[i]!.origenId,
      producto_id: lineas[i]!.productoId,
      codigo: lineas[i]!.codigo,
      descripcion: lineas[i]!.descripcion,
      unidad: lineas[i]!.unidad,
      tip_afe_igv: l.tipAfeIgv,
      cantidad: l.cantidad,
      precio_unitario: l.precioUnitario,
      valor_venta: l.valorVenta,
      igv: l.igv,
      total: l.total,
    })),
  );
  await encolar(trx, 'emitir_comprobante', 'comprobante', Number(id), { prioridad: 1 });
  return Number(id);
}

const calcular = (items: ItemCalculo[], tasa: string) => {
  try {
    return calcularVenta(items, { tasaIgv: tasa });
  } catch (err) {
    if (err instanceof ErrorCalculo) throw errores.validacion({ items: err.message });
    throw err;
  }
};

export async function crearNotaCredito(datos: NotaCreditoInput, ctx: Contexto): Promise<number> {
  const previa = await db('notas').where('idempotency_key', ctx.idempotencyKey).first('comprobante_id');
  if (previa) return Number(previa.comprobante_id);
  const empresa = await db('empresa').first('tasa_igv');

  try {
    return await db.transaction(async (trx) => {
      const turnoId = datos.reintegro.tipo === 'caja' ? await turnoDe(trx, datos.reintegro.cajaId, ctx.sucursalId) : null;
      const a = await cargarAfectado(trx, datos.comprobanteAfectadoId, true); // serializa NC simultáneas
      const s = await saldo(datos.comprobanteAfectadoId, ctx.sucursalId, trx);
      const serieId = elegirSerie(s.seriesNc, datos.serieId, 'notas de crédito');

      // Líneas a acreditar.
      let seleccion: Array<{ linea: SaldoNotaCreditoDto['lineas'][number]; cantidad: string }>;
      if (datos.codMotivo === '07') {
        seleccion = datos.items!.map((it) => {
          const linea = s.lineas.find((l) => l.id === it.comprobanteItemId);
          if (!linea) throw errores.validacion({ items: 'La línea no pertenece al comprobante' });
          if (dec(it.cantidad).gt(linea.disponible)) throw errores.validacion({ items: `${linea.descripcion}: solo quedan ${dec(linea.disponible)} por devolver` });
          return { linea, cantidad: it.cantidad };
        });
      } else {
        if (dec(s.acreditado).gt(0)) {
          throw new ErrorApp(409, 'SALDO_NC_EXCEDIDO', 'El comprobante ya tiene notas de crédito: usa la devolución por ítem para el resto');
        }
        seleccion = s.lineas.map((linea) => ({ linea, cantidad: linea.cantidad }));
      }
      const origen = await trx('comprobante_items').whereIn('id', seleccion.map((x) => x.linea.id)).select('id', 'producto_id', 'codigo', 'tip_afe_igv');
      const unidades = await trx('comprobante_items as i').leftJoin('productos as p', 'p.id', 'i.producto_id').leftJoin('unidades as u', 'u.id', 'p.unidad_id').whereIn('i.id', seleccion.map((x) => x.linea.id)).select('i.id', 'u.fraccionable');
      for (const x of seleccion) {
        const fraccionable = unidades.find((u: { id: number | string }) => Number(u.id) === x.linea.id)?.fraccionable;
        if (fraccionable === 0 && !dec(x.cantidad).isInteger()) throw errores.validacion({ items: `${x.linea.descripcion} se devuelve por unidades enteras` });
      }
      const info = (id: number) => origen.find((o: { id: number | string }) => Number(o.id) === id)!;

      const calculo = calcular(
        seleccion.map((x) => ({ productoId: x.linea.id, nombre: x.linea.descripcion, precioUnitario: x.linea.precioUnitario, cantidad: x.cantidad, tipAfeIgv: info(x.linea.id).tip_afe_igv })),
        empresa?.tasa_igv ?? '18.00',
      );
      if (dec(calculo.total).gt(s.saldo)) throw new ErrorApp(409, 'SALDO_NC_EXCEDIDO', `La nota (${calculo.total}) supera el saldo acreditable (${s.saldo})`);

      const lineasNota = calculo.lineas.map((l) => {
        const x = seleccion.find((y) => y.linea.id === l.productoId)!;
        const o = info(x.linea.id);
        return { origenId: x.linea.id, productoId: o.producto_id == null ? null : Number(o.producto_id), codigo: o.codigo, descripcion: x.linea.descripcion, unidad: x.linea.unidad };
      });
      const comprobanteId = await crearComprobanteNota(trx, a, '07', serieId, calculo, lineasNota, ctx);
      await trx('notas').insert({
        comprobante_id: comprobanteId,
        comprobante_afectado_id: a.id,
        tipo: '07',
        cod_motivo: datos.codMotivo,
        des_motivo: datos.desMotivo || MOTIVOS_NC[datos.codMotivo],
        devuelve_stock: datos.devuelveStock,
        reintegro: datos.reintegro.tipo,
        idempotency_key: ctx.idempotencyKey,
        usuario_id: ctx.operadorId,
      });

      if (datos.devuelveStock) {
        await mover(trx, {
          sucursalId: ctx.sucursalId,
          usuarioId: ctx.operadorId,
          origenTipo: 'nota',
          origenId: comprobanteId,
          nota: `NC sobre ${a.numero_completo}`,
          lineas: seleccion
            .filter((x) => info(x.linea.id).producto_id != null)
            .map((x) => ({ productoId: Number(info(x.linea.id).producto_id), cantidad: x.cantidad, tipo: 'devolucion_nc' as const })),
        });
      }

      if (datos.reintegro.tipo === 'caja') {
        await registrarMovimiento(trx, {
          turnoId: turnoId!,
          tipo: 'devolucion',
          metodoPagoId: datos.reintegro.metodoPagoId,
          moneda: a.moneda,
          monto: dec(calculo.total).negated(),
          concepto: `Devolución por NC sobre ${a.numero_completo}`,
          origenTipo: 'nota',
          origenId: comprobanteId,
          usuarioId: ctx.operadorId,
        });
      } else if (datos.reintegro.tipo === 'cxc') {
        const cxc = a.venta_id ? await trx('cuentas_por_cobrar').where('venta_id', a.venta_id).forUpdate().first() : null;
        if (!cxc || ['anulada', 'pagada'].includes(cxc.estado)) throw errores.validacion({ reintegro: 'La venta no tiene deuda pendiente: devuelve el importe desde caja' });
        if (dec(cxc.saldo).lt(calculo.total)) throw errores.validacion({ reintegro: `La deuda pendiente (${cxc.saldo}) es menor que la nota: devuelve el importe desde caja` });
        // La rebaja se aplica desde la última cuota hacia atrás.
        let restante = dec(calculo.total);
        const cuotas = await trx('cuotas').where('cxc_id', cxc.id).whereIn('estado', ['pendiente', 'parcial']).orderBy('numero', 'desc').forUpdate().select('id', 'monto', 'saldo');
        for (const q of cuotas) {
          if (restante.isZero()) break;
          const rebaja = dec(q.saldo).lt(restante) ? dec(q.saldo) : restante;
          const nuevoMonto = dec(q.monto).minus(rebaja);
          const nuevoSaldo = dec(q.saldo).minus(rebaja);
          await trx('cuotas').where('id', q.id).update(nuevoMonto.isZero() ? { monto: aImporte(q.monto), saldo: '0.00', estado: 'anulada' } : { monto: aImporte(nuevoMonto), saldo: aImporte(nuevoSaldo), estado: nuevoSaldo.isZero() ? 'pagada' : nuevoSaldo.eq(nuevoMonto) ? 'pendiente' : 'parcial' });
          restante = restante.minus(rebaja);
        }
        await recalcularCxc(trx, Number(cxc.id));
      }
      return comprobanteId;
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      const otra = await db('notas').where('idempotency_key', ctx.idempotencyKey).first('comprobante_id');
      if (otra) return Number(otra.comprobante_id);
    }
    throw err;
  }
}

export async function crearNotaDebito(datos: NotaDebitoInput, ctx: Contexto): Promise<number> {
  const previa = await db('notas').where('idempotency_key', ctx.idempotencyKey).first('comprobante_id');
  if (previa) return Number(previa.comprobante_id);
  const empresa = await db('empresa').first('tasa_igv');
  if (datos.cobro.tipo === 'cxc' && datos.cobro.fechaVencimiento <= fechaLima()) throw errores.validacion({ cobro: 'La fecha de vencimiento debe ser futura' });

  try {
    return await db.transaction(async (trx) => {
      const turnoId = datos.cobro.tipo === 'caja' ? await turnoDe(trx, datos.cobro.cajaId, ctx.sucursalId) : null;
      const a = await cargarAfectado(trx, datos.comprobanteAfectadoId, true);
      const letra = a.tipo_doc === '01' ? 'F' : 'B';
      const serieId = elegirSerie(await seriesNota(trx, ctx.sucursalId, '08', letra), datos.serieId, 'notas de débito');
      const calculo = calcular(
        datos.items.map((it, i) => ({ productoId: i + 1, nombre: it.descripcion, precioUnitario: it.precioUnitario, cantidad: it.cantidad, tipAfeIgv: it.tipAfeIgv })),
        empresa?.tasa_igv ?? '18.00',
      );
      const lineas = calculo.lineas.map((l) => ({ origenId: null, productoId: null, codigo: null, descripcion: datos.items[l.productoId - 1]!.descripcion, unidad: 'ZZ' }));
      const comprobanteId = await crearComprobanteNota(trx, a, '08', serieId, calculo, lineas, ctx);
      await trx('notas').insert({
        comprobante_id: comprobanteId,
        comprobante_afectado_id: a.id,
        tipo: '08',
        cod_motivo: datos.codMotivo,
        des_motivo: datos.desMotivo || MOTIVOS_ND[datos.codMotivo],
        reintegro: datos.cobro.tipo,
        idempotency_key: ctx.idempotencyKey,
        usuario_id: ctx.operadorId,
      });

      if (datos.cobro.tipo === 'caja') {
        await registrarMovimiento(trx, {
          turnoId: turnoId!,
          tipo: 'cobro',
          metodoPagoId: datos.cobro.metodoPagoId,
          moneda: a.moneda,
          monto: calculo.total,
          concepto: `Cobro de ND sobre ${a.numero_completo}`,
          origenTipo: 'nota',
          origenId: comprobanteId,
          usuarioId: ctx.operadorId,
        });
      } else if (datos.cobro.tipo === 'cxc') {
        const cxc = a.venta_id ? await trx('cuentas_por_cobrar').where('venta_id', a.venta_id).forUpdate().first() : null;
        if (!cxc || cxc.estado === 'anulada') throw errores.validacion({ cobro: 'La venta no tiene cuenta por cobrar: cobra la nota en caja' });
        const [{ ultima }] = (await trx('cuotas').where('cxc_id', cxc.id).max({ ultima: 'numero' })) as [{ ultima: number }];
        await trx('cuotas').insert({ cxc_id: cxc.id, numero: Number(ultima) + 1, monto: calculo.total, saldo: calculo.total, fecha_vencimiento: datos.cobro.fechaVencimiento });
        if (datos.cobro.fechaVencimiento > cxc.vence_ultima) await trx('cuentas_por_cobrar').where('id', cxc.id).update({ vence_ultima: datos.cobro.fechaVencimiento });
        await recalcularCxc(trx, Number(cxc.id));
      }
      return comprobanteId;
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      const otra = await db('notas').where('idempotency_key', ctx.idempotencyKey).first('comprobante_id');
      if (otra) return Number(otra.comprobante_id);
    }
    throw err;
  }
}
