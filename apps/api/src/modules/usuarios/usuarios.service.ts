import type { CrearUsuarioInput, EditarUsuarioInput, Rol, UsuarioDto } from '@sv/shared';
import type { Knex } from 'knex';
import { db } from '../../database/db.js';
import { hashClave, passwordTemporal } from '../../shared/claves.js';
import { ErrorApp, errores } from '../../shared/errors.js';
import { destruirSesionesDeUsuario } from '../auth/sesiones.js';

interface FilaUsuario {
  id: number | string;
  usuario: string;
  nombre: string;
  email: string | null;
  rol: Rol;
  activo: number | boolean;
  pin_hash: string | null;
  bloqueado_hasta: Date | null;
  pin_bloqueado_hasta: Date | null;
}

function aDto(f: FilaUsuario, sucursalIds: number[]): UsuarioDto {
  const ahora = new Date();
  return {
    id: Number(f.id),
    usuario: f.usuario,
    nombre: f.nombre,
    email: f.email,
    rol: f.rol,
    activo: Boolean(f.activo),
    tienePin: Boolean(f.pin_hash),
    bloqueado: Boolean(
      (f.bloqueado_hasta && new Date(f.bloqueado_hasta) > ahora) || (f.pin_bloqueado_hasta && new Date(f.pin_bloqueado_hasta) > ahora),
    ),
    sucursalIds,
  };
}

const base = () =>
  db('usuarios as u')
    .join('roles as r', 'r.id', 'u.rol_id')
    .select('u.id', 'u.usuario', 'u.nombre', 'u.email', 'r.codigo as rol', 'u.activo', 'u.pin_hash', 'u.bloqueado_hasta', 'u.pin_bloqueado_hasta');

async function sucursalesPorUsuario(ids: number[]): Promise<Map<number, number[]>> {
  const mapa = new Map<number, number[]>();
  if (!ids.length) return mapa;
  const filas = await db('usuario_sucursales').whereIn('usuario_id', ids).select('usuario_id', 'sucursal_id');
  for (const f of filas as Array<{ usuario_id: number | string; sucursal_id: number | string }>) {
    const lista = mapa.get(Number(f.usuario_id)) ?? [];
    lista.push(Number(f.sucursal_id));
    mapa.set(Number(f.usuario_id), lista);
  }
  return mapa;
}

export async function listar(q: { page: number; pageSize: number; q?: string }) {
  const filtro = (qb: Knex.QueryBuilder) => {
    if (q.q) qb.where((w) => w.whereILike('u.nombre', `%${q.q}%`).orWhereILike('u.usuario', `%${q.q}%`));
  };
  const [{ total }] = (await db('usuarios as u').modify(filtro).count({ total: '*' })) as [{ total: number }];
  const filas = (await base().modify(filtro).orderBy('u.nombre').limit(q.pageSize).offset((q.page - 1) * q.pageSize)) as FilaUsuario[];
  const sucursales = await sucursalesPorUsuario(filas.map((f) => Number(f.id)));
  return {
    data: filas.map((f) => aDto(f, sucursales.get(Number(f.id)) ?? [])),
    page: q.page,
    pageSize: q.pageSize,
    total: Number(total),
  };
}

export async function obtener(id: number): Promise<UsuarioDto> {
  const fila = (await base().where('u.id', id).first()) as FilaUsuario | undefined;
  if (!fila) throw errores.noEncontrado('Usuario');
  const sucursales = await sucursalesPorUsuario([id]);
  return aDto(fila, sucursales.get(id) ?? []);
}

async function idRol(trx: Knex.Transaction, rol: Rol): Promise<number> {
  const fila = await trx('roles').where('codigo', rol).first('id');
  if (!fila) throw new ErrorApp(422, 'VALIDACION', 'Rol inválido', { rol: 'Rol inválido' });
  return Number(fila.id);
}

