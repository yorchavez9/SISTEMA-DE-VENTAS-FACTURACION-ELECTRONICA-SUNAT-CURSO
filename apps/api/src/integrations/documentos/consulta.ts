import { PROVEEDORES_DOCUMENTO, type ProveedorDocumento } from '@sv/shared';
import { db } from '../../database/db.js';
import { descifrar } from '../../shared/crypto.js';

// Consulta de DNI y RUC con json.pe (POST /api/dni | /api/ruc) o MIGO (GET /api/v2/dni/{n} |
// /api/v2/ruc/{n}). Los dos usan "Authorization: Bearer <token>". Cada respuesta se lleva a la misma
// forma; quien llama prueba los proveedores en orden y se queda con el primero que encuentra.

export interface DatosDocumento {
  razonSocial: string;
  direccion: string | null;
  estado: string | null;
  condicion: string | null;
}

export type ResultadoProveedor =
  | { tipo: 'encontrado'; datos: DatosDocumento }
  | { tipo: 'no_encontrado' }
  | { tipo: 'error'; motivo: string };

export interface ProveedorConToken {
  codigo: ProveedorDocumento;
  token: string;
}

type Buscar = typeof fetch;
const TIEMPO_MS = 8000;

/** Texto útil o null ("-", vacíos y espacios repetidos fuera). */
function limpio(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t && t !== '-' ? t : null;
}

function motivoHttp(status: number, mensaje?: unknown): string {
  if (status === 401 || status === 403) return 'token inválido o sin créditos';
  if (status === 429) return 'se alcanzó el límite de consultas';
  if (status >= 500) return 'el servicio no está disponible';
  return limpio(mensaje) ?? `respuesta inesperada (${status})`;
}

async function pedir(buscar: Buscar, url: string, token: string, init: { method: 'GET' | 'POST'; body?: unknown }) {
  const r = await buscar(url, {
    method: init.method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(TIEMPO_MS),
    redirect: 'error',
  });
  let cuerpo: Record<string, unknown> | null = null;
  try {
    cuerpo = (await r.json()) as Record<string, unknown>;
  } catch {
    cuerpo = null;
  }
  return { status: r.status, cuerpo };
}

async function jsonpe(buscar: Buscar, token: string, tipoDoc: '1' | '6', numDoc: string): Promise<ResultadoProveedor> {
  const dni = tipoDoc === '1';
  const { status, cuerpo } = await pedir(buscar, `https://api.json.pe/api/${dni ? 'dni' : 'ruc'}`, token, { method: 'POST', body: dni ? { dni: numDoc } : { ruc: numDoc } });
  // json.pe responde 404 tanto si el número no existe como si el token es inválido: se distingue por el mensaje.
  if (status === 404) return /no se encontr/i.test(String(cuerpo?.message ?? '')) ? { tipo: 'no_encontrado' } : { tipo: 'error', motivo: motivoHttp(401) };
  if (status !== 200) return { tipo: 'error', motivo: motivoHttp(status, cuerpo?.message) };
  if (cuerpo?.success === false) return { tipo: 'no_encontrado' };
  const d = (cuerpo?.data ?? {}) as Record<string, unknown>;
  if (dni) {
    // "CASTILLO TERRONES, JOSE PEDRO" → "CASTILLO TERRONES JOSE PEDRO" (apellidos y nombres, como en SUNAT).
    const nombre = limpio(d.nombre_completo)?.replace(/\s*,\s*/g, ' ') ?? limpio([d.apellido_paterno, d.apellido_materno, d.nombres].map(limpio).filter(Boolean).join(' '));
    return nombre ? { tipo: 'encontrado', datos: { razonSocial: nombre, direccion: limpio(d.direccion_completa) ?? limpio(d.direccion), estado: null, condicion: null } } : { tipo: 'no_encontrado' };
  }
  const razon = limpio(d.nombre_o_razon_social);
  return razon
    ? { tipo: 'encontrado', datos: { razonSocial: razon, direccion: limpio(d.direccion_completa) ?? limpio(d.direccion), estado: limpio(d.estado), condicion: limpio(d.condicion) } }
    : { tipo: 'no_encontrado' };
}

async function migo(buscar: Buscar, token: string, tipoDoc: '1' | '6', numDoc: string): Promise<ResultadoProveedor> {
  const dni = tipoDoc === '1';
  const { status, cuerpo } = await pedir(buscar, `https://api.migo.pe/api/v2/${dni ? 'dni' : 'ruc'}/${encodeURIComponent(numDoc)}`, token, { method: 'GET' });
  if (status === 404 || status === 422) return { tipo: 'no_encontrado' };
  if (status !== 200) return { tipo: 'error', motivo: motivoHttp(status, cuerpo?.message) };
  if (!cuerpo || cuerpo.success === false) return { tipo: 'no_encontrado' };
  if (dni) {
    const nombre = limpio(cuerpo.nombre);
    return nombre ? { tipo: 'encontrado', datos: { razonSocial: nombre, direccion: null, estado: null, condicion: null } } : { tipo: 'no_encontrado' };
  }
  const razon = limpio(cuerpo.nombre_o_razon_social);
  return razon
    ? {
        tipo: 'encontrado',
        datos: { razonSocial: razon, direccion: limpio(cuerpo.direccion) ?? limpio(cuerpo.direccion_simple), estado: limpio(cuerpo.estado_del_contribuyente), condicion: limpio(cuerpo.condicion_de_domicilio) },
      }
    : { tipo: 'no_encontrado' };
}

/** Consulta un DNI (tipo 1) o RUC (tipo 6) en un proveedor. Nunca lanza: los fallos vuelven como `error`. */
export async function consultarProveedor(p: ProveedorConToken, tipoDoc: '1' | '6', numDoc: string, buscar: Buscar = fetch): Promise<ResultadoProveedor> {
  try {
    return p.codigo === 'jsonpe' ? await jsonpe(buscar, p.token, tipoDoc, numDoc) : await migo(buscar, p.token, tipoDoc, numDoc);
  } catch (err) {
    const nombre = err instanceof Error ? err.name : '';
    return { tipo: 'error', motivo: nombre === 'TimeoutError' || nombre === 'AbortError' ? 'no respondió a tiempo' : 'no se pudo conectar' };
  }
}

export const nombreProveedor = (codigo: ProveedorDocumento) => PROVEEDORES_DOCUMENTO[codigo];

/** Proveedores activos y con token, en el orden configurado (el principal primero). */
export async function proveedoresActivos(): Promise<ProveedorConToken[]> {
  const filas = (await db('proveedores_documento').where('activo', true).whereNotNull('token_enc').orderBy('orden')) as Array<{ codigo: ProveedorDocumento; token_enc: Buffer }>;
  return filas.filter((f) => f.codigo in PROVEEDORES_DOCUMENTO).map((f) => ({ codigo: f.codigo, token: descifrar(f.token_enc) }));
}
