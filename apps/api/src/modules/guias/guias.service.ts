import type { AccionGuia, BorradorGuiaDto, EstadoGuia, FiltroGuias, GuiaDetalleDto, GuiaInput, GuiaListaDto, MotivoTraslado, Pagina } from '@sv/shared';
import { MOTIVOS_DESTINO_AJENO, MOTIVOS_DESTINO_PROPIO, MOTIVOS_TRASLADO } from '@sv/shared';
import type { Knex } from 'knex';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../../database/db.js';
import { ErrorRedApiPro, type RespuestaBinaria, type RespuestaJson } from '../../integrations/apiPro/cliente.js';
import { LlamadaProhibida, puedeEnviar } from '../../integrations/apiPro/guardas.js';
import { llamarJson, registrar as registrarIntento, type EnvelopeApiPro } from '../../integrations/apiPro/llamada.js';
import { obtenerCliente } from '../../integrations/apiPro/proveedor.js';
import { encolar, type Resultado, type Trabajo } from '../../jobs/outbox.js';
import { aCantidad, compacto } from '../../shared/decimal.js';
import { ErrorApp, errores } from '../../shared/errors.js';
import { fechaLima } from '../../shared/fechas.js';
import { ESPERAS_CONSULTA, ESPERAS_ENVIO, esperaReintento, mensajeValidacion } from '../facturacion/contrato.js';
import { manejarErrorGlobal } from '../facturacion/emision.service.js';
import { pausaActiva } from '../facturacion/pausa.js';
import { nombreLugar } from './maestros.service.js';
import { carpeta } from '../../shared/almacen.js';

// Guía de remisión remitente (09), plan §0.6. Emisión asíncrona igual que los comprobantes:
// Idempotency-Key propia, POST /guias-remision desde el worker y seguimiento con
// GET /guias-remision/{id} (nunca /estado, guarda B1). La guía no mueve stock.

const DIR_ARCHIVOS = carpeta('cpe');
const LIBERAR_ENVIANDO_SEG = 120;

interface FilaGuia {
  id: number;
  sucursal_id: number;
  serie_id: number;
  serie: string;
  correlativo: number | null;
  numero_completo: string | null;
  fecha_emision: string;
  origen_tipo: 'venta' | 'traslado' | 'manual';
  comprobante_id: number | null;
  traslado_id: number | null;
  destinatario_tipo_doc: string;
  destinatario_num_doc: string;
  destinatario_razon_social: string;
  cod_traslado: string;
  mod_traslado: '01' | '02';
  vehiculo_m1l: number | boolean;
  fecha_traslado: string;
  fecha_entrega_transportista: string | null;
  peso_total: string;
  und_peso_total: string;
  num_bultos: number | null;
  partida_ubigeo: string;
  partida_direccion: string;
  partida_cod_local: string | null;
  llegada_ubigeo: string;
  llegada_direccion: string;
  llegada_cod_local: string | null;
  transportista: Transportista | null;
  vehiculo: Vehiculo | null;
  conductores: Conductor[] | null;
  docs_relacionados: Array<{ tipo_codigo: string; numero: string }> | null;
  observacion: string | null;
  estado: EstadoGuia;
  api_id: number | null;
  sunat_codigo: string | null;
  sunat_descripcion: string | null;
  ultimo_error: string | null;
  intentos: number;
  simulado: number | boolean;
  idempotency_key: string;
  created_at: string;
}
interface Transportista { id: number; ruc: string; razon_social: string; nro_mtc: string | null }
interface Vehiculo { id: number; placa: string; nro_circulacion: string | null; secundarios: Array<{ id: number; placa: string; nro_circulacion: string | null }> }
interface Conductor { id: number; tipo: 'Principal' | 'Secundario'; tipo_doc: string; num_doc: string; nombres: string; apellidos: string; licencia: string }
interface FilaItem { producto_id: number | null; codigo: string | null; descripcion: string; unidad: string; cantidad: string }

/** Lee una columna JSON (mysql2 la devuelve ya parseada; por si acaso, se acepta texto). */
const json = <T>(v: unknown): T | null => (v == null ? null : typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));

async function leer(id: number, conn: Knex = db): Promise<FilaGuia | undefined> {
  const g = await conn('guias').where('id', id).first();
  if (!g) return undefined;
  return { ...g, transportista: json(g.transportista), vehiculo: json(g.vehiculo), conductores: json(g.conductores), docs_relacionados: json(g.docs_relacionados) };
}

// ---------- Payload de API-PRO ----------

