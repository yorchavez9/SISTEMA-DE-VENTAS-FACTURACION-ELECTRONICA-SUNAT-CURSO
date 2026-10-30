import type { AccionAutorizable } from '@sv/shared';
import { db } from '../../database/db.js';
import { sha256 } from '../../shared/crypto.js';
import { hashClave, minutosBloqueo, tokenAleatorio, verificarClave, verificarFicticio } from '../../shared/claves.js';
import { ErrorApp } from '../../shared/errors.js';
import { permisosDeUsuario, sucursalesDeUsuario } from './sesiones.js';

// Política de bloqueo (docs/01-arquitectura.md §5).
const LOGIN_UMBRAL = 5;
const LOGIN_TOPE_MIN = 60;
const PIN_UMBRAL = 3;
const PIN_TOPE_MIN = 30;
const AUTORIZACION_SEG = 120;

/** Permiso que debe tener quien autoriza cada acción con su PIN. */
export const PERMISO_POR_ACCION: Record<AccionAutorizable, string> = {
  descuento: 'ventas.descuento',
  anular: 'ventas.anular',
  abrir_cajon: 'caja.movimientos',
  credito_excedido: 'ventas.credito',
  credenciales_api: 'config.editar',
};

const credencialesInvalidas = () => new ErrorApp(401, 'CREDENCIALES_INVALIDAS', 'Usuario o contraseña incorrectos');

function bloqueado(hasta: Date): ErrorApp {
  return new ErrorApp(423, 'BLOQUEADO', 'Demasiados intentos fallidos. Intenta más tarde.', undefined, { hasta: hasta.toISOString() });
}

interface UsuarioAcceso {
  id: number;
  usuario: string;
  rol: string;
  password_hash: string;
  pin_hash: string | null;
  intentos_fallidos: number;
  bloqueado_hasta: Date | null;
  pin_intentos: number;
  pin_bloqueado_hasta: Date | null;
}

function buscarActivo(where: { usuario: string } | { id: number }): Promise<UsuarioAcceso | undefined> {
  const filtro = 'usuario' in where ? { 'u.usuario': where.usuario } : { 'u.id': where.id };
  return db('usuarios as u')
    .join('roles as r', 'r.id', 'u.rol_id')
    .where({ ...filtro, 'u.activo': true })
    .first(
      'u.id', 'u.usuario', 'r.codigo as rol', 'u.password_hash', 'u.pin_hash',
      'u.intentos_fallidos', 'u.bloqueado_hasta', 'u.pin_intentos', 'u.pin_bloqueado_hasta',
    );
}

/** Verifica usuario y contraseña con bloqueo progresivo. Devuelve el id del usuario. */
export async function verificarLogin(usuario: string, password: string): Promise<number> {
  const u = await buscarActivo({ usuario });
  if (!u) {
    await verificarFicticio(password);
    throw credencialesInvalidas();
  }
  if (u.bloqueado_hasta && new Date(u.bloqueado_hasta) > new Date()) throw bloqueado(new Date(u.bloqueado_hasta));

  if (!(await verificarClave(u.password_hash, password))) {
    const intentos = u.intentos_fallidos + 1;
    const minutos = minutosBloqueo(intentos, LOGIN_UMBRAL, LOGIN_TOPE_MIN);
    const hasta = minutos ? new Date(Date.now() + minutos * 60_000) : null;
    await db('usuarios').where('id', u.id).update({ intentos_fallidos: intentos, bloqueado_hasta: hasta });
    if (hasta) throw bloqueado(hasta);
    throw credencialesInvalidas();
  }
  if (u.intentos_fallidos || u.bloqueado_hasta) {
    await db('usuarios').where('id', u.id).update({ intentos_fallidos: 0, bloqueado_hasta: null });
  }
  return Number(u.id);
}

/** Verifica el PIN de un usuario con bloqueo progresivo propio del PIN. */
export async function verificarPin(usuarioId: number, pin: string): Promise<void> {
  const u = await buscarActivo({ id: usuarioId });
  if (!u?.pin_hash) {
    await verificarFicticio(pin);
    throw new ErrorApp(401, 'PIN_INVALIDO', 'PIN incorrecto');
  }
  if (u.pin_bloqueado_hasta && new Date(u.pin_bloqueado_hasta) > new Date()) throw bloqueado(new Date(u.pin_bloqueado_hasta));

  if (!(await verificarClave(u.pin_hash, pin))) {
    const intentos = u.pin_intentos + 1;
    const minutos = minutosBloqueo(intentos, PIN_UMBRAL, PIN_TOPE_MIN);
    const hasta = minutos ? new Date(Date.now() + minutos * 60_000) : null;
    await db('usuarios').where('id', u.id).update({ pin_intentos: intentos, pin_bloqueado_hasta: hasta });
    if (hasta) throw bloqueado(hasta);
    throw new ErrorApp(401, 'PIN_INVALIDO', 'PIN incorrecto', undefined, { intentosRestantes: Math.max(0, PIN_UMBRAL - intentos) });
  }
  if (u.pin_intentos || u.pin_bloqueado_hasta) {
    await db('usuarios').where('id', u.id).update({ pin_intentos: 0, pin_bloqueado_hasta: null });
  }
}

