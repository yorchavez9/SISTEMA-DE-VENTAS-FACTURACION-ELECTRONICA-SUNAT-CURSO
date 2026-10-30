import { env } from '../../config/env.js';
import { validarPayloadEmision, validarRuta } from './guardas.js';
import { Presupuesto } from './presupuesto.js';

export interface Credenciales {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
}

export interface RespuestaJson<T = unknown> {
  tipo: 'json';
  status: number;
  cuerpo: T;
  cabeceras: Headers;
  duracionMs: number;
}

export interface RespuestaBinaria {
  tipo: 'binario';
  status: number;
  contentType: string;
  datos: Buffer;
  cabeceras: Headers;
  duracionMs: number;
}

/** Error de red o timeout: no se sabe si API-PRO procesó la solicitud. */
export class ErrorRedApiPro extends Error {
  constructor(
    mensaje: string,
    readonly timeout: boolean,
  ) {
    super(mensaje);
    this.name = 'ErrorRedApiPro';
  }
}

export interface OpcionesLlamada {
  cuerpo?: unknown;
  idempotencyKey?: string;
  /** Marca el cuerpo como payload de emisión para aplicar la guarda B7. */
  emision?: boolean;
  binario?: boolean;
  timeoutMs?: number;
}

const presupuestoGlobal = new Presupuesto(env.APIPRO_PRESUPUESTO_RPM);

export class ClienteApiPro {
  constructor(
    private readonly cred: Credenciales,
    private readonly presupuesto: Presupuesto = presupuestoGlobal,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async llamar<T = unknown>(
    metodo: 'GET' | 'POST' | 'PUT',
    ruta: string,
    op: OpcionesLlamada = {},
  ): Promise<RespuestaJson<T> | RespuestaBinaria> {
    validarRuta(metodo, ruta);
    if (op.emision) validarPayloadEmision(op.cuerpo);

    await this.presupuesto.esperarYTomar();

    const cabeceras: Record<string, string> = {
      Accept: op.binario ? '*/*' : 'application/json',
      'X-Api-Key': this.cred.apiKey,
      'X-Api-Secret': this.cred.apiSecret,
    };
    if (op.cuerpo !== undefined) cabeceras['Content-Type'] = 'application/json';
    if (op.idempotencyKey) cabeceras['Idempotency-Key'] = op.idempotencyKey;

    const inicio = Date.now();
    let res: Response;
    try {
      res = await this.fetchFn(`${this.cred.baseUrl.replace(/\/$/, '')}${ruta}`, {
        method: metodo,
        headers: cabeceras,
        body: op.cuerpo === undefined ? undefined : JSON.stringify(op.cuerpo),
        redirect: 'error',
        signal: AbortSignal.timeout(op.timeoutMs ?? 30_000),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ErrorRedApiPro(timeout ? 'Tiempo de espera agotado' : `Error de red: ${(err as Error).message}`, timeout);
    }
    const duracionMs = Date.now() - inicio;

    if (res.status === 429) {
      const retry = Number(res.headers.get('Retry-After'));
      if (Number.isFinite(retry) && retry > 0) this.presupuesto.penalizar(retry);
    }

    const contentType = res.headers.get('content-type') ?? '';
    // Las descargas devuelven JSON cuando el archivo no existe (404), por eso se mira el content-type.
    if (op.binario && !contentType.includes('application/json')) {
      return { tipo: 'binario', status: res.status, contentType, datos: Buffer.from(await res.arrayBuffer()), cabeceras: res.headers, duracionMs };
    }
    const texto = await res.text();
    let cuerpo: unknown;
    try {
      cuerpo = texto ? JSON.parse(texto) : null;
    } catch {
      cuerpo = { estado: 'error', mensaje: `Respuesta no JSON (HTTP ${res.status})`, crudo: texto.slice(0, 500) };
    }
    return { tipo: 'json', status: res.status, cuerpo: cuerpo as T, cabeceras: res.headers, duracionMs };
  }
}

/** Cliente con las credenciales de .env (desarrollo). En la fase 4 se leerán cifradas de la tabla empresa. */
export function clienteDesdeEnv(): ClienteApiPro {
  if (!env.APIPRO_KEY || !env.APIPRO_SECRET) {
    throw new Error('Faltan APIPRO_KEY / APIPRO_SECRET en apps/api/.env');
  }
  return new ClienteApiPro({ baseUrl: env.APIPRO_BASE_URL, apiKey: env.APIPRO_KEY, apiSecret: env.APIPRO_SECRET });
}