/** Payload de POST/PUT /guias-remision (contrato de StoreDispatchGuideRequest en API-PRO). */
export function construirPayloadGuia(g: FilaGuia, items: FilaItem[], rucEmpresa: string): Record<string, unknown> {
  const p: Record<string, unknown> = {
    serie: g.serie,
    fecha_emision: g.fecha_emision,
    destinatario: { tipo_doc: g.destinatario_tipo_doc, num_doc: g.destinatario_num_doc, razon_social: g.destinatario_razon_social },
    cod_traslado: g.cod_traslado,
    mod_traslado: g.mod_traslado,
    fecha_traslado: g.fecha_traslado,
    peso_total: Number(g.peso_total),
    und_peso_total: g.und_peso_total,
    partida_ubigeo: g.partida_ubigeo,
    partida_direccion: g.partida_direccion,
    llegada_ubigeo: g.llegada_ubigeo,
    llegada_direccion: g.llegada_direccion,
    items: items.map((i) => ({ ...(i.codigo ? { codigo: i.codigo } : {}), descripcion: i.descripcion, cantidad: Number(compacto(i.cantidad)), unidad: i.unidad })),
  };
  if (g.num_bultos) p.num_bultos = Number(g.num_bultos);
  if (g.observacion) p.observacion = g.observacion;
  if (g.vehiculo_m1l) p.indicadores = ['SUNAT_Envio_IndicadorTrasladoVehiculoM1L'];
  // Traslado entre establecimientos: se identifican los locales con el RUC propio.
  if (g.cod_traslado === '04') {
    p.partida_ruc = rucEmpresa;
    p.llegada_ruc = rucEmpresa;
    if (g.partida_cod_local) p.partida_cod_local = g.partida_cod_local;
    if (g.llegada_cod_local) p.llegada_cod_local = g.llegada_cod_local;
  }
  if (g.mod_traslado === '01' && g.transportista) {
    p.transportista = { tipo_doc: '6', num_doc: g.transportista.ruc, razon_social: g.transportista.razon_social, ...(g.transportista.nro_mtc ? { nro_mtc: g.transportista.nro_mtc } : {}) };
    if (g.fecha_entrega_transportista) p.fecha_entrega_transportista = g.fecha_entrega_transportista;
  }
  if (g.mod_traslado === '02' && g.vehiculo) {
    const v = (x: { placa: string; nro_circulacion: string | null }) => ({ placa: x.placa, ...(x.nro_circulacion ? { nro_circulacion: x.nro_circulacion } : {}) });
    p.vehiculo = { ...v(g.vehiculo), ...(g.vehiculo.secundarios.length ? { secundarios: g.vehiculo.secundarios.map(v) } : {}) };
  }
  if (g.mod_traslado === '02' && g.conductores?.length) {
    p.conductores = g.conductores.map((c) => ({ tipo: c.tipo, tipo_doc: c.tipo_doc, num_doc: c.num_doc, nombres: c.nombres, apellidos: c.apellidos, licencia: c.licencia }));
  }
  if (g.docs_relacionados?.length) p.doc_relacionado = g.docs_relacionados;
  return p;
}

// ---------- Consultas ----------

function accionesPara(g: Pick<FilaGuia, 'estado' | 'api_id' | 'simulado'>): AccionGuia[] {
  if (g.simulado) return [];
  const a: AccionGuia[] = [];
  if (g.estado === 'por_verificar' || (g.api_id && ['rechazado', 'sin_respuesta_sunat'].includes(g.estado))) a.push('reintentar');
  if (g.api_id && ['en_proceso', 'sin_respuesta_sunat'].includes(g.estado)) a.push('consultar');
  if (g.estado === 'error_validacion' || (g.api_id && g.estado === 'rechazado')) a.push('corregir');
  if (g.api_id) a.push('pdf');
  if (g.api_id && ['en_proceso', 'aceptado', 'rechazado'].includes(g.estado)) a.push('xml');
  if (g.api_id && g.estado === 'aceptado') a.push('cdr');
  return a;
}

const aLista = (g: Record<string, unknown>): GuiaListaDto => ({
  id: Number(g.id),
  numeroCompleto: (g.numero_completo as string | null) ?? null,
  serie: String(g.serie),
  fechaEmision: String(g.fecha_emision),
  fechaTraslado: String(g.fecha_traslado),
  destinatario: String(g.destinatario_razon_social),
  motivo: MOTIVOS_TRASLADO[g.cod_traslado as MotivoTraslado] ?? String(g.cod_traslado),
  estado: g.estado as EstadoGuia,
  simulado: Boolean(g.simulado),
  sucursal: String(g.sucursal_nombre ?? ''),
});

export async function listar(sucursalIds: number[], f: FiltroGuias): Promise<Pagina<GuiaListaDto>> {
  const filtrar = (q: Knex.QueryBuilder) => {
    q.whereIn('g.sucursal_id', sucursalIds);
    if (f.desde) q.where('g.fecha_emision', '>=', f.desde);
    if (f.hasta) q.where('g.fecha_emision', '<=', f.hasta);
    if (f.estado) q.where('g.estado', f.estado);
    if (f.q) {
      const t = f.q.replace(/[\\%_]/g, '');
      q.where((w) => w.where('g.numero_completo', 'like', `%${t}%`).orWhere('g.destinatario_num_doc', 'like', `${t}%`).orWhereILike('g.destinatario_razon_social', `%${t}%`));
    }
  };
  const [{ total }] = (await db('guias as g').modify(filtrar).count({ total: '*' })) as [{ total: number }];
  const filas = await db('guias as g').join('sucursales as s', 's.id', 'g.sucursal_id').modify(filtrar).orderBy('g.id', 'desc').limit(f.pageSize).offset((f.page - 1) * f.pageSize).select('g.*', 's.nombre as sucursal_nombre');
  return { data: filas.map(aLista), page: f.page, pageSize: f.pageSize, total: Number(total) };
}

