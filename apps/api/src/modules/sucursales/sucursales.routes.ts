import { crearSucursalSchema, editarSucursalSchema, vincularSucursalSchema } from '@sv/shared';
import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso } from '../../middlewares/sesion.js';
import { idParam, validarBody } from '../../middlewares/validar.js';
import * as sucursales from './sucursales.service.js';

export const sucursalesRouter = Router();

/** Las asignadas al usuario; con sucursales.editar se ven todas, también las inactivas. */
sucursalesRouter.get('/sucursales', async (req, res) => {
  const s = req.sesion!;
  res.json(await sucursales.listar(s.permisos.has('sucursales.editar') ? undefined : s.sucursales.map((x) => x.id)));
});

sucursalesRouter.get('/sucursales/api-pro', requierePermiso('sucursales.editar'), async (_req, res) => {
  res.json(await sucursales.listarApi());
});

/** Crea aquí las sucursales que ya existen en API-PRO (con sus series). Solo lee de API-PRO. */
sucursalesRouter.post('/sucursales/importar', requierePermiso('sucursales.editar'), validarBody(z.object({ apiSucursalIds: z.array(z.coerce.number().int().positive()).max(50).optional() })), async (req, res) => {
  res.json(await sucursales.importar(req, (req.body as { apiSucursalIds?: number[] }).apiSucursalIds));
});

sucursalesRouter.post('/sucursales', requierePermiso('sucursales.editar'), validarBody(crearSucursalSchema), async (req, res) => {
  res.status(201).json(await sucursales.crear(req, req.body));
});

sucursalesRouter.put('/sucursales/:id', requierePermiso('sucursales.editar'), validarBody(editarSucursalSchema), async (req, res) => {
  res.json(await sucursales.editar(req, idParam(req), req.body));
});

sucursalesRouter.post('/sucursales/:id/vincular', requierePermiso('sucursales.editar'), validarBody(vincularSucursalSchema), async (req, res) => {
  res.json(await sucursales.vincular(req, idParam(req), (req.body as { apiSucursalId: number }).apiSucursalId));
});
