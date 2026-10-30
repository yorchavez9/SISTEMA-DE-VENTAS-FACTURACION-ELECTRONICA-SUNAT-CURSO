import {
  autorizarSchema, cambiarOperadorSchema, cambiarPasswordSchema, elegirSucursalSchema, fijarPinSchema, ingresoPinSchema, instalacionSchema, loginSchema,
  type EstadoInstalacionDto, type IngresoPinInput, type InstalacionInput, type LoginInput, type UsuarioIngresoDto,
} from '@sv/shared';
import { Router, type CookieOptions, type Request, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { env } from '../../config/env.js';
import { db } from '../../database/db.js';
import { requiereSesion } from '../../middlewares/sesion.js';
import { validarBody } from '../../middlewares/validar.js';
import { auditar } from '../../shared/auditoria.js';
import { ErrorApp } from '../../shared/errors.js';
import * as auth from './auth.service.js';
import * as instalacion from './instalacion.js';
import { COOKIE_SESION, aDto, cargarSesionPorCookie, crearSesion, destruirSesion, destruirSesionesDeUsuario } from './sesiones.js';

const cookieSesion: CookieOptions = {
  httpOnly: true,
  sameSite: 'strict',
  secure: env.NODE_ENV === 'production',
  path: '/',
  maxAge: 12 * 60 * 60 * 1000,
};

const limiteLogin = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? '')}:${String(req.body?.usuario ?? '').toLowerCase()}`,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Demasiados intentos. Espera un minuto.', codigo: 'DEMASIADAS_SOLICITUDES' });
  },
});

const limitePin = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Demasiados intentos. Espera un minuto.', codigo: 'DEMASIADAS_SOLICITUDES' });
  },
});

async function responderSesion(req: Request, res: Response, sid: string, status = 200): Promise<void> {
  const sesion = await cargarSesionPorCookie(sid);
  if (!sesion) throw new ErrorApp(500, 'ERROR_INTERNO', 'No se pudo iniciar la sesión');
  req.sesion = sesion;
  res.status(status).json(aDto(sesion));
}

function requiereDispositivo(req: Request) {
  const d = req.sesion?.dispositivo;
  if (!d) throw new ErrorApp(403, 'DISPOSITIVO_NO_REGISTRADO', 'El PIN solo se puede usar en un dispositivo de caja registrado');
  return d;
}

export const authRouter = Router();

authRouter.post('/login', limiteLogin, validarBody(loginSchema), async (req, res) => {
  const { usuario, password, dispositivoToken } = req.body as LoginInput;
  let usuarioId: number;
  try {
    usuarioId = await auth.verificarLogin(usuario, password);
  } catch (err) {
    await auditar(req, { accion: 'auth.login_fallido', entidad: 'usuario', entidadId: usuario });
    throw err;
  }

  let dispositivo: { id: number; sucursalId: number } | null = null;
  if (dispositivoToken) {
    dispositivo = await auth.dispositivoPorToken(dispositivoToken);
    if (dispositivo && !(await auth.tieneAccesoSucursal(usuarioId, dispositivo.sucursalId))) {
      throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'No tienes acceso a la sucursal de este dispositivo');
    }
  }

  // Si ya había una sesión en este navegador, se reemplaza.
  if (req.sesion) await destruirSesion(req.sesion.id);

  const sid = await crearSesion({
    usuarioId,
    dispositivoId: dispositivo?.id ?? null,
    sucursalId: dispositivo?.sucursalId ?? null,
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  res.cookie(COOKIE_SESION, sid, cookieSesion);
  await responderSesion(req, res, sid);
  await auditar(req, { accion: 'auth.login', entidad: 'usuario', entidadId: usuarioId, despues: { dispositivoId: dispositivo?.id ?? null } });
});

// ---------- Ingreso con PIN (como ferretería) ----------

const limiteListaIngreso = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Demasiadas solicitudes. Espera un minuto.', codigo: 'DEMASIADAS_SOLICITUDES' });
  },
});

/**
 * Usuarios que pueden ingresar con PIN (activos y con PIN). En una caja registrada, solo los de su
 * sucursal (y administradores). Solo nombre y rol: nunca el usuario de acceso ni datos personales.
 */
authRouter.get('/ingreso/usuarios', limiteListaIngreso, async (req, res) => {
  const token = typeof req.query.dispositivo === 'string' ? req.query.dispositivo.slice(0, 100) : '';
  const dispositivo = token ? await auth.dispositivoPorToken(token) : null;
  const q = db('usuarios as u').join('roles as r', 'r.id', 'u.rol_id').where('u.activo', true).whereNotNull('u.pin_hash').orderBy('u.nombre');
  if (dispositivo) {
    q.leftJoin('usuario_sucursales as us', function () {
      this.on('us.usuario_id', 'u.id').andOnVal('us.sucursal_id', dispositivo.sucursalId);
    }).andWhere((w) => w.whereNotNull('us.usuario_id').orWhere('r.codigo', 'admin'));
  }
  const filas = await q.select('u.id', 'u.nombre', 'r.codigo as rol');
  const cuerpo: UsuarioIngresoDto[] = filas.map((f: { id: number | string; nombre: string; rol: string }) => ({ id: Number(f.id), nombre: f.nombre, rol: f.rol }));
  res.json(cuerpo);
});

/** Ingreso eligiendo el usuario y escribiendo su PIN. El PIN tiene su propio bloqueo progresivo. */
authRouter.post('/ingreso/pin', limitePin, validarBody(ingresoPinSchema), async (req, res) => {
  const { usuarioId, pin, dispositivoToken } = req.body as IngresoPinInput;
  const usuario = await db('usuarios').where({ id: usuarioId, activo: true }).first('id');
  if (!usuario) throw new ErrorApp(401, 'PIN_INVALIDO', 'PIN incorrecto');
  try {
    await auth.verificarPin(usuarioId, pin);
  } catch (err) {
    await auditar(req, { accion: 'auth.login_pin_fallido', entidad: 'usuario', entidadId: usuarioId });
    throw err;
  }
  let dispositivo: { id: number; sucursalId: number } | null = null;
  if (dispositivoToken) {
    dispositivo = await auth.dispositivoPorToken(dispositivoToken);
    if (dispositivo && !(await auth.tieneAccesoSucursal(usuarioId, dispositivo.sucursalId))) {
      throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'No tienes acceso a la sucursal de este dispositivo');
    }
  }
  if (req.sesion) await destruirSesion(req.sesion.id);
  const sid = await crearSesion({ usuarioId, dispositivoId: dispositivo?.id ?? null, sucursalId: dispositivo?.sucursalId ?? null, ip: req.ip, userAgent: req.get('user-agent') });
  res.cookie(COOKIE_SESION, sid, cookieSesion);
  await responderSesion(req, res, sid);
  await auditar(req, { accion: 'auth.login', entidad: 'usuario', entidadId: usuarioId, despues: { metodo: 'pin', dispositivoId: dispositivo?.id ?? null } });
});

// ---------- Primera instalación ----------

const limiteInstalacion = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Demasiados intentos. Espera un minuto.', codigo: 'DEMASIADAS_SOLICITUDES' });
  },
});

authRouter.get('/instalacion', async (_req, res) => {
  const cuerpo: EstadoInstalacionDto = { pendiente: await instalacion.pendiente(), requiereCodigo: instalacion.requiereCodigo() };
  res.json(cuerpo);
});

/** Registra al super administrador (solo si no hay ningún usuario) y abre su sesión. */
authRouter.post('/instalacion', limiteInstalacion, validarBody(instalacionSchema), async (req, res) => {
  const usuarioId = await instalacion.instalar(req.body as InstalacionInput);
  const sid = await crearSesion({ usuarioId, dispositivoId: null, sucursalId: null, ip: req.ip, userAgent: req.get('user-agent') });
  res.cookie(COOKIE_SESION, sid, cookieSesion);
  await responderSesion(req, res, sid, 201);
  await auditar(req, { accion: 'auth.login', entidad: 'usuario', entidadId: usuarioId, despues: { instalacion: true } });
});

authRouter.post('/logout', async (req, res) => {
  if (req.sesion) {
    await auditar(req, { accion: 'auth.logout', entidad: 'usuario', entidadId: req.sesion.usuario.id });
    await destruirSesion(req.sesion.id);
  }
  res.clearCookie(COOKIE_SESION, { ...cookieSesion, maxAge: undefined });
  res.status(204).end();
});

authRouter.get('/me', requiereSesion, (req, res) => {
  res.json(aDto(req.sesion!));
});

authRouter.post('/sucursal', requiereSesion, validarBody(elegirSucursalSchema), async (req, res) => {
  const s = req.sesion!;
  if (s.dispositivo) throw new ErrorApp(409, 'SUCURSAL_FIJA', 'En un dispositivo de caja la sucursal es fija');
  const { sucursalId } = req.body as { sucursalId: number };
  const sucursal = s.sucursales.find((x) => x.id === sucursalId);
  if (!sucursal) throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'No tienes acceso a esa sucursal');
  await db('sesiones').where('id', s.id).update({ sucursal_id: sucursalId });
  res.json({ sucursalActiva: sucursal });
});

authRouter.post('/password', requiereSesion, validarBody(cambiarPasswordSchema), async (req, res) => {
  const s = req.sesion!;
  const { actual, nueva } = req.body as { actual: string; nueva: string };
  await auth.cambiarPassword(s.usuario.id, actual, nueva);
  // Cierra las demás sesiones del usuario.
  await destruirSesionesDeUsuario(s.usuario.id, s.id);
  await auditar(req, { accion: 'auth.cambiar_password', entidad: 'usuario', entidadId: s.usuario.id });
  res.status(204).end();
});

authRouter.put('/pin', requiereSesion, validarBody(fijarPinSchema), async (req, res) => {
  const s = req.sesion!;
  const { password, pinNuevo } = req.body as { password: string; pinNuevo: string };
  await auth.fijarPin(s.usuario.id, password, pinNuevo);
  await auditar(req, { accion: 'auth.fijar_pin', entidad: 'usuario', entidadId: s.usuario.id });
  res.status(204).end();
});

authRouter.post('/pin/cambiar-operador', requiereSesion, limitePin, validarBody(cambiarOperadorSchema), async (req, res) => {
  const s = req.sesion!;
  const dispositivo = requiereDispositivo(req);
  const { usuarioId, pin } = req.body as { usuarioId: number; pin: string };
  if (!(await auth.tieneAccesoSucursal(usuarioId, dispositivo.sucursalId))) {
    throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'Ese usuario no tiene acceso a esta sucursal');
  }
  try {
    await auth.verificarPin(usuarioId, pin);
  } catch (err) {
    await auditar(req, { accion: 'auth.pin_fallido', entidad: 'usuario', entidadId: usuarioId });
    throw err;
  }
  await db('sesiones').where('id', s.id).update({ operador_id: usuarioId });
  await auditar(req, { accion: 'auth.cambiar_operador', entidad: 'usuario', entidadId: usuarioId, antes: { operador: s.operador.id } });
  const sid = req.cookies[COOKIE_SESION] as string;
  await responderSesion(req, res, sid);
});

/** Usuarios que pueden operar en este dispositivo (para el teclado de PIN). */
authRouter.get('/pin/usuarios', requiereSesion, async (req, res) => {
  const dispositivo = requiereDispositivo(req);
  const filas = await db('usuarios as u')
    .join('roles as r', 'r.id', 'u.rol_id')
    .leftJoin('usuario_sucursales as us', function () {
      this.on('us.usuario_id', 'u.id').andOnVal('us.sucursal_id', dispositivo.sucursalId);
    })
    .where('u.activo', true)
    .whereNotNull('u.pin_hash')
    .andWhere((q) => q.whereNotNull('us.usuario_id').orWhere('r.codigo', 'admin'))
    .orderBy('u.nombre')
    .select('u.id', 'u.nombre', 'r.codigo as rol');
  res.json(filas.map((f: { id: number | string; nombre: string; rol: string }) => ({ ...f, id: Number(f.id) })));
});

authRouter.post('/pin/autorizar', requiereSesion, limitePin, validarBody(autorizarSchema), async (req, res) => {
  const s = req.sesion!;
  const dispositivo = requiereDispositivo(req);
  const { usuarioId, pin, accion } = req.body as { usuarioId: number; pin: string; accion: Parameters<typeof auth.crearAutorizacion>[0]['accion'] };
  try {
    await auth.verificarPin(usuarioId, pin);
  } catch (err) {
    await auditar(req, { accion: 'auth.pin_fallido', entidad: 'usuario', entidadId: usuarioId, despues: { accion } });
    throw err;
  }
  const { token, expiraEn } = await auth.crearAutorizacion({
    autorizadorId: usuarioId,
    solicitanteId: s.operador.id,
    dispositivoId: dispositivo.id,
    accion,
  });
  await auditar(req, { accion: 'auth.autorizacion', entidad: 'usuario', entidadId: usuarioId, despues: { accion } });
  res.status(201).json({ autorizacionToken: token, autorizadoPor: usuarioId, expiraEn: expiraEn.toISOString() });
});