export async function obtener(id: number): Promise<GuiaDetalleDto> {
  const g = await leer(id);
  if (!g) throw errores.noEncontrado('Guía');
  const [suc, items, comp, partidaLugar, llegadaLugar] = await Promise.all([
    db('sucursales').where('id', g.sucursal_id).first('nombre'),
    db('guia_items').where('guia_id', id).orderBy('id'),
    g.comprobante_id ? db('comprobantes').where('id', g.comprobante_id).first('numero_completo') : null,
    nombreLugar(g.partida_ubigeo),
    nombreLugar(g.llegada_ubigeo),
  ]);
  return {
    ...aLista({ ...g, sucursal_nombre: suc?.nombre }),
    sucursalId: Number(g.sucursal_id),
    origen: { tipo: g.origen_tipo, comprobanteId: g.comprobante_id ? Number(g.comprobante_id) : null, comprobante: comp?.numero_completo ?? null, trasladoId: g.traslado_id ? Number(g.traslado_id) : null },
    destinatarioDoc: { tipoDoc: g.destinatario_tipo_doc, numDoc: g.destinatario_num_doc, razonSocial: g.destinatario_razon_social },
    codTraslado: g.cod_traslado,
    modTraslado: g.mod_traslado,
    vehiculoM1l: Boolean(g.vehiculo_m1l),
    fechaEntregaTransportista: g.fecha_entrega_transportista ?? null,
    pesoTotal: g.peso_total,
    numBultos: g.num_bultos == null ? null : Number(g.num_bultos),
    partida: { ubigeo: g.partida_ubigeo, direccion: g.partida_direccion, lugar: partidaLugar },
    llegada: { ubigeo: g.llegada_ubigeo, direccion: g.llegada_direccion, lugar: llegadaLugar },
    transportista: g.transportista ? { ruc: g.transportista.ruc, razonSocial: g.transportista.razon_social, nroMtc: g.transportista.nro_mtc } : null,
    vehiculo: g.vehiculo ? { placa: g.vehiculo.placa, nroCirculacion: g.vehiculo.nro_circulacion, secundarios: g.vehiculo.secundarios.map((s) => s.placa) } : null,
    conductores: (g.conductores ?? []).map((c) => ({ tipo: c.tipo, tipoDoc: c.tipo_doc, numDoc: c.num_doc, nombre: `${c.nombres} ${c.apellidos}`, licencia: c.licencia })),
    observacion: g.observacion ?? null,
    items: items.map((i: Record<string, unknown>) => ({ productoId: i.producto_id == null ? null : Number(i.producto_id), codigo: (i.codigo as string | null) ?? null, descripcion: String(i.descripcion), unidad: String(i.unidad), cantidad: String(i.cantidad) })),
    sunatCodigo: g.sunat_codigo ?? null,
    sunatDescripcion: g.sunat_descripcion ?? null,
    ultimoError: g.ultimo_error ?? null,
    acciones: accionesPara(g),
    ids: { serieId: Number(g.serie_id), transportistaId: g.transportista?.id ?? null, vehiculoId: g.vehiculo?.id ?? null, conductoresIds: (g.conductores ?? []).map((c) => c.id) },
    creadoEn: new Date(g.created_at).toISOString(),
  };
}

const GUIA_VIGENTE = ['pendiente', 'enviando', 'por_verificar', 'en_proceso', 'aceptado', 'sin_respuesta_sunat'];

/** Datos sugeridos para la guía: copia destinatario, direcciones y bienes de la venta o el traslado. */
export async function borrador(origen: GuiaInput['origen'], sucursalId: number): Promise<BorradorGuiaDto> {
  const suc = await db('sucursales').where('id', sucursalId).first('direccion', 'ubigeo');
  const partida = suc?.direccion && suc?.ubigeo ? { ubigeo: suc.ubigeo, direccion: suc.direccion } : null;
  const advertencias: string[] = [];
  if (!partida) advertencias.push('La sucursal no tiene dirección o ubigeo: complétalos en Configuración o escríbelos aquí.');

  if (origen.tipo === 'venta') {
    const c = await comprobanteOrigen(origen.comprobanteId, sucursalId);
    const items = await db('comprobante_items as i').leftJoin('productos as p', 'p.id', 'i.producto_id').where('i.comprobante_id', c.id).where((w) => w.whereNull('p.tipo').orWhere('p.tipo', 'bien')).orderBy('i.id').select('i.producto_id', 'i.codigo', 'i.descripcion', 'i.unidad', 'i.cantidad');
    const sinDoc = !['1', '6', '4', '7', 'A'].includes(c.cliente_tipo_doc);
    if (sinDoc) advertencias.push('La venta no tiene documento del cliente: escribe el del destinatario.');
    if (!c.cliente_direccion) advertencias.push('El cliente no tiene dirección: escribe el punto de llegada.');
    return {
      origen,
      codTraslado: '01',
      destinatario: sinDoc ? null : { tipoDoc: c.cliente_tipo_doc, numDoc: c.cliente_num_doc, razonSocial: c.cliente_razon_social },
      partida,
      llegada: c.cliente_direccion ? { ubigeo: '', direccion: c.cliente_direccion } : null,
      items: items.map((i: Record<string, unknown>) => ({ productoId: i.producto_id == null ? null : Number(i.producto_id), codigo: (i.codigo as string | null) ?? null, descripcion: String(i.descripcion), unidad: String(i.unidad), cantidad: String(i.cantidad) })),
      advertencias,
      guiasPrevias: await db('guias').where('comprobante_id', c.id).whereIn('estado', GUIA_VIGENTE).whereNotNull('numero_completo').pluck('numero_completo'),
    };
  }
  if (origen.tipo === 'traslado') {
    const t = await trasladoOrigen(origen.trasladoId, sucursalId);
    const [destino, empresa, items] = await Promise.all([
      db('sucursales').where('id', t.sucursal_destino_id).first('direccion', 'ubigeo'),
      db('empresa').first('ruc', 'razon_social'),
      db('traslado_items as i').join('productos as p', 'p.id', 'i.producto_id').join('unidades as u', 'u.id', 'p.unidad_id').where('i.traslado_id', t.id).orderBy('i.id').select('i.producto_id', 'p.codigo', 'p.nombre', 'u.codigo_sunat', 'i.cantidad'),
    ]);
    if (!destino?.direccion || !destino?.ubigeo) advertencias.push('La sucursal de destino no tiene dirección o ubigeo.');
    return {
      origen,
      codTraslado: '04',
      destinatario: empresa ? { tipoDoc: '6', numDoc: empresa.ruc, razonSocial: empresa.razon_social } : null,
      partida,
      llegada: destino?.direccion && destino?.ubigeo ? { ubigeo: destino.ubigeo, direccion: destino.direccion } : null,
      items: items.map((i: Record<string, unknown>) => ({ productoId: Number(i.producto_id), codigo: String(i.codigo), descripcion: String(i.nombre), unidad: String(i.codigo_sunat), cantidad: String(i.cantidad) })),
      advertencias,
      guiasPrevias: await db('guias').where('traslado_id', t.id).whereIn('estado', GUIA_VIGENTE).whereNotNull('numero_completo').pluck('numero_completo'),
    };
  }
  return { origen, codTraslado: '01', destinatario: null, partida, llegada: null, items: [], advertencias, guiasPrevias: [] };
}

