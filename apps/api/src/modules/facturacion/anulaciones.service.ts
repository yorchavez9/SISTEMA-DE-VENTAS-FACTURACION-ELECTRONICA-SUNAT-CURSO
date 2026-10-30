import type { BajaDto, Moneda, ValidacionAnulacionDto } from '@sv/shared';
import { randomUUID } from 'node:crypto';
import { db, type Trx } from '../../database/db.js';
import { llamarJson } from '../../integrations/apiPro/llamada.js';
import { obtenerCliente } from '../../integrations/apiPro/proveedor.js';
import { encolar, type Resultado, type Trabajo } from '../../jobs/outbox.js';
import { aImporte, dec } from '../../shared/decimal.js';
import { ErrorApp, errores } from '../../shared/errors.js';
import { fechaLima } from '../../shared/fechas.js';
import { bloquearTurnoAbierto, registrarMovimiento } from '../caja/caja.service.js';
import { mover } from '../inventario/inventario.service.js';
import { ESPERAS_CONSULTA, ESPERAS_ENVIO, esperaReintento } from './contrato.js';
import { pausaActiva, pausar } from './pausa.js';

// Anulación de comprobantes aceptados por SUNAT (plan §0.7):
//  - facturas, NC y ND → comunicación de baja (RA), una por fecha de emisión;
//  - boletas → resumen de anulación (RC con "anular"), una por fecha de emisión.
// Dentro de los 7 días de emitidos. Al solicitar, quedan "anulacion_en_proceso"; cuando SUNAT
// confirma se aplican los efectos (stock, deuda, reembolso pendiente); si rechaza, vuelven a "aceptado".

