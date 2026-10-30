import type { EstadoComprobante } from '@sv/shared';
import { db } from '../../database/db.js';
import { ErrorRedApiPro, type RespuestaJson } from '../../integrations/apiPro/cliente.js';
import { LlamadaProhibida } from '../../integrations/apiPro/guardas.js';
import { registrar as registrarIntento, type EnvelopeApiPro } from '../../integrations/apiPro/llamada.js';
import { obtenerCliente } from '../../integrations/apiPro/proveedor.js';
import { encolar, manejadores, type Resultado, type Trabajo } from '../../jobs/outbox.js';
import {
  construirPayload, construirPayloadNota, ESPERAS_CONSULTA, ESPERAS_ENVIO, ESTADOS_FINALES, esperaReintento, estadoLocal, mensajeValidacion, RECURSO_API,
  type DocumentoApi,
} from './contrato.js';
import { pausaActiva, pausar } from './pausa.js';
import { enviarAnulacion, reconciliarBaja } from './anulaciones.service.js';
import { reconciliarResumen } from './resumenes.service.js';
import { emitirGuia, reconciliarGuia } from '../guias/guias.service.js';

// Emisión asíncrona de facturas y boletas (ADR-10 y ADR-11). Cada comprobante tiene su propia
// Idempotency-Key: reenviar tras un timeout o un 5xx nunca crea un segundo comprobante en API-PRO.

interface FilaComprobante {
  id: number;
  tipo_doc: string;
  serie: string;
  serie_id: number;
  sucursal_id: number;
  fecha_emision: string;
  moneda: string;
  forma_pago: 'contado' | 'credito';
  modo_envio: 'individual' | 'resumen';
  estado: EstadoComprobante;
  api_id: number | null;
  idempotency_key: string;
  intentos: number;
  cliente_tipo_doc: string;
  cliente_num_doc: string;
  cliente_razon_social: string;
  cliente_direccion: string | null;
  cliente_email: string | null;
}

const LIBERAR_ENVIANDO_SEG = 120;

async function guardarDocumento(id: number, doc: DocumentoApi, modo: 'individual' | 'resumen'): Promise<EstadoComprobante> {
  const estado = estadoLocal(doc.sunat, modo);
  await db('comprobantes')
    .where('id', id)
    .update({
      api_id: doc.id,
      correlativo: doc.correlativo,
      numero_completo: doc.numero_completo,
      total_api: doc.totales?.total ?? null,
      estado,
      sunat_codigo: doc.sunat.codigo == null ? null : String(doc.sunat.codigo),
      sunat_descripcion: doc.sunat.descripcion ?? null,
      sunat_notas: doc.sunat.notas == null ? null : JSON.stringify(doc.sunat.notas),
      hash_cpe: doc.sunat.hash_cpe ?? null,
      ultimo_error: null,
      proximo_intento_en: null,
    });
  return estado;
}

async function marcar(id: number, estado: EstadoComprobante, error: string | null, proximoSeg?: number): Promise<void> {
  await db('comprobantes')
    .where('id', id)
    .update({
      estado,
      ultimo_error: error?.slice(0, 2000) ?? null,
      proximo_intento_en: proximoSeg ? db.raw('CURRENT_TIMESTAMP(3) + INTERVAL ? SECOND', [proximoSeg]) : null,
    });
}

/**
 * Errores que afectan a toda la empresa (credenciales, licencia, cupo): se pausa la emisión y el
 * comprobante vuelve a la cola sin consumir reintentos propios.
 */
export async function manejarErrorGlobal(status: number, cuerpo: EnvelopeApiPro<unknown> | null, cabeceras: Headers): Promise<{ pausado: boolean; esperaSeg: number } | null> {
  if (status === 401) {
    await pausar('APIPRO_CREDENCIALES', 'API-PRO rechazó las credenciales');
    return { pausado: true, esperaSeg: 60 };
  }
  if (status === 403) {
    await pausar(cuerpo?.codigo_error ?? 'APIPRO_PROHIBIDO', mensajeValidacion(cuerpo));
    return { pausado: true, esperaSeg: 60 };
  }
  if (status === 429) {
    if (cuerpo?.codigo_error) {
      await pausar(cuerpo.codigo_error, mensajeValidacion(cuerpo)); // cupo mensual agotado
      return { pausado: true, esperaSeg: 60 };
    }
    const retry = Number(cabeceras.get('Retry-After'));
    return { pausado: false, esperaSeg: Number.isFinite(retry) && retry > 0 ? retry : 60 };
  }
  return null;
}