async function comprobanteOrigen(id: number, sucursalId: number, conn: Knex = db) {
  const c = await conn('comprobantes').where('id', id).first();
  if (!c) throw errores.noEncontrado('Comprobante');
  if (Number(c.sucursal_id) !== sucursalId) throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'El comprobante es de otra sucursal');
  if (!['01', '03'].includes(c.tipo_doc)) throw errores.validacion({ origen: 'La guía se emite desde una factura o boleta' });
  if (!c.numero_completo || ['rechazado', 'error_validacion', 'anulado', 'anulado_interno', 'anulacion_en_proceso'].includes(c.estado)) {
    throw new ErrorApp(409, 'ESTADO_NO_PERMITE', 'El comprobante no está vigente o aún no tiene número');
  }
  return c;
}

async function trasladoOrigen(id: number, sucursalId: number, conn: Knex = db) {
  const t = await conn('traslados').where('id', id).first();
  if (!t) throw errores.noEncontrado('Traslado');
  if (Number(t.sucursal_origen_id) !== sucursalId) throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'La guía del traslado la emite la sucursal de origen');
  if (t.estado === 'anulado') throw new ErrorApp(409, 'ESTADO_NO_PERMITE', 'El traslado está anulado');
  return t;
}

// ---------- Creación ----------

/** Series propias de guía (09) de la sucursal: no se comparte numeración con otros sistemas del RUC. */
export async function seriesGuia(sucursalId: number, conn: Knex = db): Promise<Array<{ id: number; serie: string; predeterminada: boolean }>> {
  const filas = await conn('series').where({ tipo_doc: '09', sucursal_id: sucursalId, activo: true, propia: true }).orderBy('serie').select('id', 'serie', 'predeterminada');
  return filas.map((f: Record<string, unknown>) => ({ id: Number(f.id), serie: String(f.serie), predeterminada: Boolean(f.predeterminada) }));
}

interface Resuelto {
  fila: Omit<FilaGuia, 'id' | 'estado' | 'api_id' | 'sunat_codigo' | 'sunat_descripcion' | 'ultimo_error' | 'intentos' | 'simulado' | 'idempotency_key' | 'created_at' | 'correlativo' | 'numero_completo'>;
  items: FilaItem[];
}

