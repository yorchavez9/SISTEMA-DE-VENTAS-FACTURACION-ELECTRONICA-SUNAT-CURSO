import { enviarIndividualSchema, enviarResumenSchema, fecha } from '@sv/shared';
import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso } from '../../middlewares/sesion.js';
import { idParam, validarBody, validarQuery } from '../../middlewares/validar.js';
import { auditar } from '../../shared/auditoria.js';
import * as resumenes from './resumenes.service.js';

export const resumenesRouter = Router();

resumenesRouter.get('/resumenes', requierePermiso('resumenes.ver'), async (_req, res) => {
  res.json(await resumenes.listar());
});

resumenesRouter.get('/resumenes/pendientes', requierePermiso('resumenes.ver'), async (_req, res) => {
  res.json(await resumenes.pendientes());
});

/** Comprobación previa sin efectos: ¿el RC de esa fecha tendría solo boletas de este sistema? */
resumenesRouter.post('/resumenes/verificar', requierePermiso('resumenes.enviar'), validarBody(enviarResumenSchema), async (req, res) => {
  res.json(await resumenes.verificar((req.body as { fecha: string }).fecha));
});

resumenesRouter.post('/resumenes', requierePermiso('resumenes.enviar'), validarBody(enviarResumenSchema), async (req, res) => {
  const { fecha: f } = req.body as { fecha: string };
  const r = await resumenes.enviar(f, { usuarioId: req.sesion!.operador.id });
  await auditar(req, { accion: 'resumen.enviar', entidad: 'resumen', entidadId: r.id, despues: { fecha: f, estado: r.estado, documentos: r.documentos } });
  res.status(201).json(r);
});

resumenesRouter.post('/resumenes/enviar-individual', requierePermiso('resumenes.enviar'), validarBody(enviarIndividualSchema), async (req, res) => {
  const r = await resumenes.enviarIndividual((req.body as { comprobanteIds: number[] }).comprobanteIds);
  await auditar(req, { accion: 'resumen.enviar_individual', entidad: 'comprobante', despues: r });
  res.json(r);
});

resumenesRouter.get('/resumenes/boletas', requierePermiso('resumenes.ver'), validarQuery(z.object({ fecha })), async (_req, res) => {
  const { db } = await import('../../database/db.js');
  const filas = await db('comprobantes').where({ tipo_doc: '03', estado: 'pendiente_resumen', fecha_emision: (res.locals.query as { fecha: string }).fecha }).orderBy('id').select('id', 'numero_completo', 'cliente_razon_social', 'total', 'moneda');
  res.json(filas.map((f: Record<string, unknown>) => ({ id: Number(f.id), numero: f.numero_completo, cliente: f.cliente_razon_social, total: f.total, moneda: f.moneda })));
});

resumenesRouter.get('/resumenes/:id', requierePermiso('resumenes.ver'), async (req, res) => {
  res.json(await resumenes.obtener(idParam(req)));
});
