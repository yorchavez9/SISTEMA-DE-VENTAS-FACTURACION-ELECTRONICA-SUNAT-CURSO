import type { PendientesResumenDto, ResumenDto, VerificacionResumenDto } from '@sv/shared';
import { randomUUID } from 'node:crypto';
import { db } from '../../database/db.js';
import { puedeEnviar } from '../../integrations/apiPro/guardas.js';
import { llamarJson } from '../../integrations/apiPro/llamada.js';
import { obtenerCliente } from '../../integrations/apiPro/proveedor.js';
import { encolar, type Resultado, type Trabajo } from '../../jobs/outbox.js';
import { aImporte, dec } from '../../shared/decimal.js';
import { ErrorApp, errores } from '../../shared/errors.js';
import { fechaLima } from '../../shared/fechas.js';
import { ESPERAS_CONSULTA, esperaReintento, type DocumentoApi } from './contrato.js';
import { aplicarResultadoResumenAnulacion } from './anulaciones.service.js';
import { pausaActiva } from './pausa.js';

const PLAZO_DIAS = 7;

const sumarDias = (f: string, dias: number) => {
  const d = new Date(`${f}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

/** Boletas "para resumen" agrupadas por fecha de emisión (el RC es por empresa y fecha). */
export async function pendientes(): Promise<PendientesResumenDto[]> {
  const hoy = fechaLima();
  const filas = (await db('comprobantes').where({ tipo_doc: '03', estado: 'pendiente_resumen' }).groupBy('fecha_emision').orderBy('fecha_emision').select('fecha_emision').count({ n: '*' }).sum({ total: 'total' })) as unknown as Array<{ fecha_emision: string; n: number; total: string }>;
  return filas.map((f) => {
    const plazo = sumarDias(f.fecha_emision, PLAZO_DIAS);
    return { fecha: f.fecha_emision, boletas: Number(f.n), total: aImporte(f.total), plazoHasta: plazo, vencido: plazo < hoy };
  });
}

interface BoletaApi {
  id: number;
  numero_completo: string;
  cliente?: { razon_social?: string };
}

/**
 * Comprobación previa obligatoria: API-PRO incluirá en el RC todas las boletas pendientes del RUC
 * en esa fecha, también las de otros sistemas. Si aparece alguna ajena, no se envía.
 */
export async function verificar(fecha: string): Promise<VerificacionResumenDto> {
  const locales = await db('comprobantes').where({ tipo_doc: '03', fecha_emision: fecha, simulado: false }).whereNotNull('api_id').select('api_id', 'estado', 'numero_completo');
  const nuestros = new Set(locales.map((l: { api_id: number | string }) => Number(l.api_id)));
  const paraResumen = locales.filter((l: { estado: string }) => l.estado === 'pendiente_resumen');

  const cliente = await obtenerCliente();
  const remotos: BoletaApi[] = [];
  for (let pagina = 1; pagina <= 50; pagina++) {
    const { datos } = await llamarJson<{ datos: BoletaApi[]; paginacion: { ultima_pagina: number } }>(
      cliente, 'GET', `/boletas?fecha_desde=${fecha}&fecha_hasta=${fecha}&sunat_status=pendiente&por_pagina=100&page=${pagina}`, { operacion: 'resumen.verificar' },
    );
    remotos.push(...datos.datos);
    if (pagina >= datos.paginacion.ultima_pagina) break;
  }
  const idsRemotos = new Set(remotos.map((r) => r.id));
  const ajenas = remotos.filter((r) => !nuestros.has(r.id)).map((r) => ({ apiId: r.id, numero: r.numero_completo, cliente: r.cliente?.razon_social ?? null }));
  const noEncontradas = paraResumen.filter((l: { api_id: number | string }) => !idsRemotos.has(Number(l.api_id))).map((l: { numero_completo: string }) => l.numero_completo);
  const propias = remotos.length - ajenas.length;
  return { fecha, propias, ajenas, noEncontradas, puedeEnviar: ajenas.length === 0 && propias > 0 };
}

export async function obtener(id: number): Promise<ResumenDto> {
  const r = await db('resumenes as r').leftJoin('usuarios as u', 'u.id', 'r.creado_por').where('r.id', id).first('r.*', 'u.nombre as creado_por_nombre');
  if (!r) throw errores.noEncontrado('Resumen');
  const [{ n }] = (await db('resumen_documentos').where('resumen_id', id).count({ n: '*' })) as [{ n: number }];
  return {
    id: Number(r.id),
    tipo: r.tipo,
    fechaResumen: r.fecha_resumen,
    identifier: r.identifier ?? null,
    estado: r.estado,
    incidente: Boolean(r.incidente),
    simulado: Boolean(r.simulado),
    documentos: Number(n),
    bloqueo: r.bloqueo_detalle ?? null,
    sunatDescripcion: r.sunat_descripcion ?? null,
    ultimoError: r.ultimo_error ?? null,
    creadoEn: new Date(r.created_at).toISOString(),
    creadoPor: r.creado_por_nombre ?? null,
  };
}

export async function listar(): Promise<ResumenDto[]> {
  const ids = await db('resumenes').where('tipo', 'envio').orderBy('id', 'desc').limit(60).pluck('id');
  return Promise.all(ids.map((id: number | string) => obtener(Number(id))));
}

/**
 * Envía el RC de una fecha. Reutiliza la Idempotency-Key de un intento anterior que falló sin
 * respuesta (si API-PRO sí lo creó, devuelve el mismo RC en lugar de crear otro).
 */
export async function enviar(fecha: string, ctx: { usuarioId: number | null }): Promise<ResumenDto> {
  const hoy = fechaLima();
  if (fecha > hoy || fecha < sumarDias(hoy, -PLAZO_DIAS)) {
    throw errores.validacion({ fecha: `API-PRO solo acepta resúmenes de los últimos ${PLAZO_DIAS} días` });
  }
  const empresa = await db('empresa').first('modo_emision');
  const simulado = (empresa?.modo_emision ?? 'simulacion') === 'simulacion';

  const previoFallido = await db('resumenes').where({ fecha_resumen: fecha, tipo: 'envio', estado: 'error' }).whereNull('api_id').orderBy('id', 'desc').first('id');
  let id: number;
  try {
    if (previoFallido) {
      id = Number(previoFallido.id);
      await db('resumenes').where('id', id).update({ estado: 'verificando', ultimo_error: null, bloqueo_detalle: null });
    } else {
      [id] = (await db('resumenes').insert({ tipo: 'envio', fecha_resumen: fecha, simulado, idempotency_key: randomUUID(), creado_por: ctx.usuarioId })) as [number];
      id = Number(id);
    }
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') throw new ErrorApp(409, 'RESUMEN_EN_CURSO', `Ya hay un resumen en curso para el ${fecha}`);
    throw err;
  }

  try {
    if (simulado) {
      const boletas = await db('comprobantes').where({ tipo_doc: '03', estado: 'pendiente_resumen', fecha_emision: fecha }).pluck('id');
      if (!boletas.length) throw errores.validacion({ fecha: 'No hay boletas para resumen en esa fecha' });
      await db.transaction(async (trx) => {
        await trx('resumen_documentos').insert(boletas.map((c: number) => ({ resumen_id: id, comprobante_id: c })));
        await trx('comprobantes').whereIn('id', boletas).update({ estado: 'aceptado', sunat_descripcion: 'Simulación: declarada en resumen simulado' });
        await trx('resumenes').where('id', id).update({ estado: 'aceptado', identifier: `SIM-RC-${fecha.replaceAll('-', '')}-${id}` });
      });
      return obtener(id);
    }

    const v = await verificar(fecha);
    if (v.ajenas.length) {
      await db('resumenes').where('id', id).update({ estado: 'bloqueado', bloqueo_detalle: JSON.stringify(v) });
      throw new ErrorApp(409, 'RESUMEN_BLOQUEADO_BOLETAS_AJENAS', `El resumen incluiría ${v.ajenas.length} boleta(s) de otro sistema; no se envió`, undefined, { resumenId: id, verificacion: v });
    }
    if (!v.propias) {
      await db('resumenes').where('id', id).update({ estado: 'error', ultimo_error: 'No hay boletas pendientes en API-PRO para esa fecha' });
      throw errores.validacion({ fecha: 'No hay boletas pendientes en API-PRO para esa fecha' });
    }

    const r = await db('resumenes').where('id', id).first('idempotency_key');
    const { datos } = await llamarJson<{ id_resumen: number; identifier: string; documentos: Array<{ id: number }>; estado_sunat: string }>(
      await obtenerCliente(), 'POST', '/resumenes', { operacion: 'resumen.enviar', entidadTipo: 'resumen', entidadId: id },
      { cuerpo: { fecha_resumen: fecha }, idempotencyKey: r.idempotency_key },
    );

    // Verificación posterior: el RC real debe contener solo boletas nuestras.
    const incluidas = datos.documentos.map((d) => d.id);
    const locales = await db('comprobantes').where('tipo_doc', '03').whereIn('api_id', incluidas).select('id', 'api_id');
    const incidente = locales.length !== incluidas.length;
    await db.transaction(async (trx) => {
      if (locales.length) {
        await trx('resumen_documentos').insert(locales.map((l: { id: number }) => ({ resumen_id: id, comprobante_id: l.id }))).onConflict().ignore();
        await trx('comprobantes').whereIn('id', locales.map((l: { id: number }) => l.id)).update({ estado: 'en_resumen' });
      }
      await trx('resumenes').where('id', id).update({ api_id: datos.id_resumen, identifier: datos.identifier, estado: 'enviado', incidente, documentos_api: JSON.stringify(datos.documentos) });
      await encolar(trx, 'reconciliar_resumen', 'resumen', id, { ejecutarEn: new Date(Date.now() + 10_000) });
    });
    return obtener(id);
  } catch (err) {
    const actual = await db('resumenes').where('id', id).first('estado');
    if (actual?.estado === 'verificando') {
      await db('resumenes').where('id', id).update({ estado: 'error', ultimo_error: err instanceof Error ? err.message.slice(0, 2000) : String(err) });
    }
    throw err;
  }
}

/** Consulta el estado del RC (GET /resumenes/{id}/estado lee la BD de API-PRO; es seguro). */
export async function reconciliarResumen(trabajo: Trabajo): Promise<Resultado> {
  const r = await db('resumenes').where('id', trabajo.entidad_id).first();
  if (!r?.api_id) return { estado: 'fallido', error: 'El resumen no está en API-PRO' };
  if (['aceptado', 'rechazado'].includes(r.estado)) return { estado: 'hecho' };
  if (await pausaActiva()) return { estado: 'reintentar', reintentarEnSeg: 60 };
  const espera = esperaReintento(trabajo.intentos, ESPERAS_CONSULTA);

  let datos: { estado_sunat: string; codigo_sunat: string | null; descripcion_sunat: string | null; documentos: Array<{ id: number; estado_sunat: string }> };
  try {
    ({ datos } = await llamarJson<typeof datos>(await obtenerCliente(), 'GET', `/resumenes/${r.api_id}/estado`, { operacion: 'resumen.consultar', entidadTipo: 'resumen', entidadId: r.id }));
  } catch {
    return { estado: 'reintentar', reintentarEnSeg: espera };
  }
  if (!['aceptado', 'rechazado'].includes(datos.estado_sunat)) return { estado: 'reintentar', reintentarEnSeg: espera };

  await db.transaction(async (trx) => {
    if (r.tipo === 'anulacion') {
      // RC de anulación: aceptado → boletas anuladas (con sus efectos); rechazado → siguen válidas.
      await aplicarResultadoResumenAnulacion(trx, Number(r.id), datos.estado_sunat === 'aceptado', datos.descripcion_sunat);
      await trx('resumenes').where('id', r.id).update({ estado: datos.estado_sunat, sunat_codigo: datos.codigo_sunat, sunat_descripcion: datos.descripcion_sunat });
      return;
    }
    for (const d of datos.documentos) {
      const estado = d.estado_sunat === 'aceptado' ? 'aceptado' : d.estado_sunat === 'rechazado' ? 'rechazado' : null;
      if (!estado) continue;
      await trx('comprobantes').where({ tipo_doc: '03', api_id: d.id }).update({ estado, sunat_descripcion: `${datos.descripcion_sunat ?? ''} (resumen ${r.identifier})`.trim() });
    }
    await trx('resumenes').where('id', r.id).update({ estado: datos.estado_sunat, sunat_codigo: datos.codigo_sunat, sunat_descripcion: datos.descripcion_sunat });
  });
  return { estado: 'hecho' };
}

/**
 * Respaldo cuando el RC queda bloqueado por boletas ajenas: envía las boletas propias una por una
 * (POST /boletas/{id}/enviar), solo si en API-PRO siguen "pendiente".
 */
export async function enviarIndividual(ids: number[]): Promise<{ enviadas: number; omitidas: string[] }> {
  const filas = await db('comprobantes').whereIn('id', ids).where({ tipo_doc: '03', estado: 'pendiente_resumen' });
  const omitidas = ids.filter((id) => !filas.some((f: { id: number | string }) => Number(f.id) === id)).map((id) => `Comprobante ${id}: no está pendiente de resumen`);
  let enviadas = 0;
  const cliente = await obtenerCliente();
  for (const c of filas) {
    if (c.simulado) {
      await db('comprobantes').where('id', c.id).update({ estado: 'aceptado', modo_envio: 'individual' });
      enviadas++;
      continue;
    }
    const ctx = { operacion: 'boleta.enviar_individual', entidadTipo: 'comprobante', entidadId: Number(c.id) };
    const { datos } = await llamarJson<DocumentoApi>(cliente, 'GET', `/boletas/${c.api_id}`, ctx);
    if (!puedeEnviar(datos.sunat.estado)) {
      omitidas.push(`${c.numero_completo}: en API-PRO está "${datos.sunat.estado}"`);
      continue;
    }
    await llamarJson(cliente, 'POST', `/boletas/${c.api_id}/enviar`, ctx);
    await db('comprobantes').where('id', c.id).update({ estado: 'en_proceso', modo_envio: 'individual' });
    await encolar(db, 'reconciliar_comprobante', 'comprobante', Number(c.id), { ejecutarEn: new Date(Date.now() + 5000) });
    enviadas++;
  }
  return { enviadas, omitidas };
}

/**
 * Envío automático (lo llama el worker cada minuto): fechas anteriores con boletas pendientes se
 * envían de inmediato; la de hoy, a partir de la hora de resumen más temprana de las sucursales.
 * Un bloqueo por boletas ajenas espera 1 hora antes de volver a intentarse.
 */
export async function envioProgramado(ahora = new Date()): Promise<void> {
  if (await pausaActiva()) return;
  const hoy = fechaLima(ahora);
  const horaLima = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false }).format(ahora);
  const sucursal = await db('sucursales').where('activo', true).min({ hora: 'hora_resumen' }).first();
  const horaResumen = String(sucursal?.hora ?? '23:00:00').slice(0, 5);

  for (const p of await pendientes()) {
    if (p.vencido) continue; // fuera de plazo: requiere acción manual
    if (p.fecha === hoy && horaLima < horaResumen) continue;
    const reciente = await db('resumenes')
      .where({ fecha_resumen: p.fecha, tipo: 'envio' })
      .andWhere((q) => q.whereIn('estado', ['verificando', 'enviado']).orWhere((w) => w.whereIn('estado', ['bloqueado', 'error']).andWhere('updated_at', '>', db.raw('CURRENT_TIMESTAMP(3) - INTERVAL 1 HOUR'))))
      .first('id');
    if (reciente) continue;
    await enviar(p.fecha, { usuarioId: null }).catch(() => undefined); // el resultado queda registrado en el resumen
  }
}

export async function totalPendienteResumen(): Promise<string> {
  const [{ total }] = (await db('comprobantes').where({ tipo_doc: '03', estado: 'pendiente_resumen' }).sum({ total: 'total' })) as [{ total: string | null }];
  return aImporte(dec(total));
}