const PLAZO_DIAS = 7;
const sumarDias = (f: string, d: number) => {
  const x = new Date(`${f}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
};

interface FilaComprobante {
  id: number;
  tipo_doc: string;
  serie: string;
  correlativo: number;
  numero_completo: string;
  estado: string;
  fecha_emision: string;
  api_id: number | null;
  simulado: number | boolean;
  venta_id: number | null;
  sucursal_id: number;
}

export async function validar(ids: number[], sucursalIds: number[]): Promise<ValidacionAnulacionDto & { comprobantes: FilaComprobante[] }> {
  const filas = (await db('comprobantes').whereIn('id', ids)) as FilaComprobante[];
  const bloqueos: string[] = [];
  const advertencias: string[] = [];
  if (filas.length !== new Set(ids).size) bloqueos.push('Algún comprobante no existe');
  if (filas.some((c) => !sucursalIds.includes(Number(c.sucursal_id)))) bloqueos.push('Algún comprobante es de otra sucursal');

  const mecanismos = new Set(filas.map((c) => (c.tipo_doc === '03' ? 'RC' : 'RA')));
  if (mecanismos.size > 1) bloqueos.push('Las boletas se anulan por resumen y las facturas o notas por comunicación de baja: anúlalas por separado');
  const fechas = new Set(filas.map((c) => c.fecha_emision));
  if (fechas.size > 1) bloqueos.push('Anula juntos solo comprobantes de la misma fecha de emisión');

  const hoy = fechaLima();
  for (const c of filas) {
    if (!['aceptado', 'observado'].includes(c.estado)) bloqueos.push(`${c.numero_completo ?? c.serie}: está "${c.estado}"; solo se anulan comprobantes aceptados`);
    if (c.fecha_emision < sumarDias(hoy, -PLAZO_DIAS)) bloqueos.push(`${c.numero_completo}: pasó el plazo de ${PLAZO_DIAS} días (emitido el ${c.fecha_emision}). Usa una nota de crédito.`);
  }
  // Un comprobante con notas de crédito vigentes no se anula (primero se anulan sus notas).
  const conNotas = await db('notas as n')
    .join('comprobantes as nc', 'nc.id', 'n.comprobante_id')
    .whereIn('n.comprobante_afectado_id', ids)
    .whereNotIn('nc.estado', ['rechazado', 'error_validacion', 'anulado_interno', 'anulado'])
    .pluck('n.comprobante_afectado_id');
  for (const id of new Set(conNotas)) bloqueos.push(`${filas.find((c) => Number(c.id) === Number(id))?.numero_completo}: tiene notas vigentes. Anúlalas primero o emite una nota de crédito.`);

  // Ventas al crédito con cobros: primero se anulan los cobros.
  const ventas = filas.filter((c) => c.venta_id && ['01', '03'].includes(c.tipo_doc)).map((c) => Number(c.venta_id));
  if (ventas.length) {
    const conCobros = await db('cuentas_por_cobrar').whereIn('venta_id', ventas).whereRaw('saldo < total').pluck('venta_id');
    for (const v of conCobros) bloqueos.push(`La venta ${v} tiene cobros registrados: anula primero los cobros`);
  }
  if (filas.some((c) => ['07', '08'].includes(c.tipo_doc))) {
    advertencias.push('Anular una nota no revierte su stock ni su dinero: ajústalos manualmente si corresponde.');
  }
  if (filas.some((c) => c.tipo_doc === '01' || c.tipo_doc === '03')) {
    advertencias.push('Cuando SUNAT confirme: el stock vuelve al inventario, la deuda se anula y el dinero cobrado queda como reembolso pendiente.');
  }
  const fecha = [...fechas][0] ?? null;
  return {
    mecanismo: mecanismos.size === 1 ? ([...mecanismos][0] as 'RA' | 'RC') : null,
    permitido: bloqueos.length === 0 && filas.length > 0,
    bloqueos,
    advertencias,
    plazoHasta: fecha ? sumarDias(fecha, PLAZO_DIAS) : null,
    comprobantes: filas,
  };
}

/** Efectos de una anulación confirmada sobre la venta de un comprobante (una sola vez). */
async function aplicarEfectos(trx: Trx, comprobanteId: number): Promise<void> {
  const c = await trx('comprobantes').where('id', comprobanteId).first('tipo_doc', 'venta_id');
  if (!c?.venta_id || !['01', '03'].includes(c.tipo_doc)) return;
  const v = await trx('ventas').where('id', c.venta_id).forUpdate().first();
  if (!v || v.estado === 'anulada') return;

  const items = await trx('venta_items').where('venta_id', v.id).select('producto_id', 'cantidad');
  const porProducto = new Map<number, ReturnType<typeof dec>>();
  for (const i of items as Array<{ producto_id: number | string; cantidad: string }>) {
    porProducto.set(Number(i.producto_id), (porProducto.get(Number(i.producto_id)) ?? dec(0)).plus(i.cantidad));
  }
  await mover(trx, {
    sucursalId: Number(v.sucursal_id),
    usuarioId: null,
    origenTipo: 'venta',
    origenId: Number(v.id),
    nota: 'Anulación confirmada por SUNAT',
    lineas: [...porProducto].map(([productoId, cantidad]) => ({ productoId, cantidad, tipo: 'anulacion' as const })),
  });
  const cxc = await trx('cuentas_por_cobrar').where('venta_id', v.id).first('id');
  if (cxc) {
    await trx('cuentas_por_cobrar').where('id', cxc.id).update({ estado: 'anulada', saldo: 0 });
    await trx('cuotas').where('cxc_id', cxc.id).update({ estado: 'anulada', saldo: 0 });
  }
  const [{ pagado }] = (await trx('pagos').where('venta_id', v.id).sum({ pagado: 'monto_en_moneda_venta' })) as [{ pagado: string | null }];
  await trx('ventas').where('id', v.id).update({ estado: 'anulada', reembolso_pendiente: aImporte(dec(pagado)) });
}

async function marcarResultado(trx: Trx, ids: number[], aceptada: boolean, detalle: string | null): Promise<void> {
  for (const id of ids) {
    await trx('comprobantes').where('id', id).update({ estado: aceptada ? 'anulado' : 'aceptado', sunat_descripcion: detalle });
    if (aceptada) await aplicarEfectos(trx, id);
    else {
      const c = await trx('comprobantes').where('id', id).first('venta_id', 'tipo_doc');
      if (c?.venta_id && ['01', '03'].includes(c.tipo_doc)) await trx('ventas').where({ id: c.venta_id, estado: 'anulacion_en_proceso' }).update({ estado: 'confirmada' });
    }
  }
}

export async function solicitar(ids: number[], motivo: string, ctx: { sucursalIds: number[]; usuarioId: number; idempotencyKey: string }): Promise<BajaDto> {
  const previa = await db('bajas').where('idempotency_key', ctx.idempotencyKey).first('id');
  if (previa) return obtenerBaja(Number(previa.id));
  const previaRc = await db('resumenes').where('idempotency_key', ctx.idempotencyKey).first('id');
  if (previaRc) return obtenerResumenAnulacion(Number(previaRc.id));

  const v = await validar(ids, ctx.sucursalIds);
  if (!v.permitido) throw new ErrorApp(409, 'ANULACION_NO_PERMITIDA', v.bloqueos[0] ?? 'No se puede anular', undefined, v);
  const fecha = v.comprobantes[0]!.fecha_emision;
  const empresa = await db('empresa').first('modo_emision');
  const simulado = (empresa?.modo_emision ?? 'simulacion') === 'simulacion' || v.comprobantes.some((c) => c.simulado);
  if (simulado && v.comprobantes.some((c) => !c.simulado)) throw errores.validacion({ comprobanteIds: 'No se pueden anular comprobantes reales en modo simulación' });

  // Paso 1: marcar en proceso (atómico) para que nadie más los anule o les emita notas.
  const marcados = await db.transaction(async (trx) => {
    const n = await trx('comprobantes').whereIn('id', ids).whereIn('estado', ['aceptado', 'observado']).update({ estado: 'anulacion_en_proceso' });
    if (n !== ids.length) throw new ErrorApp(409, 'ESTADO_NO_PERMITE', 'Algún comprobante cambió de estado; vuelve a intentarlo');
    const ventas = v.comprobantes.filter((c) => c.venta_id && ['01', '03'].includes(c.tipo_doc)).map((c) => Number(c.venta_id));
    if (ventas.length) await trx('ventas').whereIn('id', ventas).where('estado', 'confirmada').update({ estado: 'anulacion_en_proceso' });
    return n;
  });
  void marcados;

  if (v.mecanismo === 'RA') {
    const [bajaId] = await db('bajas').insert({ fecha_generacion: fecha, motivo, simulado, idempotency_key: ctx.idempotencyKey, creado_por: ctx.usuarioId });
    await db('baja_documentos').insert(ids.map((id) => ({ baja_id: bajaId, comprobante_id: id, motivo })));
    if (simulado) {
      await db.transaction(async (trx) => {
        await marcarResultado(trx, ids, true, 'Simulación: baja no comunicada a SUNAT');
        await trx('bajas').where('id', bajaId).update({ estado: 'aceptado', identifier: `SIM-RA-${fecha.replaceAll('-', '')}-${bajaId}` });
      });
    } else {
      await encolar(db, 'enviar_anulacion', 'baja', Number(bajaId), { prioridad: 1 });
    }
    return obtenerBaja(Number(bajaId));
  }

  // RC de anulación (boletas)
  let resumenId: number;
  try {
    [resumenId] = (await db('resumenes').insert({ tipo: 'anulacion', fecha_resumen: fecha, simulado, idempotency_key: ctx.idempotencyKey, creado_por: ctx.usuarioId })) as [number];
  } catch (err) {
    await db.transaction((trx) => marcarResultado(trx, ids, false, null));
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') throw new ErrorApp(409, 'RESUMEN_EN_CURSO', `Ya hay un resumen de anulación en curso para el ${fecha}`);
    throw err;
  }
  await db('resumen_documentos').insert(ids.map((id) => ({ resumen_id: resumenId, comprobante_id: id, motivo })));
  if (simulado) {
    await db.transaction(async (trx) => {
      await marcarResultado(trx, ids, true, 'Simulación: anulación no comunicada a SUNAT');
      await trx('resumenes').where('id', resumenId).update({ estado: 'aceptado', identifier: `SIM-RC-${fecha.replaceAll('-', '')}-${resumenId}` });
    });
  } else {
    await encolar(db, 'enviar_anulacion', 'resumen', Number(resumenId), { prioridad: 1 });
  }
  return obtenerResumenAnulacion(Number(resumenId));
}

/**
 * Envía la baja (RA) o el resumen de anulación (RC) a API-PRO desde el worker, con la Idempotency-Key
 * de la solicitud: si se pierde la respuesta, el reintento devuelve el mismo documento en lugar de
 * crear otro. Solo un rechazo de datos (422) revierte los comprobantes a aceptado.
 */
export async function enviarAnulacion(trabajo: Trabajo): Promise<Resultado> {
  const esBaja = trabajo.entidad_tipo === 'baja';
  const fila = await db(esBaja ? 'bajas' : 'resumenes').where('id', trabajo.entidad_id).first();
  if (!fila) return { estado: 'fallido', error: 'No existe' };
  if (fila.api_id) return { estado: 'hecho' };
  if (await pausaActiva()) return { estado: 'reintentar', reintentarEnSeg: 60, error: 'Emisión pausada' };

  const ids = (await db(esBaja ? 'baja_documentos' : 'resumen_documentos').where(esBaja ? 'baja_id' : 'resumen_id', fila.id).pluck('comprobante_id')).map(Number);
  const comprobantes = await db('comprobantes').whereIn('id', ids).select('tipo_doc', 'serie', 'correlativo', 'api_id');
  const motivo = fila.motivo ?? (await db('resumen_documentos').where('resumen_id', fila.id).first('motivo'))?.motivo ?? 'Anulación';
  const ctx = { operacion: esBaja ? 'baja.enviar' : 'resumen.anular', entidadTipo: trabajo.entidad_tipo, entidadId: Number(fila.id) };
  const espera = esperaReintento(trabajo.intentos, ESPERAS_ENVIO);
  try {
    if (esBaja) {
      const { datos } = await llamarJson<{ id_anulacion: number; identifier: string }>(await obtenerCliente(), 'POST', '/anulaciones', ctx, {
        cuerpo: {
          fecha_generacion: fila.fecha_generacion,
          fecha_comunicacion: fechaLima(),
          detalles: comprobantes.map((c: { tipo_doc: string; serie: string; correlativo: number }) => ({ tipo_documento: c.tipo_doc, serie: c.serie, correlativo: String(c.correlativo), motivo })),
        },
        idempotencyKey: fila.idempotency_key,
      });
      await db('bajas').where('id', fila.id).update({ api_id: datos.id_anulacion, identifier: datos.identifier, estado: 'enviado', ultimo_error: null });
      await encolar(db, 'reconciliar_baja', 'baja', Number(fila.id), { ejecutarEn: new Date(Date.now() + 10_000) });
    } else {
      const { datos } = await llamarJson<{ id_resumen: number; identifier: string; documentos: unknown }>(await obtenerCliente(), 'POST', '/resumenes', ctx, {
        cuerpo: { fecha_resumen: fila.fecha_resumen, anular: comprobantes.map((c: { api_id: number }) => ({ id: Number(c.api_id), motivo })) },
        idempotencyKey: fila.idempotency_key,
      });
      await db('resumenes').where('id', fila.id).update({ api_id: datos.id_resumen, identifier: datos.identifier, estado: 'enviado', ultimo_error: null, documentos_api: JSON.stringify(datos.documentos) });
      await encolar(db, 'reconciliar_resumen', 'resumen', Number(fila.id), { ejecutarEn: new Date(Date.now() + 10_000) });
    }
    return { estado: 'hecho' };
  } catch (err) {
    const codigo = err instanceof ErrorApp ? err.codigo : '';
    const mensaje = err instanceof Error ? err.message : String(err);
    // 409 = la solicitud anterior con esta clave sigue en curso en API-PRO: se reintenta, no se revierte.
    const enCurso = err instanceof ErrorApp && (err.detalle as { httpStatus?: number } | undefined)?.httpStatus === 409;
    if (!enCurso && (codigo === 'APIPRO_VALIDACION' || codigo === 'APIPRO_NO_ENCONTRADO')) {
      // API-PRO rechazó la solicitud: no se creó nada; los comprobantes siguen válidos.
      await db.transaction(async (trx) => {
        await marcarResultado(trx, ids, false, null);
        await trx(esBaja ? 'bajas' : 'resumenes').where('id', fila.id).update({ estado: 'error', ultimo_error: mensaje.slice(0, 2000) });
      });
      return { estado: 'fallido', error: mensaje };
    }
    if (codigo === 'APIPRO_CREDENCIALES' || codigo === 'APIPRO_PROHIBIDO') await pausar(codigo, mensaje);
    await db(esBaja ? 'bajas' : 'resumenes').where('id', fila.id).update({ ultimo_error: mensaje.slice(0, 2000) });
    return { estado: 'reintentar', reintentarEnSeg: espera, error: mensaje };
  }
}

/** Consulta la baja con GET /anulaciones/{id} (lee la BD de API-PRO; no usa /estado, guarda B1). */
export async function reconciliarBaja(trabajo: Trabajo): Promise<Resultado> {
  const b = await db('bajas').where('id', trabajo.entidad_id).first();
  if (!b?.api_id) return { estado: 'fallido', error: 'La baja no está en API-PRO' };
  if (['aceptado', 'rechazado'].includes(b.estado)) return { estado: 'hecho' };
  if (await pausaActiva()) return { estado: 'reintentar', reintentarEnSeg: 60 };
  const espera = esperaReintento(trabajo.intentos, ESPERAS_CONSULTA);
  let datos: { estado_sunat: string; codigo_sunat: string | null; descripcion_sunat: string | null };
  try {
    ({ datos } = await llamarJson<typeof datos>(await obtenerCliente(), 'GET', `/anulaciones/${b.api_id}`, { operacion: 'baja.consultar', entidadTipo: 'baja', entidadId: Number(b.id) }));
  } catch {
    return { estado: 'reintentar', reintentarEnSeg: espera };
  }
  if (!['aceptado', 'rechazado'].includes(datos.estado_sunat)) return { estado: 'reintentar', reintentarEnSeg: espera };
  const ids = await db('baja_documentos').where('baja_id', b.id).pluck('comprobante_id');
  await db.transaction(async (trx) => {
    await marcarResultado(trx, ids.map(Number), datos.estado_sunat === 'aceptado', datos.descripcion_sunat);
    await trx('bajas').where('id', b.id).update({ estado: datos.estado_sunat, sunat_codigo: datos.codigo_sunat, sunat_descripcion: datos.descripcion_sunat });
  });
  return { estado: 'hecho' };
}

/** Resultado de un RC de anulación (lo llama reconciliarResumen). */
export async function aplicarResultadoResumenAnulacion(trx: Trx, resumenId: number, aceptado: boolean, detalle: string | null): Promise<void> {
  const ids = await trx('resumen_documentos').where('resumen_id', resumenId).pluck('comprobante_id');
  await marcarResultado(trx, ids.map(Number), aceptado, detalle);
}

// ---------- Consultas ----------

async function documentos(tabla: 'baja_documentos' | 'resumen_documentos', campo: 'baja_id' | 'resumen_id', id: number) {
  const filas = await db(`${tabla} as d`).join('comprobantes as c', 'c.id', 'd.comprobante_id').where(`d.${campo}`, id).select('c.id', 'c.numero_completo', 'c.estado');
  return filas.map((f: Record<string, unknown>) => ({ comprobanteId: Number(f.id), numero: (f.numero_completo as string | null) ?? null, estado: String(f.estado) }));
}

export async function obtenerBaja(id: number): Promise<BajaDto> {
  const b = await db('bajas').where('id', id).first();
  if (!b) throw errores.noEncontrado('Baja');
  return { id: Number(b.id), mecanismo: 'RA', identifier: b.identifier ?? null, fecha: b.fecha_generacion, estado: b.estado, motivo: b.motivo, simulado: Boolean(b.simulado), documentos: await documentos('baja_documentos', 'baja_id', id), sunatDescripcion: b.sunat_descripcion ?? b.ultimo_error ?? null, creadoEn: new Date(b.created_at).toISOString() };
}

export async function obtenerResumenAnulacion(id: number): Promise<BajaDto> {
  const r = await db('resumenes').where({ id, tipo: 'anulacion' }).first();
  if (!r) throw errores.noEncontrado('Resumen de anulación');
  const motivo = await db('resumen_documentos').where('resumen_id', id).first('motivo');
  return { id: Number(r.id), mecanismo: 'RC', identifier: r.identifier ?? null, fecha: r.fecha_resumen, estado: r.estado, motivo: motivo?.motivo ?? null, simulado: Boolean(r.simulado), documentos: await documentos('resumen_documentos', 'resumen_id', id), sunatDescripcion: r.sunat_descripcion ?? r.ultimo_error ?? null, creadoEn: new Date(r.created_at).toISOString() };
}

export async function listar(): Promise<BajaDto[]> {
  const bajas = await db('bajas').orderBy('id', 'desc').limit(50).pluck('id');
  const rcs = await db('resumenes').where('tipo', 'anulacion').orderBy('id', 'desc').limit(50).pluck('id');
  const todas = [...(await Promise.all(bajas.map((id: number) => obtenerBaja(Number(id))))), ...(await Promise.all(rcs.map((id: number) => obtenerResumenAnulacion(Number(id)))))];
  return todas.sort((a, b) => b.creadoEn.localeCompare(a.creadoEn));
}

/** Registra la devolución del dinero de una venta anulada desde la caja abierta. */
export async function reembolsar(ventaId: number, datos: { cajaId: number; metodoPagoId: number }, ctx: { sucursalId: number; usuarioId: number }): Promise<string> {
  return db.transaction(async (trx) => {
    const t = await trx('turnos_caja as t').join('cajas as c', 'c.id', 't.caja_id').where({ 't.caja_id': datos.cajaId, 't.estado': 'abierto', 'c.sucursal_id': ctx.sucursalId }).first('t.id');
    if (!t) throw new ErrorApp(409, 'TURNO_NO_ABIERTO', 'Abre la caja para devolver el dinero');
    await bloquearTurnoAbierto(trx, Number(t.id));
    const v = await trx('ventas').where('id', ventaId).forUpdate().first('id', 'moneda', 'reembolso_pendiente', 'estado', 'sucursal_id');
    if (!v) throw errores.noEncontrado('Venta');
    // El dinero se devuelve en la sucursal que cobró la venta (cuadre de su caja).
    if (Number(v.sucursal_id) !== ctx.sucursalId) throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'La venta es de otra sucursal: el reembolso se registra en la caja de esa sucursal');
    if (v.estado !== 'anulada' || !dec(v.reembolso_pendiente).gt(0)) throw new ErrorApp(409, 'ESTADO_NO_PERMITE', 'La venta no tiene reembolso pendiente');
    await registrarMovimiento(trx, {
      turnoId: Number(t.id),
      tipo: 'anulacion',
      metodoPagoId: datos.metodoPagoId,
      moneda: v.moneda as Moneda,
      monto: dec(v.reembolso_pendiente).negated(),
      concepto: `Reembolso de la venta anulada ${ventaId}`,
      origenTipo: 'reembolso',
      origenId: ventaId,
      usuarioId: ctx.usuarioId,
    });
    await trx('ventas').where('id', ventaId).update({ reembolso_pendiente: 0 });
    return aImporte(v.reembolso_pendiente);
  });
}

export const claveNueva = () => randomUUID();