/** Valida contra las reglas de API-PRO y SUNAT y arma la fila de la guía con sus instantáneas. */
async function resolver(d: GuiaInput, sucursalId: number, conn: Knex): Promise<Resuelto> {
  const hoy = fechaLima();
  const campos: Record<string, string> = {};
  const empresa = await conn('empresa').first('ruc');
  if (!empresa) throw new ErrorApp(409, 'EMPRESA_NO_CONFIGURADA', 'Registra la empresa antes de emitir guías');
  if (d.fechaTraslado < hoy) campos.fechaTraslado = 'La fecha de traslado no puede ser anterior a hoy';
  const esPropia = d.destinatario.tipoDoc === '6' && d.destinatario.numDoc === empresa.ruc;
  if (MOTIVOS_DESTINO_PROPIO.includes(d.codTraslado) && !esPropia) campos['destinatario.numDoc'] = `Para este motivo el destinatario es la propia empresa (RUC ${empresa.ruc})`;
  if (MOTIVOS_DESTINO_AJENO.includes(d.codTraslado) && esPropia) campos['destinatario.numDoc'] = 'Para este motivo el destinatario no puede ser la propia empresa';

  const series = await seriesGuia(sucursalId, conn);
  const serie = d.serieId ? series.find((s) => s.id === d.serieId) : (series.find((s) => s.predeterminada) ?? (series.length === 1 ? series[0] : undefined));
  if (!serie) campos.serieId = series.length ? 'Elige la serie de la guía' : 'La sucursal no tiene una serie propia de guía de remisión (T###): créala en Configuración → Series';

  let transportista: Transportista | null = null;
  let vehiculo: Vehiculo | null = null;
  let conductores: Conductor[] = [];
  if (d.modTraslado === '01' && d.transportistaId) {
    const t = await conn('transportistas').where({ id: d.transportistaId, activo: true }).first();
    if (!t) campos.transportistaId = 'Transportista no encontrado o inactivo';
    else if (t.ruc === empresa.ruc) campos.transportistaId = 'En transporte público el transportista es otra empresa; si llevas tú la mercadería, usa transporte privado';
    else transportista = { id: Number(t.id), ruc: t.ruc, razon_social: t.razon_social, nro_mtc: t.nro_mtc ?? null };
  }
  if (d.modTraslado === '02' && d.vehiculoId) {
    const ids = [d.vehiculoId, ...d.vehiculosSecundariosIds];
    const filas = await conn('vehiculos').whereIn('id', ids).where('activo', true);
    const v = (id: number) => filas.find((f: { id: number }) => Number(f.id) === id);
    if (ids.some((id) => !v(id))) campos.vehiculoId = 'Vehículo no encontrado o inactivo';
    else {
      const a = (f: Record<string, unknown>) => ({ id: Number(f.id), placa: String(f.placa), nro_circulacion: (f.nro_circulacion as string | null) ?? null });
      vehiculo = { ...a(v(d.vehiculoId)), secundarios: d.vehiculosSecundariosIds.map((id) => a(v(id))) };
    }
  }
  if (d.modTraslado === '02' && d.conductoresIds.length) {
    const filas = await conn('conductores').whereIn('id', d.conductoresIds).where('activo', true);
    if (filas.length !== d.conductoresIds.length) campos.conductoresIds = 'Conductor no encontrado o inactivo';
    conductores = d.conductoresIds
      .map((id) => filas.find((f: { id: number }) => Number(f.id) === id))
      .filter(Boolean)
      .map((c: Record<string, unknown>, i: number) => ({ id: Number(c.id), tipo: i === 0 ? 'Principal' : 'Secundario', tipo_doc: String(c.tipo_doc), num_doc: String(c.num_doc), nombres: String(c.nombres), apellidos: String(c.apellidos), licencia: String(c.licencia) }));
  }

  let comprobanteId: number | null = null;
  let trasladoId: number | null = null;
  let docs: Array<{ tipo_codigo: string; numero: string }> = [];
  let partidaCodLocal: string | null = null;
  let llegadaCodLocal: string | null = null;
  const codLocal = async (id: number) => {
    const s = await conn('sucursales').where('id', id).first('cod_local', 'api_sucursal_id');
    return s?.api_sucursal_id ? (s.cod_local as string) : null;
  };
  if (d.origen.tipo === 'venta') {
    const c = await comprobanteOrigen(d.origen.comprobanteId, sucursalId, conn);
    comprobanteId = Number(c.id);
    docs = [{ tipo_codigo: c.tipo_doc, numero: c.numero_completo }];
  } else if (d.origen.tipo === 'traslado') {
    const t = await trasladoOrigen(d.origen.trasladoId, sucursalId, conn);
    trasladoId = Number(t.id);
    if (d.codTraslado !== '04') campos.codTraslado = 'Un traslado entre sucursales usa el motivo 04';
    llegadaCodLocal = await codLocal(Number(t.sucursal_destino_id));
  }
  if (d.codTraslado === '04') partidaCodLocal = await codLocal(sucursalId);

  const productos = d.items.filter((i) => i.productoId).map((i) => i.productoId!);
  if (productos.length) {
    const existen = await conn('productos').whereIn('id', productos).pluck('id');
    if (existen.length !== new Set(productos).size) campos.items = 'Algún producto no existe';
  }
  if (Object.keys(campos).length) throw errores.validacion(campos);

  return {
    fila: {
      sucursal_id: sucursalId,
      serie_id: Number(serie!.id),
      serie: serie!.serie,
      fecha_emision: hoy,
      origen_tipo: d.origen.tipo,
      comprobante_id: comprobanteId,
      traslado_id: trasladoId,
      destinatario_tipo_doc: d.destinatario.tipoDoc,
      destinatario_num_doc: d.destinatario.numDoc.toUpperCase(),
      destinatario_razon_social: d.destinatario.razonSocial,
      cod_traslado: d.codTraslado,
      mod_traslado: d.modTraslado,
      vehiculo_m1l: d.vehiculoM1l,
      fecha_traslado: d.fechaTraslado,
      fecha_entrega_transportista: d.modTraslado === '01' ? (d.fechaEntregaTransportista ?? null) : null,
      peso_total: d.pesoTotal,
      und_peso_total: 'KGM',
      num_bultos: d.numBultos ?? null,
      partida_ubigeo: d.partida.ubigeo,
      partida_direccion: d.partida.direccion,
      partida_cod_local: partidaCodLocal,
      llegada_ubigeo: d.llegada.ubigeo,
      llegada_direccion: d.llegada.direccion,
      llegada_cod_local: llegadaCodLocal,
      transportista,
      vehiculo,
      conductores,
      docs_relacionados: docs,
      observacion: d.observacion ?? null,
    },
    items: d.items.map((i) => ({ producto_id: i.productoId ?? null, codigo: i.codigo || null, descripcion: i.descripcion, unidad: i.unidad.toUpperCase(), cantidad: aCantidad(i.cantidad) })),
  };
}

const aColumnas = (f: Resuelto['fila']) => ({
  ...f,
  transportista: f.transportista ? JSON.stringify(f.transportista) : null,
  vehiculo: f.vehiculo ? JSON.stringify(f.vehiculo) : null,
  conductores: f.conductores?.length ? JSON.stringify(f.conductores) : null,
  docs_relacionados: f.docs_relacionados?.length ? JSON.stringify(f.docs_relacionados) : null,
});

export async function crear(d: GuiaInput, ctx: { sucursalId: number; usuarioId: number; idempotencyKey: string }): Promise<{ guia: GuiaDetalleDto; repetida: boolean }> {
  const previa = await db('guias').where('idempotency_key', ctx.idempotencyKey).first('id');
  if (previa) return { guia: await obtener(Number(previa.id)), repetida: true };
  const id = await db.transaction(async (trx) => {
    const r = await resolver(d, ctx.sucursalId, trx);
    const [id] = await trx('guias').insert({ ...aColumnas(r.fila), idempotency_key: ctx.idempotencyKey, creado_por: ctx.usuarioId });
    await trx('guia_items').insert(r.items.map((i) => ({ ...i, guia_id: id })));
    if (r.fila.traslado_id) await trx('traslados').where('id', r.fila.traslado_id).update({ guia_id: id });
    await encolar(trx, 'emitir_guia', 'guia', Number(id), { prioridad: 2 });
    return Number(id);
  });
  return { guia: await obtener(id), repetida: false };
}

// ---------- Emisión (worker) ----------

