import { aplicarSerieSchema, validarSerieSchema } from '@sv/shared';
import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso } from '../../middlewares/sesion.js';
import { validarBody, validarQuery } from '../../middlewares/validar.js';
import * as series from './series.service.js';

export const seriesRouter = Router();

const filtro = z.object({
  sucursalId: z.coerce.number().int().positive().optional(),
  tipoDoc: z.enum(['01', '03', '07', '08', '09']).optional(),
  soloActivas: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

seriesRouter.get('/series', requierePermiso('series.ver'), validarQuery(filtro), async (_req, res) => {
  res.json(await series.listar(res.locals.query));
});

/** Series que el POS puede usar: propias, activas y de la sucursal activa. */
seriesRouter.get('/series/pos', requierePermiso('ventas.crear'), async (req, res) => {
  const sucursal = req.sesion!.sucursalActiva;
  if (!sucursal) {
    res.json([]);
    return;
  }
  const todas = await series.listar({ sucursalId: sucursal.id, soloActivas: true });
  res.json(todas.filter((s) => s.propia));
});

seriesRouter.post('/series/sincronizar', requierePermiso('series.ver'), async (_req, res) => {
  const sincronizadas = await series.sincronizar();
  res.json({ sincronizadas, series: await series.listar() });
});

/** Previsualización: bloqueos y advertencias sin aplicar ningún cambio. */
seriesRouter.post('/series/validar', requierePermiso('series.administrar'), validarBody(validarSerieSchema), async (req, res) => {
  res.json(await series.validar(req.body));
});

/** Aplica la operación en API-PRO (crear, correlativo, mover, activar) o localmente (predeterminada). */
seriesRouter.post('/series/operaciones', requierePermiso('series.administrar'), validarBody(aplicarSerieSchema), async (req, res) => {
  res.json(await series.aplicar(req, req.body));
});