/** Resuelve un token de dispositivo (POS) a su registro activo. */
export async function dispositivoPorToken(token: string): Promise<{ id: number; sucursalId: number } | null> {
  const d = await db('dispositivos').where({ token_hash: sha256(token), activo: true }).first('id', 'sucursal_id');
  if (!d) return null;
  await db('dispositivos').where('id', d.id).update({ ultimo_uso: db.raw('CURRENT_TIMESTAMP(3)') });
  return { id: Number(d.id), sucursalId: Number(d.sucursal_id) };
}

export async function tieneAccesoSucursal(usuarioId: number, sucursalId: number): Promise<boolean> {
  const u = await buscarActivo({ id: usuarioId });
  if (!u) return false;
  const sucursales = await sucursalesDeUsuario(usuarioId, u.rol);
  return sucursales.some((s) => s.id === sucursalId);
}

export async function cambiarPassword(usuarioId: number, actual: string, nueva: string): Promise<void> {
  const u = await buscarActivo({ id: usuarioId });
  if (!u || !(await verificarClave(u.password_hash, actual))) {
    throw new ErrorApp(422, 'VALIDACION', 'La contraseña actual no es correcta', { actual: 'Contraseña incorrecta' });
  }
  if (await verificarClave(u.password_hash, nueva)) {
    throw new ErrorApp(422, 'VALIDACION', 'La nueva contraseña debe ser distinta', { nueva: 'Debe ser distinta a la actual' });
  }
  await db('usuarios').where('id', usuarioId).update({ password_hash: await hashClave(nueva), debe_cambiar_password: false });
}

export async function fijarPin(usuarioId: number, password: string, pinNuevo: string): Promise<void> {
  const u = await buscarActivo({ id: usuarioId });
  if (!u || !(await verificarClave(u.password_hash, password))) {
    throw new ErrorApp(422, 'VALIDACION', 'La contraseña no es correcta', { password: 'Contraseña incorrecta' });
  }
  await db('usuarios').where('id', usuarioId).update({ pin_hash: await hashClave(pinNuevo), pin_intentos: 0, pin_bloqueado_hasta: null });
}

/** Crea una autorización de un solo uso para `accion`, firmada por el supervisor `autorizadorId`. */
export async function crearAutorizacion(datos: {
  autorizadorId: number;
  solicitanteId: number;
  dispositivoId: number | null;
  accion: AccionAutorizable;
}): Promise<{ token: string; expiraEn: Date }> {
  const permisos = await permisosDeUsuario(datos.autorizadorId);
  if (!permisos.has(PERMISO_POR_ACCION[datos.accion])) {
    throw new ErrorApp(403, 'SIN_PERMISO', 'Ese usuario no puede autorizar esta acción');
  }
  const token = tokenAleatorio(24);
  const expiraEn = new Date(Date.now() + AUTORIZACION_SEG * 1000);
  await db('autorizaciones').insert({
    token_hash: sha256(token),
    autorizado_por: datos.autorizadorId,
    solicitado_por: datos.solicitanteId,
    dispositivo_id: datos.dispositivoId,
    accion: datos.accion,
    expira_en: expiraEn,
  });
  return { token, expiraEn };
}

/**
 * Consume una autorización (un solo uso). Devuelve el id del supervisor que autorizó.
 * Se usará desde ventas, anulaciones y configuración en fases posteriores.
 */
export async function consumirAutorizacion(token: string, accion: AccionAutorizable, solicitanteId: number): Promise<number> {
  const hash = sha256(token);
  const afectadas = await db('autorizaciones')
    .where({ token_hash: hash, accion, solicitado_por: solicitanteId })
    .whereNull('usado_en')
    .andWhere('expira_en', '>', db.raw('CURRENT_TIMESTAMP(3)'))
    .update({ usado_en: db.raw('CURRENT_TIMESTAMP(3)') });
  if (afectadas !== 1) throw new ErrorApp(403, 'AUTORIZACION_INVALIDA', 'La autorización no es válida o expiró');
  const fila = await db('autorizaciones').where('token_hash', hash).first('autorizado_por');
  return Number(fila.autorizado_por);
}