async function simular(g: FilaGuia): Promise<void> {
  await db.transaction(async (trx) => {
    await trx('series').where('id', g.serie_id).forUpdate().first('id');
    const [{ ultimo }] = (await trx('guias').where({ serie: g.serie, simulado: true }).max({ ultimo: 'correlativo' })) as [{ ultimo: number | null }];
    const correlativo = Number(ultimo ?? 0) + 1;
    await trx('guias')
      .where('id', g.id)
      .update({ simulado: true, correlativo, numero_completo: `${g.serie}-${correlativo}`, estado: 'aceptado', sunat_descripcion: 'Simulación: no se envió a SUNAT y no tiene validez' });
  });
}

interface GuiaApi { id: number; serie: string; correlativo: number; numero_completo: string; sunat: { estado: string; codigo: string | null; descripcion: string | null; ticket: string | null } }

function estadoDesdeApi(sunat: GuiaApi['sunat']): EstadoGuia {
  if (sunat.estado === 'aceptado') return 'aceptado';
  if (sunat.estado === 'rechazado') return 'rechazado';
  return 'en_proceso'; // pendiente o enviado: el job de API-PRO aún resuelve el ticket
}

async function guardarRemoto(id: number, doc: GuiaApi): Promise<EstadoGuia> {
  const estado = estadoDesdeApi(doc.sunat);
  await db('guias')
    .where('id', id)
    .update({ api_id: doc.id, correlativo: doc.correlativo, numero_completo: doc.numero_completo, ticket: doc.sunat.ticket ?? null, estado, sunat_codigo: doc.sunat.codigo == null ? null : String(doc.sunat.codigo), sunat_descripcion: doc.sunat.descripcion ?? null, ultimo_error: null });
  return estado;
}

export async function emitirGuia(trabajo: Trabajo): Promise<Resultado> {
  const g = await leer(trabajo.entidad_id);
  if (!g) return { estado: 'fallido', error: 'La guía no existe' };
  if (!['pendiente', 'por_verificar', 'enviando'].includes(g.estado)) return { estado: 'hecho' };
  const empresa = await db('empresa').first('modo_emision', 'ruc');
  if ((empresa?.modo_emision ?? 'simulacion') === 'simulacion') {
    await simular(g);
    return { estado: 'hecho' };
  }
  if (await pausaActiva()) return { estado: 'reintentar', reintentarEnSeg: 60, error: 'Emisión pausada' };

  const tomada = await db('guias')
    .where('id', g.id)
    .andWhere((q) => q.whereIn('estado', ['pendiente', 'por_verificar']).orWhere((w) => w.where('estado', 'enviando').andWhere('updated_at', '<', db.raw('CURRENT_TIMESTAMP(3) - INTERVAL ? SECOND', [LIBERAR_ENVIANDO_SEG]))))
    .update({ estado: 'enviando', intentos: db.raw('intentos + 1') });
  if (!tomada) return { estado: 'hecho' };

  const items = (await db('guia_items').where('guia_id', g.id).orderBy('id')) as FilaItem[];
  const ruta = '/guias-remision';
  const op = { cuerpo: construirPayloadGuia(g, items, empresa!.ruc), idempotencyKey: g.idempotency_key, emision: true };
  const ctx = { operacion: 'guia.emitir', entidadTipo: 'guia', entidadId: g.id };
  const espera = esperaReintento(g.intentos, ESPERAS_ENVIO);
  const marcar = (estado: EstadoGuia, error: string | null) => db('guias').where('id', g.id).update({ estado, ultimo_error: error?.slice(0, 2000) ?? null });

  let r: RespuestaJson<EnvelopeApiPro<GuiaApi>>;
  const inicio = Date.now();
  try {
    r = (await (await obtenerCliente()).llamar<EnvelopeApiPro<GuiaApi>>('POST', ruta, op)) as RespuestaJson<EnvelopeApiPro<GuiaApi>>;
  } catch (err) {
    await registrarIntento(ctx, 'POST', ruta, op, null, null, Date.now() - inicio, err instanceof Error ? err.message : String(err));
    if (err instanceof LlamadaProhibida) {
      await marcar('error_validacion', err.message);
      return { estado: 'fallido', error: err.message };
    }
    // Sin respuesta: se reintenta con la MISMA Idempotency-Key (no se duplica la guía).
    const mensaje = err instanceof ErrorRedApiPro ? err.message : 'Error de conexión';
    await marcar('por_verificar', mensaje);
    return { estado: 'reintentar', reintentarEnSeg: espera, error: mensaje };
  }
  await registrarIntento(ctx, 'POST', ruta, op, r.status, r.cuerpo, r.duracionMs, null);

  if (r.status >= 200 && r.status < 300 && r.cuerpo?.estado !== 'error') {
    const estado = await guardarRemoto(g.id, r.cuerpo.datos);
    if (estado === 'en_proceso') await encolar(db, 'reconciliar_guia', 'guia', g.id, { ejecutarEn: new Date(Date.now() + 15_000) });
    return { estado: 'hecho' };
  }
  if (r.status === 422) {
    const mensaje = mensajeValidacion(r.cuerpo);
    await db('guias').where('id', g.id).update({ estado: 'error_validacion', ultimo_error: mensaje, sunat_descripcion: mensaje });
    return { estado: 'hecho' };
  }
  const global = await manejarErrorGlobal(r.status, r.cuerpo, r.cabeceras);
  if (global) {
    await db('guias').where('id', g.id).update({ estado: 'pendiente', intentos: db.raw('GREATEST(intentos - 1, 0)'), ultimo_error: mensajeValidacion(r.cuerpo) });
    return { estado: 'reintentar', reintentarEnSeg: global.esperaSeg, error: `HTTP ${r.status}` };
  }
  await marcar('por_verificar', `API-PRO respondió HTTP ${r.status}: ${mensajeValidacion(r.cuerpo)}`);
  return { estado: 'reintentar', reintentarEnSeg: r.status === 409 ? 20 : espera, error: `HTTP ${r.status}` };
}

