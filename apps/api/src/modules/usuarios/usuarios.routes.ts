import { crearDispositivoSchema, crearUsuarioSchema, editarUsuarioSchema, paginacionQuery, type PaginacionQuery } from '@sv/shared';
import { Router } from 'express';
import { db } from '../../database/db.js';
import { requierePermiso } from '../../middlewares/sesion.js';
import { idParam, validarBody, validarQuery } from '../../middlewares/validar.js';
import { auditar } from '../../shared/auditoria.js';
import { sha256 } from '../../shared/crypto.js';
import { tokenAleatorio } from '../../shared/claves.js';
import { ErrorApp, errores } from '../../shared/errors.js';
import * as usuarios from './usuarios.service.js';

export const usuariosRouter = Router();

usuariosRouter.get('/usuarios', requierePermiso('usuarios.ver'), validarQuery(paginacionQuery), async (_req, res) => {
  res.json(await usuarios.listar(res.locals.query as PaginacionQuery));
});

usuariosRouter.get('/usuarios/:id', requierePermiso('usuarios.ver'), async (req, res) => {
  res.json(await usuarios.obtener(idParam(req)));
});

usuariosRouter.post('/usuarios', requierePermiso('usuarios.editar'), validarBody(crearUsuarioSchema), async (req, res) => {
  const r = await usuarios.crear(req.body);
  await auditar(req, { accion: 'usuario.crear', entidad: 'usuario', entidadId: r.usuario.id, despues: r.usuario });
  res.status(201).json(r);
});

usuariosRouter.put('/usuarios/:id', requierePermiso('usuarios.editar'), validarBody(editarUsuarioSchema), async (req, res) => {
  const id = idParam(req);
  const { antes, despues } = await usuarios.editar(id, req.body, req.sesion!.usuario.id);
  await auditar(req, { accion: 'usuario.editar', entidad: 'usuario', entidadId: id, antes, despues });
  res.json(despues);
});

usuariosRouter.post('/usuarios/:id/restablecer-password', requierePermiso('usuarios.editar'), async (req, res) => {
  const id = idParam(req);
  const passwordTemporal = await usuarios.restablecerPassword(id);
  await auditar(req, { accion: 'usuario.restablecer_password', entidad: 'usuario', entidadId: id });
  res.json({ passwordTemporal });
});

usuariosRouter.post('/usuarios/:id/restablecer-pin', requierePermiso('usuarios.editar'), async (req, res) => {
  const id = idParam(req);
  await usuarios.restablecerPin(id);
  await auditar(req, { accion: 'usuario.restablecer_pin', entidad: 'usuario', entidadId: id });
  res.status(204).end();
});

usuariosRouter.get('/roles', requierePermiso('usuarios.ver'), async (_req, res) => {
  const roles = await db('roles').orderBy('id').select('id', 'codigo', 'nombre');
  const permisos = await db('rol_permisos as rp').join('permisos as p', 'p.id', 'rp.permiso_id').select('rp.rol_id', 'p.codigo');
  res.json(
    roles.map((r: { id: number | string; codigo: string; nombre: string }) => ({
      codigo: r.codigo,
      nombre: r.nombre,
      permisos: permisos.filter((p: { rol_id: number | string }) => Number(p.rol_id) === Number(r.id)).map((p: { codigo: string }) => p.codigo),
    })),
  );
});

usuariosRouter.get('/permisos', requierePermiso('usuarios.ver'), async (_req, res) => {
  res.json(await db('permisos').orderBy(['grupo', 'codigo']).select('codigo', 'grupo', 'descripcion'));
});

// ---------- Dispositivos (terminales del POS habilitadas para PIN) ----------

usuariosRouter.get('/dispositivos', requierePermiso('config.ver'), async (_req, res) => {
  const filas = await db('dispositivos as d')
    .join('sucursales as s', 's.id', 'd.sucursal_id')
    .orderBy('d.id')
    .select('d.id', 'd.nombre', 'd.activo', 'd.ultimo_uso as ultimoUso', 's.id as sucursalId', 's.nombre as sucursal');
  res.json(filas.map((f: Record<string, unknown>) => ({ ...f, id: Number(f.id), sucursalId: Number(f.sucursalId), activo: Boolean(f.activo) })));
});

usuariosRouter.post('/dispositivos', requierePermiso('config.editar'), validarBody(crearDispositivoSchema), async (req, res) => {
  const { nombre, sucursalId } = req.body as { nombre: string; sucursalId: number };
  if (!(await db('sucursales').where({ id: sucursalId, activo: true }).first('id'))) {
    throw new ErrorApp(422, 'VALIDACION', 'Sucursal inválida', { sucursalId: 'Sucursal inválida' });
  }
  // El token se entrega una sola vez; el navegador del POS lo guarda.
  const token = tokenAleatorio(32);
  const [id] = await db('dispositivos').insert({ nombre, sucursal_id: sucursalId, token_hash: sha256(token) });
  await auditar(req, { accion: 'dispositivo.crear', entidad: 'dispositivo', entidadId: Number(id), despues: { nombre, sucursalId } });
  res.status(201).json({ id: Number(id), nombre, sucursalId, dispositivoToken: token });
});

usuariosRouter.delete('/dispositivos/:id', requierePermiso('config.editar'), async (req, res) => {
  const id = idParam(req);
  const n = await db('dispositivos').where('id', id).update({ activo: false });
  if (!n) throw errores.noEncontrado('Dispositivo');
  // Las sesiones abiertas en ese dispositivo dejan de valer.
  await db('sesiones').where('dispositivo_id', id).delete();
  await auditar(req, { accion: 'dispositivo.desactivar', entidad: 'dispositivo', entidadId: id });
  res.status(204).end();
});
