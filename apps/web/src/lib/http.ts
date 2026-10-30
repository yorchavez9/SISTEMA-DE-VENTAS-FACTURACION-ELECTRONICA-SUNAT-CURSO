import type { ErrorApi } from '@sv/shared';

/** Error HTTP con el formato único de la API interna. */
export class ErrorHttp extends Error {
  constructor(
    readonly status: number,
    readonly cuerpo: ErrorApi,
  ) {
    super(cuerpo.error);
    this.name = 'ErrorHttp';
  }
  get campos(): Record<string, string> {
    return this.cuerpo.campos ?? {};
  }
  get codigo(): string {
    return this.cuerpo.codigo;
  }
}

// Estado de la sesión que acompaña cada petición (lo fija el proveedor de sesión).
let csrfToken: string | null = null;
let sucursalId: number | null = null;
let alExpirar: (() => void) | null = null;

export function fijarContextoHttp(c: { csrf?: string | null; sucursal?: number | null; alExpirar?: () => void }): void {
  if (c.csrf !== undefined) csrfToken = c.csrf;
  if (c.sucursal !== undefined) sucursalId = c.sucursal;
  if (c.alExpirar) alExpirar = c.alExpirar;
}

interface Opciones extends Omit<RequestInit, 'body'> {
  cuerpo?: unknown;
  /** Genera una Idempotency-Key (o usa la indicada) para escrituras críticas. */
  idempotente?: boolean | string;
}

export async function pedir<T>(ruta: string, { cuerpo, idempotente, ...init }: Opciones = {}): Promise<T> {
  const metodo = (init.method ?? (cuerpo !== undefined ? 'POST' : 'GET')).toUpperCase();
  const cabeceras: Record<string, string> = { Accept: 'application/json' };
  // Un archivo (p. ej. la imagen de un producto) se envía tal cual, con su tipo.
  const archivo = cuerpo instanceof Blob ? cuerpo : null;
  if (cuerpo !== undefined) cabeceras['Content-Type'] = archivo ? archivo.type : 'application/json';
  if (metodo !== 'GET' && csrfToken) cabeceras['X-CSRF-Token'] = csrfToken;
  if (sucursalId) cabeceras['X-Sucursal-Id'] = String(sucursalId);
  if (idempotente) cabeceras['Idempotency-Key'] = typeof idempotente === 'string' ? idempotente : crypto.randomUUID();

  const res = await fetch(`/api${ruta}`, {
    credentials: 'same-origin',
    ...init,
    method: metodo,
    headers: { ...cabeceras, ...(init.headers as Record<string, string> | undefined) },
    body: cuerpo === undefined ? undefined : (archivo ?? JSON.stringify(cuerpo)),
  });
  const texto = await res.text();
  let datos: unknown = null;
  try {
    datos = texto ? JSON.parse(texto) : null;
  } catch {
    datos = { error: `Respuesta inválida del servidor (HTTP ${res.status})`, codigo: 'RESPUESTA_INVALIDA' };
  }
  if (!res.ok) {
    if (res.status === 401 && ruta !== '/auth/login' && ruta !== '/auth/me') alExpirar?.();
    throw new ErrorHttp(res.status, (datos as ErrorApi) ?? { error: `Error HTTP ${res.status}`, codigo: 'ERROR_HTTP' });
  }
  return datos as T;
}

/**
 * Descarga un archivo de la API (PDF, XML, CDR) con la sesión actual.
 * `abrir` lo muestra en una pestaña nueva (PDF); si no, lo guarda con su nombre.
 */
export async function descargar(ruta: string, opciones: { abrir?: boolean } = {}): Promise<void> {
  // La pestaña se abre antes del fetch para que el navegador no la bloquee como ventana emergente.
  const ventana = opciones.abrir ? window.open('', '_blank') : null;
  const res = await fetch(`/api${ruta}`, { credentials: 'same-origin', headers: sucursalId ? { 'X-Sucursal-Id': String(sucursalId) } : {} });
  if (!res.ok) {
    ventana?.close();
    const cuerpo = await res.json().catch(() => ({ error: `Error HTTP ${res.status}`, codigo: 'ERROR_HTTP' }));
    throw new ErrorHttp(res.status, cuerpo);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  if (ventana) {
    ventana.location.href = url;
  } else {
    const nombre = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'archivo';
    const a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Mensaje legible de cualquier error (para toasts). */
export function mensajeError(err: unknown): string {
  if (err instanceof ErrorHttp) return err.message;
  if (err instanceof TypeError) return 'No se pudo contactar al servidor';
  return err instanceof Error ? err.message : 'Error inesperado';
}