/** Lee GET /guias-remision/{id} (solo la BD de API-PRO) hasta que el ticket se resuelva. */
export async function reconciliarGuia(trabajo: Trabajo): Promise<Resultado> {
  const g = await leer(trabajo.entidad_id);
  if (!g?.api_id) return { estado: 'fallido', error: 'La guía no está en API-PRO' };
  if (g.estado === 'aceptado') return { estado: 'hecho' };
  if (await pausaActiva()) return { estado: 'reintentar', reintentarEnSeg: 60, error: 'Emisión pausada' };
  const ruta = `/guias-remision/${g.api_id}`;
  const ctx = { operacion: 'guia.consultar', entidadTipo: 'guia', entidadId: g.id };
  const espera = esperaReintento(trabajo.intentos, ESPERAS_CONSULTA);
  const inicio = Date.now();
  let r: RespuestaJson<EnvelopeApiPro<GuiaApi>>;
  try {
    r = (await (await obtenerCliente()).llamar<EnvelopeApiPro<GuiaApi>>('GET', ruta)) as RespuestaJson<EnvelopeApiPro<GuiaApi>>;
  } catch (err) {
    await registrarIntento(ctx, 'GET', ruta, {}, null, null, Date.now() - inicio, err instanceof Error ? err.message : String(err));
    return { estado: 'reintentar', reintentarEnSeg: espera, error: 'Sin conexión con API-PRO' };
  }
  await registrarIntento(ctx, 'GET', ruta, {}, r.status, r.cuerpo, r.duracionMs, null);
  if (r.status === 200 && r.cuerpo?.estado !== 'error') {
    const estado = await guardarRemoto(g.id, r.cuerpo.datos);
    if (estado !== 'en_proceso') return { estado: 'hecho' };
    // Se agotó la tabla de esperas: queda "sin respuesta" y se consulta a pedido.
    if (trabajo.intentos >= ESPERAS_CONSULTA.length) {
      await db('guias').where('id', g.id).update({ estado: 'sin_respuesta_sunat' });
      return { estado: 'hecho' };
    }
    return { estado: 'reintentar', reintentarEnSeg: espera };
  }
  const global = await manejarErrorGlobal(r.status, r.cuerpo, r.cabeceras);
  if (global) return { estado: 'reintentar', reintentarEnSeg: global.esperaSeg, error: `HTTP ${r.status}` };
  if (r.status === 404) return { estado: 'fallido', error: 'API-PRO no encuentra la guía' };
  return { estado: 'reintentar', reintentarEnSeg: espera, error: `HTTP ${r.status}` };
}

// ---------- Acciones manuales ----------

async function exigirAccion(id: number, accion: AccionGuia): Promise<GuiaDetalleDto> {
  const d = await obtener(id);
  if (!d.acciones.includes(accion)) throw new ErrorApp(409, 'ESTADO_NO_PERMITE', `Esta acción no está disponible en el estado "${d.estado}"`);
  return d;
}

/** Leer el estado remoto antes de reenviar o editar (guarda B2). */
async function estadoRemoto(g: FilaGuia): Promise<string> {
  const { datos } = await llamarJson<GuiaApi>(await obtenerCliente(), 'GET', `/guias-remision/${g.api_id}`, { operacion: 'guia.consultar', entidadTipo: 'guia', entidadId: g.id });
  return datos.sunat.estado;
}

export async function reintentar(id: number): Promise<GuiaDetalleDto> {
  await exigirAccion(id, 'reintentar');
  const g = (await leer(id))!;
  if (!g.api_id) {
    await encolar(db, 'emitir_guia', 'guia', id, { prioridad: 1 });
    await db('outbox_trabajos').where({ tipo: 'emitir_guia', entidad_tipo: 'guia', entidad_id: id }).whereIn('estado', ['pendiente', 'pausado']).update({ ejecutar_en: db.raw('CURRENT_TIMESTAMP(3)'), estado: 'pendiente' });
    return obtener(id);
  }
  const remoto = await estadoRemoto(g);
  if (!puedeEnviar(remoto)) throw new ErrorApp(409, 'ESTADO_NO_PERMITE', `En API-PRO la guía está "${remoto}": no se puede reenviar`);
  await llamarJson(await obtenerCliente(), 'POST', `/guias-remision/${g.api_id}/enviar`, { operacion: 'guia.reenviar', entidadTipo: 'guia', entidadId: id });
  await db('guias').where('id', id).update({ estado: 'en_proceso', ultimo_error: null });
  await encolar(db, 'reconciliar_guia', 'guia', id, { ejecutarEn: new Date(Date.now() + 15_000) });
  return obtener(id);
}

export async function consultar(id: number): Promise<GuiaDetalleDto> {
  await exigirAccion(id, 'consultar');
  await db('guias').where({ id, estado: 'sin_respuesta_sunat' }).update({ estado: 'en_proceso' });
  await encolar(db, 'reconciliar_guia', 'guia', id);
  await db('outbox_trabajos').where({ tipo: 'reconciliar_guia', entidad_tipo: 'guia', entidad_id: id }).whereIn('estado', ['pendiente', 'pausado']).update({ ejecutar_en: db.raw('CURRENT_TIMESTAMP(3)'), estado: 'pendiente' });
  return obtener(id);
}

/**
 * Corrige una guía con error o rechazada con los datos completos del formulario.
 *  - error_validacion (no existe en API-PRO): Idempotency-Key nueva y nueva emisión.
 *  - rechazado (existe en API-PRO): PUT /guias-remision/{id} con el payload completo; API-PRO la reenvía.
 */
