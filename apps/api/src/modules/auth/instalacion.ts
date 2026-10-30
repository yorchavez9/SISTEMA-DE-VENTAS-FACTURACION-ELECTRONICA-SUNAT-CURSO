import type { InstalacionInput } from '@sv/shared';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { db } from '../../database/db.js';
import { hashClave } from '../../shared/claves.js';
import { ErrorApp } from '../../shared/errors.js';

// Primera instalación: si la base no tiene ningún usuario, la pantalla de ingreso permite registrar
// al super administrador (rol admin). Funciona una sola vez: con un usuario creado, queda cerrada.
// En producción exige además un código de un solo uso que la api escribe en su log al arrancar,
// para que nadie que llegue primero al sitio desde fuera se quede con la cuenta.

let codigo: string | null = null;

export const requiereCodigo = () => env.NODE_ENV === 'production';

export async function pendiente(): Promise<boolean> {
  return !(await db('usuarios').first('id'));
}

/** Al iniciar la api: si falta el administrador, avisa en el log (y en producción, con el código). */
export async function anunciarSiPendiente(): Promise<void> {
  if (!(await pendiente())) return;
  if (!requiereCodigo()) {
    logger.warn('No hay usuarios: abre el sistema en el navegador para registrar al super administrador');
    return;
  }
  codigo = randomBytes(6).toString('base64url').toUpperCase().slice(0, 8);
  logger.warn(`No hay usuarios. Código de instalación (un solo uso): ${codigo} — ingrésalo en la pantalla de configuración inicial`);
}

function codigoValido(dado: string | undefined): boolean {
  if (!requiereCodigo()) return true;
  if (!codigo || !dado) return false;
  const a = Buffer.from(dado.trim().toUpperCase());
  const b = Buffer.from(codigo);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Crea el super administrador. Un bloqueo de MySQL evita que dos solicitudes simultáneas creen dos. */
export async function instalar(d: InstalacionInput): Promise<number> {
  if (!codigoValido(d.codigo)) throw new ErrorApp(403, 'CODIGO_INSTALACION', 'Código de instalación incorrecto: búscalo en el log de la api', { codigo: 'Código incorrecto' });
  const hash = await hashClave(d.password);
  return db.transaction(async (trx) => {
    // La fila del rol admin bloqueada hasta el commit serializa las instalaciones simultáneas: la
    // segunda espera y, al continuar, la lectura con bloqueo ya ve el usuario confirmado.
    const rol = await trx('roles').where('codigo', 'admin').forUpdate().first('id');
    if (!rol) throw new ErrorApp(500, 'SIN_ROLES', 'Faltan los roles: ejecuta npm run db:seed');
    if (await trx('usuarios').forUpdate().first('id')) throw new ErrorApp(409, 'YA_INSTALADO', 'El sistema ya tiene usuarios: inicia sesión');
    const [id] = await trx('usuarios').insert({ usuario: d.usuario, nombre: d.nombre, password_hash: hash, rol_id: rol.id, debe_cambiar_password: false });
    await trx('auditoria').insert({ usuario_id: id, accion: 'usuario.instalacion', entidad: 'usuario', entidad_id: String(id), despues: JSON.stringify({ usuario: d.usuario, rol: 'admin' }) });
    codigo = null;
    return Number(id);
  });
}
