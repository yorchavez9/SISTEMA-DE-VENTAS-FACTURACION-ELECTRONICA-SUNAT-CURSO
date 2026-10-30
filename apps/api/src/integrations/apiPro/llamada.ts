import { db } from '../../database/db.js';
import { ErrorApp } from '../../shared/errors.js';
import { ErrorRedApiPro, type ClienteApiPro, type OpcionesLlamada, type RespuestaJson } from './cliente.js';

export interface EnvelopeApiPro<T> {
  estado: 'exito' | 'error';
  mensaje?: string;
  datos: T;
  errores?: Record<string, string[]> | string[];
  codigo_error?: string;
}

export interface Contexto {
  operacion: string;
  entidadTipo?: string;
  entidadId?: number;
}

/** Quita cualquier campo sensible antes de guardar el request en el historial. */
function sanear(cuerpo: unknown): unknown {
  if (!cuerpo || typeof cuerpo !== 'object') return cuerpo ?? null;
  return JSON.parse(JSON.stringify(cuerpo, (k, v) => (/secret|password|sol_|token|certificado|api_key/i.test(k) ? '[oculto]' : v)));
}

function mensajeDe(cuerpo: EnvelopeApiPro<unknown> | null): string {
  if (!cuerpo) return 'Respuesta vacía';
  const errores = Array.isArray(cuerpo.errores)
    ? cuerpo.errores
    : Object.entries(cuerpo.errores ?? {}).map(([c, m]) => `${c}: ${(m as string[]).join(', ')}`);
  return [cuerpo.mensaje, ...errores].filter(Boolean).join(' · ');
}

/**
 * Llamada síncrona a API-PRO que espera JSON con el envelope {estado, mensaje, datos}.
 * Registra cada intento en integracion_intentos y traduce los errores al formato interno.
 * (Las emisiones asíncronas del worker usan su propio flujo en la fase 7.)
 */
export async function llamarJson<T>(
  cliente: ClienteApiPro,
  metodo: 'GET' | 'POST' | 'PUT',
  ruta: string,
  ctx: Contexto,
  op: OpcionesLlamada = {},
): Promise<{ datos: T; respuesta: RespuestaJson<EnvelopeApiPro<T>> }> {
  const inicio = Date.now();
  let respuesta: RespuestaJson<EnvelopeApiPro<T>>;
  try {
    respuesta = (await cliente.llamar<EnvelopeApiPro<T>>(metodo, ruta, op)) as RespuestaJson<EnvelopeApiPro<T>>;
  } catch (err) {
    await registrar(ctx, metodo, ruta, op, null, null, Date.now() - inicio, err instanceof Error ? err.message : String(err));
    if (err instanceof ErrorRedApiPro) {
      throw new ErrorApp(503, 'APIPRO_NO_DISPONIBLE', `No se pudo contactar a API-PRO: ${err.message}`);
    }
    throw err;
  }
  await registrar(ctx, metodo, ruta, op, respuesta.status, respuesta.cuerpo, respuesta.duracionMs, null);

  const { status, cuerpo } = respuesta;
  if (status >= 200 && status < 300 && cuerpo?.estado !== 'error') return { datos: cuerpo.datos, respuesta };

  const detalle = { httpStatus: status, mensajeApi: mensajeDe(cuerpo), codigoError: cuerpo?.codigo_error };
  if (status === 401) throw new ErrorApp(502, 'APIPRO_CREDENCIALES', 'API-PRO rechazó las credenciales', undefined, detalle);
  if (status === 403) throw new ErrorApp(502, 'APIPRO_PROHIBIDO', `API-PRO denegó la operación: ${detalle.mensajeApi}`, undefined, detalle);
  if (status === 429) throw new ErrorApp(503, 'APIPRO_LIMITE', 'API-PRO está limitando las solicitudes; intenta en un momento', undefined, detalle);
  if (status === 422 || status === 409) throw new ErrorApp(422, 'APIPRO_VALIDACION', `API-PRO: ${detalle.mensajeApi}`, undefined, detalle);
  if (status === 404) throw new ErrorApp(404, 'APIPRO_NO_ENCONTRADO', `API-PRO: ${detalle.mensajeApi}`, undefined, detalle);
  throw new ErrorApp(502, 'APIPRO_ERROR', `API-PRO respondió HTTP ${status}`, undefined, detalle);
}

/** Guarda un intento de llamada a API-PRO en el historial (sin datos sensibles). */
export async function registrar(
  ctx: Contexto,
  metodo: string,
  ruta: string,
  op: OpcionesLlamada,
  status: number | null,
  cuerpo: unknown,
  duracionMs: number,
  error: string | null,
): Promise<void> {
  await db('integracion_intentos').insert({
    entidad_tipo: ctx.entidadTipo ?? null,
    entidad_id: ctx.entidadId ?? null,
    operacion: ctx.operacion,
    metodo,
    ruta: ruta.slice(0, 255),
    idempotency_key: op.idempotencyKey ?? null,
    request_json: op.cuerpo === undefined ? null : JSON.stringify(sanear(op.cuerpo)),
    http_status: status,
    response_json: cuerpo == null ? null : JSON.stringify(sanear(cuerpo)),
    duracion_ms: duracionMs,
    error,
  });
}
