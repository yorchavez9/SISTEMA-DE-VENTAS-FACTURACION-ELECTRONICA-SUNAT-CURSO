import type { AccionComprobante, ComprobanteDetalleDto, ComprobanteListaDto, EstadoComprobante, FormatoPdf, Pagina } from '@sv/shared';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Knex } from 'knex';
import { db } from '../../database/db.js';
import type { RespuestaBinaria, RespuestaJson } from '../../integrations/apiPro/cliente.js';
import { puedeEnviar } from '../../integrations/apiPro/guardas.js';
import { llamarJson, registrar as registrarIntento } from '../../integrations/apiPro/llamada.js';
import { obtenerCliente } from '../../integrations/apiPro/proveedor.js';
import { encolar } from '../../jobs/outbox.js';
import { sha256 } from '../../shared/crypto.js';
import { ErrorApp, errores } from '../../shared/errors.js';
import { errorNumeroDocumento } from '@sv/shared';
import { fechaLima } from '../../shared/fechas.js';
import { construirPayload, RECURSO_API, type DocumentoApi } from './contrato.js';
import { carpeta } from '../../shared/almacen.js';

const ATENCION: EstadoComprobante[] = ['rechazado', 'error_validacion', 'por_verificar', 'sin_respuesta_sunat'];
const DIR_ARCHIVOS = carpeta('cpe');

function aLista(f: Record<string, unknown>): ComprobanteListaDto {
  const estado = f.estado as EstadoComprobante;
  return {
    id: Number(f.id),
    tipoDoc: f.tipo_doc as ComprobanteListaDto['tipoDoc'],
    serie: String(f.serie),
    correlativo: f.correlativo == null ? null : Number(f.correlativo),
    numeroCompleto: (f.numero_completo as string | null) ?? null,
    fechaEmision: String(f.fecha_emision),
    ventaId: f.venta_id == null ? null : Number(f.venta_id),
    cliente: { tipoDoc: String(f.cliente_tipo_doc), numDoc: String(f.cliente_num_doc), razonSocial: String(f.cliente_razon_social) },
    moneda: f.moneda as ComprobanteListaDto['moneda'],
    total: String(f.total),
    estado,
    modoEnvio: f.modo_envio as 'individual' | 'resumen',
    simulado: Boolean(f.simulado),
    archivos: accionesPara({ tipo_doc: String(f.tipo_doc), estado, api_id: f.api_id == null ? null : Number(f.api_id), simulado: Boolean(f.simulado), venta_id: null }).filter((x): x is 'pdf' | 'xml' | 'cdr' => x === 'pdf' || x === 'xml' || x === 'cdr'),
    detalle: ATENCION.includes(estado) ? ((f.ultimo_error as string | null) ?? (f.sunat_descripcion as string | null) ?? null) : ((f.sunat_descripcion as string | null) ?? null),
    creadoEn: new Date(f.created_at as string).toISOString(),
  };
}

