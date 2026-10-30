import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { COOKIE_SESION, cargarSesionPorCookie } from '../modules/auth/sesiones.js';
import { ErrorApp, errores } from '../shared/errors.js';

/** Carga la sesión si hay cookie válida. No exige autenticación. */
export async function cargarSesion(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const sid = req.cookies?.[COOKIE_SESION] as string | undefined;
  if (sid && /^[A-Za-z0-9_-]{20,100}$/.test(sid)) {
    req.sesion = (await cargarSesionPorCookie(sid)) ?? undefined;
  }
  next();
}

export function requiereSesion(req: Request, _res: Response, next: NextFunction): void {
  if (!req.sesion) throw errores.noAutenticado();
  next();
}

/** Exige todos los permisos indicados. El permiso se evalúa sobre el usuario de la sesión. */
export function requierePermiso(...permisos: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.sesion) throw errores.noAutenticado();
    if (!permisos.every((p) => req.sesion?.permisos.has(p))) throw errores.sinPermiso();
    next();
  };
}

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Protección CSRF: las escrituras con sesión deben enviar X-CSRF-Token igual al de la sesión. */
export function verificarCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (METODOS_SEGUROS.has(req.method) || !req.sesion) return next();
  const enviado = Buffer.from(String(req.get('X-CSRF-Token') ?? ''));
  const esperado = Buffer.from(req.sesion.csrfToken);
  if (enviado.length !== esperado.length || !timingSafeEqual(enviado, esperado)) {
    throw new ErrorApp(403, 'CSRF_INVALIDO', 'La sesión no es válida para esta acción. Recarga la página.');
  }
  next();
}

/**
 * Aplica la sucursal de la cabecera X-Sucursal-Id (si viene) validando que el usuario la tenga asignada.
 * Las rutas que operan sobre una sucursal leen `req.sesion.sucursalActiva`.
 */
export function aplicarSucursal(req: Request, _res: Response, next: NextFunction): void {
  const cabecera = req.get('X-Sucursal-Id');
  if (!req.sesion || !cabecera) return next();
  const sucursal = req.sesion.sucursales.find((s) => s.id === Number(cabecera));
  if (!sucursal) throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'No tienes acceso a esa sucursal');
  req.sesion.sucursalActiva = sucursal;
  next();
}

export function requiereSucursal(req: Request): NonNullable<NonNullable<Request['sesion']>['sucursalActiva']> {
  const s = req.sesion?.sucursalActiva;
  if (!s) throw new ErrorApp(409, 'SIN_SUCURSAL', 'No tienes una sucursal asignada');
  return s;
}
