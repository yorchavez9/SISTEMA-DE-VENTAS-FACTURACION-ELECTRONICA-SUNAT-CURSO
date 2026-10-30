import type { SesionDto, SucursalResumen, UsuarioSesion } from '@sv/shared';
import { db } from '../../database/db.js';
import { sha256 } from '../../shared/crypto.js';
import { tokenAleatorio } from '../../shared/claves.js';
import { leerAjuste } from '../configuracion/configuracion.service.js';

export const COOKIE_SESION = 'sv_sid';
/** Duración máxima absoluta de una sesión, aunque haya actividad. */
const MAX_HORAS = 12;
/** Evita escribir en la BD en cada petición: el uso se registra como mucho cada 60 s. */
const REFRESCO_MS = 60_000;

export interface SesionCargada {
  id: string;
  usuario: UsuarioSesion;
  operador: UsuarioSesion;
  permisos: Set<string>;
  sucursales: SucursalResumen[];
  sucursalActiva: SucursalResumen | null;
  dispositivo: { id: number; nombre: string; sucursalId: number } | null;
  debeCambiarPassword: boolean;
  csrfToken: string;
}

interface FilaUsuario {
  id: number;
  usuario: string;
  nombre: string;
  rol: string;
}

async function cargarUsuario(id: number): Promise<FilaUsuario | undefined> {
  return db('usuarios as u')
    .join('roles as r', 'r.id', 'u.rol_id')
    .where({ 'u.id': id, 'u.activo': true })
    .first('u.id', 'u.usuario', 'u.nombre', 'r.codigo as rol');
}

export async function permisosDeUsuario(usuarioId: number): Promise<Set<string>> {
  const filas = await db('usuarios as u')
    .join('rol_permisos as rp', 'rp.rol_id', 'u.rol_id')
    .join('permisos as p', 'p.id', 'rp.permiso_id')
    .where('u.id', usuarioId)
    .pluck('p.codigo');
  return new Set(filas as string[]);
}

export async function sucursalesDeUsuario(usuarioId: number, rol: string): Promise<SucursalResumen[]> {
  const q = db('sucursales as s').where('s.activo', true).orderBy('s.nombre');
  if (rol !== 'admin') q.join('usuario_sucursales as us', 'us.sucursal_id', 's.id').where('us.usuario_id', usuarioId);
  const filas = await q.select('s.id', 's.nombre', 's.cod_local as codLocal');
  return filas.map((f: { id: number | string; nombre: string; codLocal: string }) => ({ ...f, id: Number(f.id) }));
}

async function minutosInactividad(): Promise<number> {
  return leerAjuste<number>('sesion.inactividad_min', 30);
}

export async function crearSesion(datos: {
  usuarioId: number;
  dispositivoId: number | null;
  sucursalId: number | null;
  ip?: string;
  userAgent?: string;
}): Promise<string> {
  const sid = tokenAleatorio(32);
  const minutos = await minutosInactividad();
  await db('sesiones').insert({
    id: sha256(sid),
    usuario_id: datos.usuarioId,
    operador_id: datos.usuarioId,
    dispositivo_id: datos.dispositivoId,
    sucursal_id: datos.sucursalId,
    csrf_token: sha256(tokenAleatorio(32)),
    expira_en: db.raw('CURRENT_TIMESTAMP(3) + INTERVAL ? MINUTE', [minutos]),
    ultimo_uso: db.raw('CURRENT_TIMESTAMP(3)'),
    ip: datos.ip?.slice(0, 45) ?? null,
    user_agent: datos.userAgent?.slice(0, 255) ?? null,
  });
  return sid;
}

/** Carga la sesión desde el valor de la cookie. Devuelve null si no existe, expiró o el usuario está inactivo. */
export async function cargarSesionPorCookie(sid: string): Promise<SesionCargada | null> {
  const id = sha256(sid);
  const fila = await db('sesiones')
    .where('id', id)
    .andWhere('expira_en', '>', db.raw('CURRENT_TIMESTAMP(3)'))
    .andWhere('created_at', '>', db.raw('CURRENT_TIMESTAMP(3) - INTERVAL ? HOUR', [MAX_HORAS]))
    .first();
  if (!fila) return null;

  const usuario = await cargarUsuario(Number(fila.usuario_id));
  if (!usuario) {
    await destruirSesion(id);
    return null;
  }
  const operador = fila.operador_id && Number(fila.operador_id) !== usuario.id ? await cargarUsuario(Number(fila.operador_id)) : usuario;

  if (Date.now() - new Date(fila.ultimo_uso).getTime() > REFRESCO_MS) {
    const minutos = await minutosInactividad();
    await db('sesiones')
      .where('id', id)
      .update({
        ultimo_uso: db.raw('CURRENT_TIMESTAMP(3)'),
        expira_en: db.raw('CURRENT_TIMESTAMP(3) + INTERVAL ? MINUTE', [minutos]),
      });
  }

  // Los permisos y sucursales son los del operador activo (el cajero que entró con PIN),
  // nunca los del usuario que abrió la sesión en el dispositivo.
  const efectivo = operador ?? usuario;
  const [permisos, sucursalesOperador, dispositivo, debeCambiar] = await Promise.all([
    permisosDeUsuario(efectivo.id),
    sucursalesDeUsuario(efectivo.id, efectivo.rol),
    fila.dispositivo_id
      ? db('dispositivos').where({ id: fila.dispositivo_id, activo: true }).first('id', 'nombre', 'sucursal_id')
      : undefined,
    db('usuarios').where('id', usuario.id).first('debe_cambiar_password'),
  ]);

  // En un dispositivo del POS la sucursal es fija: la del dispositivo.
  const sucursales = dispositivo
    ? sucursalesOperador.filter((s) => s.id === Number(dispositivo.sucursal_id))
    : sucursalesOperador;

  const aUsuarioSesion = (u: FilaUsuario): UsuarioSesion => ({ id: Number(u.id), usuario: u.usuario, nombre: u.nombre, rol: u.rol });
  return {
    id,
    usuario: aUsuarioSesion(usuario),
    operador: aUsuarioSesion(efectivo),
    permisos,
    sucursales,
    sucursalActiva: sucursales.find((s) => s.id === Number(fila.sucursal_id)) ?? sucursales[0] ?? null,
    dispositivo: dispositivo
      ? { id: Number(dispositivo.id), nombre: dispositivo.nombre, sucursalId: Number(dispositivo.sucursal_id) }
      : null,
    debeCambiarPassword: Boolean(debeCambiar?.debe_cambiar_password),
    csrfToken: fila.csrf_token,
  };
}

export async function destruirSesion(idHash: string): Promise<void> {
  await db('sesiones').where('id', idHash).delete();
}

export async function destruirSesionesDeUsuario(usuarioId: number, exceptoId?: string): Promise<void> {
  const q = db('sesiones').where('usuario_id', usuarioId);
  if (exceptoId) q.andWhereNot('id', exceptoId);
  await q.delete();
}

export function aDto(s: SesionCargada): SesionDto {
  return {
    usuario: s.usuario,
    operador: s.operador,
    permisos: [...s.permisos].sort(),
    sucursales: s.sucursales,
    sucursalActiva: s.sucursalActiva,
    dispositivo: s.dispositivo ? { id: s.dispositivo.id, nombre: s.dispositivo.nombre } : null,
    debeCambiarPassword: s.debeCambiarPassword,
    csrfToken: s.csrfToken,
  };
}