/** Acciones que la interfaz puede ofrecer según el estado (docs/03-api-interna.md §8). */
/** Primer día de emisión que aún se puede anular (hoy − 7, hora de Lima). */
function limiteAnulacion(): string {
  const d = new Date(`${fechaLima()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

export function accionesPara(c: { tipo_doc: string; fecha_emision?: string; estado: EstadoComprobante; api_id: number | null; simulado: boolean; venta_id: number | null; venta_estado?: string | null }): AccionComprobante[] {
  const a: AccionComprobante[] = [];
  const conArchivos = c.api_id != null && !c.simulado;
  if (conArchivos) a.push('pdf');
  if (conArchivos && ['aceptado', 'observado', 'anulado', 'anulacion_en_proceso', 'rechazado'].includes(c.estado)) a.push('xml');
  if (conArchivos && ['aceptado', 'observado', 'anulado', 'anulacion_en_proceso'].includes(c.estado)) a.push('cdr');
  if (['por_verificar', 'sin_respuesta_sunat', 'rechazado'].includes(c.estado)) a.push('reintentar');
  if (c.api_id != null && !c.simulado && !['aceptado', 'observado', 'anulado'].includes(c.estado)) a.push('consultar');
  if (['error_validacion', 'rechazado'].includes(c.estado)) a.push('corregir');
  if (c.venta_id && c.venta_estado === 'confirmada' && c.api_id == null && ['pendiente', 'error_validacion'].includes(c.estado)) a.push('anular_interna');
  if (['01', '03'].includes(c.tipo_doc) && ['aceptado', 'observado'].includes(c.estado)) a.push('nota_credito', 'nota_debito');
  if (['aceptado', 'observado'].includes(c.estado) && c.fecha_emision && c.fecha_emision >= limiteAnulacion()) a.push('anular');
  return a;
}

export async function listar(sucursalIds: number[], f: { page: number; pageSize: number; desde?: string; hasta?: string; tipoDoc?: string; estado?: string; q?: string; atencion?: boolean }): Promise<Pagina<ComprobanteListaDto>> {
  const filtrar = (q: Knex.QueryBuilder) => {
    q.whereIn('sucursal_id', sucursalIds);
    if (f.desde) q.where('fecha_emision', '>=', f.desde);
    if (f.hasta) q.where('fecha_emision', '<=', f.hasta);
    if (f.tipoDoc) q.where('tipo_doc', f.tipoDoc);
    if (f.estado) q.where('estado', f.estado);
    if (f.atencion) q.whereIn('estado', ATENCION);
    if (f.q) {
      const t = f.q.replace(/[\\%_]/g, '');
      q.where((w) => w.where('numero_completo', 'like', `%${t}%`).orWhere('cliente_num_doc', 'like', `${t}%`).orWhereILike('cliente_razon_social', `%${t}%`));
    }
  };
  const [{ total }] = (await db('comprobantes').modify(filtrar).count({ total: '*' })) as [{ total: number }];
  const filas = await db('comprobantes').modify(filtrar).orderBy('id', 'desc').limit(f.pageSize).offset((f.page - 1) * f.pageSize);
  return { data: filas.map(aLista), page: f.page, pageSize: f.pageSize, total: Number(total) };
}

export async function obtener(id: number): Promise<ComprobanteDetalleDto> {
  const c = await db('comprobantes as c')
    .join('sucursales as s', 's.id', 'c.sucursal_id')
    .leftJoin('ventas as v', 'v.id', 'c.venta_id')
    .where('c.id', id)
    .first('c.*', 's.nombre as sucursal_nombre', 'v.estado as venta_estado', 'v.reembolso_pendiente');
  if (!c) throw errores.noEncontrado('Comprobante');
  const [items, cuotas, historial] = await Promise.all([
    db('comprobante_items').where('comprobante_id', id).orderBy('id'),
    db('comprobante_cuotas').where('comprobante_id', id).orderBy('numero'),
    db('integracion_intentos').where({ entidad_tipo: 'comprobante', entidad_id: id }).orderBy('id', 'desc').limit(30),
  ]);
  return {
    ...aLista(c),
    sucursal: { id: Number(c.sucursal_id), nombre: c.sucursal_nombre },
    formaPago: c.forma_pago,
    opGravada: c.op_gravada,
    opExonerada: c.op_exonerada,
    opInafecta: c.op_inafecta,
    igv: c.igv,
    totalApi: c.total_api ?? null,
    apiId: c.api_id == null ? null : Number(c.api_id),
    sunat: { codigo: c.sunat_codigo ?? null, descripcion: c.sunat_descripcion ?? null, notas: c.sunat_notas ?? null, hash: c.hash_cpe ?? null },
    ultimoError: c.ultimo_error ?? null,
    intentos: Number(c.intentos),
    items: items.map((i: Record<string, string | null>) => ({ codigo: i.codigo ?? null, descripcion: i.descripcion!, unidad: i.unidad!, cantidad: i.cantidad!, precioUnitario: i.precio_unitario!, total: i.total! })),
    cuotas: cuotas.map((q: Record<string, string>) => ({ numero: Number(q.numero), monto: q.monto!, fechaPago: q.fecha_pago! })),
    acciones: accionesPara({ tipo_doc: c.tipo_doc, fecha_emision: c.fecha_emision, estado: c.estado, api_id: c.api_id == null ? null : Number(c.api_id), simulado: Boolean(c.simulado), venta_id: c.venta_id == null ? null : Number(c.venta_id), venta_estado: c.venta_estado }),
    reembolsoPendiente: c.reembolso_pendiente && Number(c.reembolso_pendiente) > 0 && ['01', '03'].includes(c.tipo_doc) ? c.reembolso_pendiente : null,
    historial: historial.map((h: Record<string, unknown>) => ({
      fecha: new Date(h.creado_en as string).toISOString(),
      operacion: String(h.operacion),
      metodo: String(h.metodo),
      ruta: String(h.ruta),
      httpStatus: h.http_status == null ? null : Number(h.http_status),
      error: (h.error as string | null) ?? null,
      duracionMs: h.duracion_ms == null ? null : Number(h.duracion_ms),
    })),
  };
}

async function exigirAccion(id: number, accion: AccionComprobante) {
  const d = await obtener(id);
  if (!d.acciones.includes(accion)) throw new ErrorApp(409, 'ESTADO_NO_PERMITE', `Esta acción no está disponible en el estado "${d.estado}"`);
  return d;
}

/**
 * Reintento manual. Sin api_id (por verificar): se adelanta el reintento con la misma clave.
 * Con api_id (rechazado / sin respuesta): POST /{recurso}/{id}/enviar, solo si el estado remoto,
 * recién leído, lo permite (guarda B2: nunca se reabre un documento anulado).
 */
export async function reintentar(id: number): Promise<ComprobanteDetalleDto> {
  const d = await exigirAccion(id, 'reintentar');
  if (d.apiId == null) {
    await db('outbox_trabajos').where({ tipo: 'emitir_comprobante', entidad_tipo: 'comprobante', entidad_id: id }).whereIn('estado', ['pendiente', 'pausado']).update({ ejecutar_en: db.raw('CURRENT_TIMESTAMP(3)'), estado: 'pendiente' });
    await encolar(db, 'emitir_comprobante', 'comprobante', id, { prioridad: 1 });
    return obtener(id);
  }
  const cliente = await obtenerCliente();
  const recurso = RECURSO_API[d.tipoDoc];
  const { datos } = await llamarJson<DocumentoApi>(cliente, 'GET', `/${recurso}/${d.apiId}`, { operacion: 'comprobante.consultar', entidadTipo: 'comprobante', entidadId: id });
  if (!puedeEnviar(datos.sunat.estado)) {
    throw new ErrorApp(409, 'ESTADO_NO_PERMITE', `En API-PRO el comprobante está "${datos.sunat.estado}": no se puede reenviar`);
  }
  await llamarJson(cliente, 'POST', `/${recurso}/${d.apiId}/enviar`, { operacion: 'comprobante.reenviar', entidadTipo: 'comprobante', entidadId: id });
  await db('comprobantes').where('id', id).update({ estado: 'en_proceso', ultimo_error: null });
  await encolar(db, 'reconciliar_comprobante', 'comprobante', id, { ejecutarEn: new Date(Date.now() + 5000) });
  return obtener(id);
}

export async function consultar(id: number): Promise<ComprobanteDetalleDto> {
  await exigirAccion(id, 'consultar');
  await db('outbox_trabajos').where({ tipo: 'reconciliar_comprobante', entidad_tipo: 'comprobante', entidad_id: id }).whereIn('estado', ['pendiente', 'pausado']).update({ ejecutar_en: db.raw('CURRENT_TIMESTAMP(3)'), estado: 'pendiente' });
  await encolar(db, 'reconciliar_comprobante', 'comprobante', id);
  return obtener(id);
}

/**
 * Corrige los datos del cliente y vuelve a emitir. Los ítems y montos no cambian (si estaban mal,
 * se anula la venta o se emite una nota de crédito).
 *  - error_validacion (no existe en API-PRO): Idempotency-Key nueva y nueva emisión.
 *  - rechazado (existe en API-PRO): PUT /{recurso}/{id} con el payload completo (guarda B8); la API reenvía.
 */
export async function corregir(id: number, cliente: { tipoDoc: string; numDoc: string; razonSocial: string; direccion?: string }): Promise<ComprobanteDetalleDto> {
  const d = await exigirAccion(id, 'corregir');
  if (cliente.tipoDoc !== '0') {
    const e = errorNumeroDocumento(cliente.tipoDoc, cliente.numDoc);
    if (e) throw errores.validacion({ 'cliente.numDoc': e });
  }
  if (d.tipoDoc === '01' && cliente.tipoDoc !== '6') throw errores.validacion({ 'cliente.tipoDoc': 'La factura requiere RUC' });
  if (d.tipoDoc === '01' && !cliente.direccion) throw errores.validacion({ 'cliente.direccion': 'La factura requiere la dirección fiscal' });

  const cambios = {
    cliente_tipo_doc: cliente.tipoDoc,
    cliente_num_doc: cliente.numDoc,
    cliente_razon_social: cliente.razonSocial,
    cliente_direccion: cliente.direccion || null,
  };
  if (d.apiId == null) {
    await db('comprobantes').where('id', id).update({ ...cambios, estado: 'pendiente', idempotency_key: randomUUID(), ultimo_error: null, sunat_descripcion: null });
    await db('outbox_trabajos').where({ tipo: 'emitir_comprobante', entidad_tipo: 'comprobante', entidad_id: id }).whereIn('estado', ['pendiente', 'en_proceso', 'pausado']).update({ estado: 'hecho' });
    await encolar(db, 'emitir_comprobante', 'comprobante', id, { prioridad: 1 });
    return obtener(id);
  }

  const c = await db('comprobantes').where('id', id).first();
  const [items, cuotas, sucursal] = await Promise.all([
    db('comprobante_items').where('comprobante_id', id).orderBy('id'),
    db('comprobante_cuotas').where('comprobante_id', id).orderBy('numero'),
    db('sucursales').where('id', c.sucursal_id).first('cod_local', 'api_sucursal_id'),
  ]);
  const payload = construirPayload({ ...c, ...cambios }, items, cuotas, sucursal?.api_sucursal_id ? sucursal.cod_local : null);
  const recurso = RECURSO_API[d.tipoDoc];
  const clienteApi = await obtenerCliente();
  const { datos } = await llamarJson<DocumentoApi>(clienteApi, 'GET', `/${recurso}/${d.apiId}`, { operacion: 'comprobante.consultar', entidadTipo: 'comprobante', entidadId: id });
  if (!puedeEnviar(datos.sunat.estado)) throw new ErrorApp(409, 'ESTADO_NO_PERMITE', `En API-PRO el comprobante está "${datos.sunat.estado}": no se puede corregir`);
  await llamarJson(clienteApi, 'PUT', `/${recurso}/${d.apiId}`, { operacion: 'comprobante.corregir', entidadTipo: 'comprobante', entidadId: id }, { cuerpo: payload, emision: true, idempotencyKey: randomUUID() });
  await db('comprobantes').where('id', id).update({ ...cambios, estado: 'en_proceso', ultimo_error: null });
  await encolar(db, 'reconciliar_comprobante', 'comprobante', id, { ejecutarEn: new Date(Date.now() + 5000) });
  return obtener(id);
}

// ---------- Archivos (proxy con caché) ----------

const TIPO_ARCHIVO = { a4: 'pdf_a4', a5: 'pdf_a5', 'ticket-80': 'pdf_t80', 'ticket-58': 'pdf_t58' } as const;

export async function archivo(id: number, que: 'pdf' | 'xml' | 'cdr', formato: FormatoPdf = 'a4'): Promise<{ datos: Buffer; contentType: string; nombre: string }> {
  const d = await obtener(id);
  if (d.simulado) throw new ErrorApp(409, 'COMPROBANTE_SIMULADO', 'Los comprobantes simulados no tienen archivos de SUNAT');
  if (!d.acciones.includes(que)) throw new ErrorApp(409, 'ARCHIVO_NO_DISPONIBLE', que === 'pdf' ? 'El comprobante aún no existe en API-PRO' : `El ${que.toUpperCase()} aún no está disponible`);

  const tipo = que === 'pdf' ? TIPO_ARCHIVO[formato] : que;
  const nombre = `${d.numeroCompleto ?? `comprobante-${id}`}${que === 'pdf' ? `-${formato}.pdf` : que === 'xml' ? '.xml' : '-cdr.zip'}`;
  const cache = await db('archivos_cpe').where({ entidad_tipo: 'comprobante', entidad_id: id, tipo }).first();
  if (cache) {
    try {
      return { datos: await readFile(cache.ruta), contentType: cache.content_type, nombre };
    } catch {
      await db('archivos_cpe').where('id', cache.id).delete(); // el archivo desapareció: se vuelve a descargar
    }
  }

  // Guarda del PDF: siempre ?format= (boletas y notas ignoran ?formato=).
  const ruta = `/${RECURSO_API[d.tipoDoc]}/${d.apiId}/${que}${que === 'pdf' ? `?format=${formato}` : ''}`;
  const inicio = Date.now();
  const r = (await (await obtenerCliente()).llamar('GET', ruta, { binario: true })) as RespuestaBinaria | RespuestaJson<{ mensaje?: string }>;
  await registrarIntento({ operacion: `comprobante.${que}`, entidadTipo: 'comprobante', entidadId: id }, 'GET', ruta, {}, r.status, r.tipo === 'json' ? r.cuerpo : { bytes: r.datos.length }, Date.now() - inicio, null);
  if (r.tipo === 'json' || r.status !== 200) {
    const mensaje = r.tipo === 'json' ? r.cuerpo?.mensaje : `HTTP ${r.status}`;
    throw new ErrorApp(r.status === 404 ? 404 : 502, 'ARCHIVO_NO_DISPONIBLE', `API-PRO: ${mensaje ?? 'archivo no disponible'}`);
  }

  // Solo se guarda en caché cuando el estado ya es definitivo (el PDF de un pendiente puede cambiar).
  if (['aceptado', 'observado', 'anulado'].includes(d.estado)) {
    await mkdir(DIR_ARCHIVOS, { recursive: true });
    const destino = path.join(DIR_ARCHIVOS, `${id}-${tipo}.bin`);
    await writeFile(destino, r.datos);
    await db('archivos_cpe')
      .insert({ entidad_tipo: 'comprobante', entidad_id: id, tipo, ruta: destino, content_type: r.contentType, sha256: sha256(r.datos.toString('base64')), bytes: r.datos.length })
      .onConflict(['entidad_tipo', 'entidad_id', 'tipo'])
      .merge();
  }
  return { datos: r.datos, contentType: r.contentType, nombre };
}

export async function contadores(sucursalIds: number[]) {
  const filas = (await db('comprobantes').whereIn('sucursal_id', sucursalIds).whereIn('estado', ['pendiente', 'enviando', 'en_proceso', 'por_verificar', 'rechazado', 'error_validacion', 'sin_respuesta_sunat', 'pendiente_resumen']).groupBy('estado').select('estado').count({ n: '*' })) as Array<{ estado: string; n: number }>;
  const n = (...e: string[]) => filas.filter((f) => e.includes(f.estado)).reduce((a, f) => a + Number(f.n), 0);
  return {
    pendientes: n('pendiente', 'enviando'),
    enProceso: n('en_proceso'),
    porVerificar: n('por_verificar'),
    problemas: n('rechazado', 'error_validacion', 'sin_respuesta_sunat'),
    pendienteResumen: n('pendiente_resumen'),
  };
}