export async function corregir(id: number, d: GuiaInput): Promise<GuiaDetalleDto> {
  const actual = await exigirAccion(id, 'corregir');
  const g = (await leer(id))!;
  const r = await resolver({ ...d, origen: d.origen.tipo === actual.origen.tipo ? d.origen : (aOrigen(actual) as GuiaInput['origen']) }, Number(g.sucursal_id), db);
  // La serie no cambia: el número ya puede estar reservado en API-PRO.
  const fila = { ...aColumnas(r.fila), serie_id: g.serie_id, serie: g.serie };
  if (g.api_id) {
    const remoto = await estadoRemoto(g);
    if (!puedeEnviar(remoto)) throw new ErrorApp(409, 'ESTADO_NO_PERMITE', `En API-PRO la guía está "${remoto}": no se puede corregir`);
    const empresa = await db('empresa').first('ruc');
    const payload = construirPayloadGuia({ ...g, ...r.fila, serie_id: g.serie_id, serie: g.serie, fecha_emision: g.fecha_emision }, r.items, empresa.ruc);
    await llamarJson(await obtenerCliente(), 'PUT', `/guias-remision/${g.api_id}`, { operacion: 'guia.corregir', entidadTipo: 'guia', entidadId: id }, { cuerpo: payload, emision: true, idempotencyKey: randomUUID() });
  }
  await db.transaction(async (trx) => {
    await trx('guias').where('id', id).update({ ...fila, fecha_emision: g.api_id ? g.fecha_emision : fila.fecha_emision, estado: g.api_id ? 'en_proceso' : 'pendiente', ultimo_error: null, sunat_descripcion: null, ...(g.api_id ? {} : { idempotency_key: randomUUID(), intentos: 0 }) });
    await trx('guia_items').where('guia_id', id).delete();
    await trx('guia_items').insert(r.items.map((i) => ({ ...i, guia_id: id })));
    if (g.api_id) await encolar(trx, 'reconciliar_guia', 'guia', id, { ejecutarEn: new Date(Date.now() + 15_000) });
    else await encolar(trx, 'emitir_guia', 'guia', id, { prioridad: 1 });
  });
  return obtener(id);
}

const aOrigen = (d: GuiaDetalleDto) =>
  d.origen.tipo === 'venta' ? { tipo: 'venta', comprobanteId: d.origen.comprobanteId } : d.origen.tipo === 'traslado' ? { tipo: 'traslado', trasladoId: d.origen.trasladoId } : { tipo: 'manual' };

// ---------- Archivos (proxy con caché) ----------

export async function archivo(id: number, que: 'pdf' | 'xml' | 'cdr', formato: 'a4' | 'a5' | 'ticket-80' | 'ticket-58' = 'a4'): Promise<{ datos: Buffer; contentType: string; nombre: string }> {
  const d = await obtener(id);
  if (d.simulado) throw new ErrorApp(409, 'GUIA_SIMULADA', 'Las guías simuladas no tienen archivos de SUNAT');
  if (!d.acciones.includes(que)) throw new ErrorApp(409, 'ARCHIVO_NO_DISPONIBLE', `El ${que.toUpperCase()} aún no está disponible`);
  const g = (await leer(id))!;
  const tipo = que === 'pdf' ? ({ a4: 'pdf_a4', a5: 'pdf_a5', 'ticket-80': 'pdf_t80', 'ticket-58': 'pdf_t58' } as const)[formato] : que;
  const nombre = `${d.numeroCompleto ?? `guia-${id}`}${que === 'pdf' ? `-${formato}.pdf` : que === 'xml' ? '.xml' : '-cdr.zip'}`;
  const cache = await db('archivos_cpe').where({ entidad_tipo: 'guia', entidad_id: id, tipo }).first();
  if (cache) {
    try {
      return { datos: await readFile(cache.ruta), contentType: cache.content_type, nombre };
    } catch {
      await db('archivos_cpe').where('id', cache.id).delete();
    }
  }
  const ruta = `/guias-remision/${g.api_id}/${que}${que === 'pdf' ? `?format=${formato}` : ''}`;
  const inicio = Date.now();
  const r = (await (await obtenerCliente()).llamar('GET', ruta, { binario: true })) as RespuestaBinaria | RespuestaJson<{ mensaje?: string }>;
  await registrarIntento({ operacion: `guia.${que}`, entidadTipo: 'guia', entidadId: id }, 'GET', ruta, {}, r.status, r.tipo === 'json' ? r.cuerpo : { bytes: r.datos.length }, Date.now() - inicio, null);
  if (r.tipo === 'json' || r.status !== 200) {
    const mensaje = r.tipo === 'json' ? r.cuerpo?.mensaje : `HTTP ${r.status}`;
    throw new ErrorApp(r.status === 404 ? 404 : 502, 'ARCHIVO_NO_DISPONIBLE', `API-PRO: ${mensaje ?? 'archivo no disponible'}`);
  }
  if (d.estado === 'aceptado') {
    await mkdir(DIR_ARCHIVOS, { recursive: true });
    const destino = path.join(DIR_ARCHIVOS, `guia-${id}-${tipo}.bin`);
    await writeFile(destino, r.datos);
    await db('archivos_cpe')
      .insert({ entidad_tipo: 'guia', entidad_id: id, tipo, ruta: destino, content_type: r.contentType, sha256: createHash('sha256').update(r.datos).digest('hex'), bytes: r.datos.length })
      .onConflict(['entidad_tipo', 'entidad_id', 'tipo'])
      .merge();
  }
  return { datos: r.datos, contentType: r.contentType, nombre };
}
