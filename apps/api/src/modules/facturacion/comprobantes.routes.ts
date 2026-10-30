import { corregirComprobanteSchema, filtroComprobantesSchema, FORMATOS_PDF, type FormatoPdf } from '@sv/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { db } from '../../database/db.js';
import { requierePermiso } from '../../middlewares/sesion.js';
import { idParam, validarBody, validarQuery } from '../../middlewares/validar.js';
import { auditar } from '../../shared/auditoria.js';
import { ErrorApp } from '../../shared/errors.js';
import * as comprobantes from './comprobantes.service.js';

export const comprobantesRouter = Router();

const sucursalesDe = (req: Request) => req.sesion!.sucursales.map((s) => s.id);

async function verificarAcceso(req: Request, id: number): Promise<void> {
  const c = await db('comprobantes').where('id', id).first('sucursal_id');
  if (c && !sucursalesDe(req).includes(Number(c.sucursal_id))) throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'El comprobante es de otra sucursal');
}

comprobantesRouter.get('/comprobantes', requierePermiso('comprobantes.ver'), validarQuery(filtroComprobantesSchema), async (req, res) => {
  res.json(await comprobantes.listar(sucursalesDe(req), res.locals.query));
});

comprobantesRouter.get('/comprobantes/:id', requierePermiso('comprobantes.ver'), async (req, res) => {
  const id = idParam(req);
  await verificarAcceso(req, id);
  res.json(await comprobantes.obtener(id));
});

comprobantesRouter.post('/comprobantes/:id/reintentar', requierePermiso('comprobantes.emitir'), async (req, res) => {
  const id = idParam(req);
  await verificarAcceso(req, id);
  const d = await comprobantes.reintentar(id);
  await auditar(req, { accion: 'comprobante.reintentar', entidad: 'comprobante', entidadId: id, despues: { estado: d.estado } });
  res.json(d);
});

comprobantesRouter.post('/comprobantes/:id/consultar', requierePermiso('comprobantes.emitir'), async (req, res) => {
  const id = idParam(req);
  await verificarAcceso(req, id);
  res.json(await comprobantes.consultar(id));
});

comprobantesRouter.put('/comprobantes/:id/corregir', requierePermiso('comprobantes.corregir'), validarBody(corregirComprobanteSchema), async (req, res) => {
  const id = idParam(req);
  await verificarAcceso(req, id);
  const antes = await comprobantes.obtener(id);
  const d = await comprobantes.corregir(id, (req.body as { cliente: { tipoDoc: string; numDoc: string; razonSocial: string; direccion?: string } }).cliente);
  await auditar(req, { accion: 'comprobante.corregir', entidad: 'comprobante', entidadId: id, antes: antes.cliente, despues: d.cliente });
  res.json(d);
});

const formato = z.object({ formato: z.enum(FORMATOS_PDF).default('a4') });

for (const que of ['pdf', 'xml', 'cdr'] as const) {
  comprobantesRouter.get(`/comprobantes/:id/${que}`, requierePermiso('comprobantes.ver'), validarQuery(formato), async (req, res) => {
    const id = idParam(req);
    await verificarAcceso(req, id);
    const r = await comprobantes.archivo(id, que, (res.locals.query as { formato: FormatoPdf }).formato);
    res.setHeader('Content-Type', r.contentType);
    res.setHeader('Content-Disposition', `${que === 'pdf' ? 'inline' : 'attachment'}; filename="${r.nombre}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(r.datos);
  });
}