/** Modo simulación: numeración local, sin red. El comprobante queda marcado como simulado. */
async function simular(c: FilaComprobante): Promise<void> {
  await db.transaction(async (trx) => {
    await trx('series').where('id', c.serie_id).forUpdate().first('id');
    const [{ ultimo }] = (await trx('comprobantes').where({ serie: c.serie, simulado: true }).max({ ultimo: 'correlativo' })) as [{ ultimo: number | null }];
    const correlativo = Number(ultimo ?? 0) + 1;
    await trx('comprobantes')
      .where('id', c.id)
      .whereIn('estado', ['pendiente', 'por_verificar', 'enviando'])
      .update({
        simulado: true,
        correlativo,
        numero_completo: `${c.serie}-${String(correlativo).padStart(6, '0')}`,
        estado: c.tipo_doc === '03' && c.modo_envio === 'resumen' ? 'pendiente_resumen' : 'aceptado',
        sunat_descripcion: 'Simulación: no se envió a SUNAT y no tiene validez tributaria',
      });
  });
}

export async function emitirComprobante(trabajo: Trabajo): Promise<Resultado> {
  const c = (await db('comprobantes').where('id', trabajo.entidad_id).first()) as FilaComprobante | undefined;
  if (!c) return { estado: 'fallido', error: 'El comprobante no existe' };
  if (!['pendiente', 'por_verificar', 'enviando'].includes(c.estado)) return { estado: 'hecho' };

  // Notas: datos del comprobante afectado (debe existir en SUNAT, salvo que se haya simulado).
  const nota = ['07', '08'].includes(c.tipo_doc)
    ? await db('notas as n')
        .join('comprobantes as a', 'a.id', 'n.comprobante_afectado_id')
        .where('n.comprobante_id', c.id)
        .first('n.cod_motivo', 'n.des_motivo', 'a.tipo_doc', 'a.serie', 'a.correlativo', 'a.simulado')
    : null;

  const empresa = await db('empresa').first('modo_emision');
  // Una nota sobre un comprobante simulado se simula también: SUNAT no conoce el documento afectado.
  if ((empresa?.modo_emision ?? 'simulacion') === 'simulacion' || nota?.simulado) {
    await simular(c);
    return { estado: 'hecho' };
  }
  if (await pausaActiva()) return { estado: 'reintentar', reintentarEnSeg: 60, error: 'Emisión pausada' };

  // Toma exclusiva: solo un worker envía el comprobante (un "enviando" abandonado se libera).
  const tomado = await db('comprobantes')
    .where('id', c.id)
    .andWhere((q) =>
      q.whereIn('estado', ['pendiente', 'por_verificar']).orWhere((w) => w.where('estado', 'enviando').andWhere('updated_at', '<', db.raw('CURRENT_TIMESTAMP(3) - INTERVAL ? SECOND', [LIBERAR_ENVIANDO_SEG]))),
    )
    .update({ estado: 'enviando', intentos: db.raw('intentos + 1') });
  if (!tomado) return { estado: 'hecho' };

  const [items, cuotas, sucursal] = await Promise.all([
    db('comprobante_items').where('comprobante_id', c.id).orderBy('id').select('codigo', 'descripcion', 'unidad', 'tip_afe_igv', 'cantidad', 'precio_unitario'),
    db('comprobante_cuotas').where('comprobante_id', c.id).orderBy('numero').select('monto', 'fecha_pago'),
    db('sucursales').where('id', c.sucursal_id).first('cod_local', 'api_sucursal_id'),
  ]);
  const codLocal = sucursal?.api_sucursal_id ? sucursal.cod_local : null;
  const payload = nota
    ? construirPayloadNota(c, items, { cod_motivo: nota.cod_motivo, des_motivo: nota.des_motivo, afectado: { tipo_doc: nota.tipo_doc, serie: nota.serie, correlativo: Number(nota.correlativo) } }, codLocal)
    : construirPayload(c, items, cuotas, codLocal);
  const ruta = `/${RECURSO_API[c.tipo_doc]}`;
  const ctx = { operacion: 'comprobante.emitir', entidadTipo: 'comprobante', entidadId: c.id };
  const op = { cuerpo: payload, idempotencyKey: c.idempotency_key, emision: true };
  const espera = esperaReintento(c.intentos, ESPERAS_ENVIO);

  let r: RespuestaJson<EnvelopeApiPro<DocumentoApi>>;
  const inicio = Date.now();
  try {
    r = (await (await obtenerCliente()).llamar<EnvelopeApiPro<DocumentoApi>>('POST', ruta, op)) as RespuestaJson<EnvelopeApiPro<DocumentoApi>>;
  } catch (err) {
    await registrarIntento(ctx, 'POST', ruta, op, null, null, Date.now() - inicio, err instanceof Error ? err.message : String(err));
    if (err instanceof LlamadaProhibida) {
      await marcar(c.id, 'error_validacion', err.message);
      return { estado: 'fallido', error: err.message };
    }
    // Sin respuesta: no se sabe si API-PRO lo creó. Se reintenta con la MISMA Idempotency-Key.
    const mensaje = err instanceof ErrorRedApiPro ? err.message : 'Error de conexión';
    await marcar(c.id, 'por_verificar', mensaje, espera);
    return { estado: 'reintentar', reintentarEnSeg: espera, error: mensaje };
  }
  await registrarIntento(ctx, 'POST', ruta, op, r.status, r.cuerpo, r.duracionMs, null);

  if (r.status >= 200 && r.status < 300 && r.cuerpo?.estado !== 'error') {
    const estado = await guardarDocumento(c.id, r.cuerpo.datos, c.modo_envio);
    if (!ESTADOS_FINALES.includes(estado)) {
      await encolar(db, 'reconciliar_comprobante', 'comprobante', c.id, { ejecutarEn: new Date(Date.now() + 5000) });
    }
    return { estado: 'hecho' };
  }
  if (r.status === 422) {
    // Datos rechazados por API-PRO: no se creó el comprobante. Hay que corregir y reenviar.
    const mensaje = mensajeValidacion(r.cuerpo);
    await db('comprobantes').where('id', c.id).update({ estado: 'error_validacion', ultimo_error: mensaje, sunat_descripcion: mensaje });
    return { estado: 'hecho' };
  }
  const global = await manejarErrorGlobal(r.status, r.cuerpo, r.cabeceras);
  if (global) {
    // Nada se creó en API-PRO: el comprobante vuelve a "pendiente" sin gastar su cuenta de intentos.
    await db('comprobantes').where('id', c.id).update({ estado: 'pendiente', intentos: db.raw('GREATEST(intentos - 1, 0)'), ultimo_error: mensajeValidacion(r.cuerpo) });
    return { estado: 'reintentar', reintentarEnSeg: global.esperaSeg, error: `HTTP ${r.status}` };
  }
  if (r.status === 409) {
    await marcar(c.id, 'por_verificar', 'API-PRO aún procesa una solicitud anterior', 20);
    return { estado: 'reintentar', reintentarEnSeg: 20 };
  }
  // 5xx u otros: API-PRO liberó la clave; reintentar con la misma es seguro.
  await marcar(c.id, 'por_verificar', `API-PRO respondió HTTP ${r.status}: ${mensajeValidacion(r.cuerpo)}`, espera);
  return { estado: 'reintentar', reintentarEnSeg: espera, error: `HTTP ${r.status}` };
}