async function validarSucursales(trx: Knex.Transaction, ids: number[]): Promise<void> {
  const existentes = await trx('sucursales').whereIn('id', ids).where('activo', true).pluck('id');
  if (existentes.length !== new Set(ids).size) {
    throw new ErrorApp(422, 'VALIDACION', 'Alguna sucursal no existe', { sucursalIds: 'Sucursal inválida' });
  }
}

/** Crea el usuario con una contraseña temporal (se muestra una sola vez y obliga a cambiarla). */
export async function crear(datos: CrearUsuarioInput): Promise<{ usuario: UsuarioDto; passwordTemporal: string }> {
  const temporal = passwordTemporal();
  const hash = await hashClave(temporal);
  const id = await db.transaction(async (trx) => {
    if (await trx('usuarios').where('usuario', datos.usuario).first('id')) {
      throw new ErrorApp(409, 'DUPLICADO', 'Ya existe ese nombre de usuario', undefined, { campo: 'usuario' });
    }
    await validarSucursales(trx, datos.sucursalIds);
    const [nuevoId] = await trx('usuarios').insert({
      usuario: datos.usuario,
      nombre: datos.nombre,
      email: datos.email ?? null,
      password_hash: hash,
      rol_id: await idRol(trx, datos.rol),
      debe_cambiar_password: true,
    });
    await trx('usuario_sucursales').insert(datos.sucursalIds.map((s) => ({ usuario_id: nuevoId, sucursal_id: s })));
    return Number(nuevoId);
  });
  return { usuario: await obtener(id), passwordTemporal: temporal };
}

export async function editar(id: number, datos: EditarUsuarioInput, editorId: number): Promise<{ antes: UsuarioDto; despues: UsuarioDto }> {
  const antes = await obtener(id);
  if (id === editorId && (!datos.activo || datos.rol !== antes.rol)) {
    throw new ErrorApp(409, 'ESTADO_NO_PERMITE', 'No puedes desactivarte ni cambiar tu propio rol');
  }
  await db.transaction(async (trx) => {
    // Siempre debe quedar al menos un administrador activo.
    if (antes.rol === 'admin' && (datos.rol !== 'admin' || !datos.activo)) {
      const [{ n }] = (await trx('usuarios as u')
        .join('roles as r', 'r.id', 'u.rol_id')
        .where({ 'r.codigo': 'admin', 'u.activo': true })
        .whereNot('u.id', id)
        .forUpdate()
        .count({ n: '*' })) as [{ n: number }];
      if (Number(n) === 0) throw new ErrorApp(409, 'ESTADO_NO_PERMITE', 'Debe quedar al menos un administrador activo');
    }
    await validarSucursales(trx, datos.sucursalIds);
    await trx('usuarios').where('id', id).update({
      nombre: datos.nombre,
      email: datos.email ?? null,
      rol_id: await idRol(trx, datos.rol),
      activo: datos.activo,
    });
    await trx('usuario_sucursales').where('usuario_id', id).delete();
    await trx('usuario_sucursales').insert(datos.sucursalIds.map((s) => ({ usuario_id: id, sucursal_id: s })));
  });
  // Un cambio de rol, sucursales o estado invalida las sesiones abiertas del usuario.
  const mismasSucursales = [...datos.sucursalIds].sort().join() === [...antes.sucursalIds].sort().join();
  if (!datos.activo || datos.rol !== antes.rol || !mismasSucursales) {
    await destruirSesionesDeUsuario(id);
  }
  return { antes, despues: await obtener(id) };
}

export async function restablecerPassword(id: number): Promise<string> {
  await obtener(id);
  const temporal = passwordTemporal();
  await db('usuarios')
    .where('id', id)
    .update({ password_hash: await hashClave(temporal), debe_cambiar_password: true, intentos_fallidos: 0, bloqueado_hasta: null });
  await destruirSesionesDeUsuario(id);
  return temporal;
}

export async function restablecerPin(id: number): Promise<void> {
  await obtener(id);
  await db('usuarios').where('id', id).update({ pin_hash: null, pin_intentos: 0, pin_bloqueado_hasta: null });
}