/** Consulta GET /{recurso}/{id} hasta un estado final (sin usar los /estado defectuosos, guarda B1). */
export async function reconciliarComprobante(trabajo: Trabajo): Promise<Resultado> {
  const c = (await db('comprobantes').where('id', trabajo.entidad_id).first()) as FilaComprobante | undefined;
  if (!c?.api_id) return { estado: 'fallido', error: 'El comprobante no está en API-PRO' };
  // Ya definitivos: no hay nada que consultar. (Rechazado o sin respuesta sí se consultan a pedido.)
  if (['aceptado', 'observado', 'anulado'].includes(c.estado)) return { estado: 'hecho' };
  if (await pausaActiva()) return { estado: 'reintentar', reintentarEnSeg: 60, error: 'Emisión pausada' };

  const ruta = `/${RECURSO_API[c.tipo_doc]}/${c.api_id}`;
  const ctx = { operacion: 'comprobante.consultar', entidadTipo: 'comprobante', entidadId: c.id };
  const espera = esperaReintento(trabajo.intentos, ESPERAS_CONSULTA);
  const inicio = Date.now();
  let r: RespuestaJson<EnvelopeApiPro<DocumentoApi>>;
  try {
    r = (await (await obtenerCliente()).llamar<EnvelopeApiPro<DocumentoApi>>('GET', ruta)) as RespuestaJson<EnvelopeApiPro<DocumentoApi>>;
  } catch (err) {
    await registrarIntento(ctx, 'GET', ruta, {}, null, null, Date.now() - inicio, err instanceof Error ? err.message : String(err));
    return { estado: 'reintentar', reintentarEnSeg: espera, error: 'Sin conexión con API-PRO' };
  }
  await registrarIntento(ctx, 'GET', ruta, {}, r.status, r.cuerpo, r.duracionMs, null);

  if (r.status === 200 && r.cuerpo?.estado !== 'error') {
    const estado = await guardarDocumento(c.id, r.cuerpo.datos, c.modo_envio);
    return ESTADOS_FINALES.includes(estado) ? { estado: 'hecho' } : { estado: 'reintentar', reintentarEnSeg: espera };
  }
  const global = await manejarErrorGlobal(r.status, r.cuerpo, r.cabeceras);
  if (global) return { estado: 'reintentar', reintentarEnSeg: global.esperaSeg, error: `HTTP ${r.status}` };
  if (r.status === 404) return { estado: 'fallido', error: 'API-PRO no encuentra el comprobante' };
  return { estado: 'reintentar', reintentarEnSeg: espera, error: `HTTP ${r.status}` };
}

/** Registra los manejadores del worker (se llama al iniciar el proceso worker y en las pruebas). */
export function registrarManejadoresEmision(): void {
  manejadores.emitir_comprobante = emitirComprobante;
  manejadores.reconciliar_comprobante = reconciliarComprobante;
  manejadores.reconciliar_resumen = reconciliarResumen;
  manejadores.enviar_anulacion = enviarAnulacion;
  manejadores.reconciliar_baja = reconciliarBaja;
  manejadores.emitir_guia = emitirGuia;
  manejadores.reconciliar_guia = reconciliarGuia;
}
