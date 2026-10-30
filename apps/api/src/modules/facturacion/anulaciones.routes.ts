import { anulacionSchema, reembolsoSchema, validarAnulacionSchema, type AnulacionInput } from '@sv/shared';
import { Router, type Request } from 'express';
import { requierePermiso, requiereSucursal } from '../../middlewares/sesion.js';
import { idParam, validarBody } from '../../middlewares/validar.js';
import { auditar } from '../../shared/auditoria.js';
import { ErrorApp } from '../../shared/errors.js';
import * as anulaciones from './anulaciones.service.js';

export const anulacionesRouter = Router();

const sucursalesDe = (req: Request) => req.sesion!.sucursales.map((s) => s.id);

/** Previsualización: mecanismo (RA o RC), plazo, bloqueos y advertencias. Sin efectos. */
anulacionesRouter.post('/anulaciones/validar', requierePermiso('comprobantes.anular'), validarBody(validarAnulacionSchema), async (req, res) => {
  const { comprobantes: _omitidos, ...v } = await anulaciones.validar((req.body as { comprobanteIds: number[] }).comprobanteIds, sucursalesDe(req));
  res.json(v);
});

anulacionesRouter.post('/anulaciones', requierePermiso('comprobantes.anular'), validarBody(anulacionSchema), async (req, res) => {
  const clave = req.get('Idempotency-Key');
  if (!clave || !/^[0-9a-f-]{36}$/i.test(clave)) throw new ErrorApp(400, 'IDEMPOTENCY_KEY_REQUERIDA', 'Falta la cabecera Idempotency-Key');
  const datos = req.body as AnulacionInput;
  const r = await anulaciones.solicitar(datos.comprobanteIds, datos.motivo, { sucursalIds: sucursalesDe(req), usuarioId: req.sesion!.operador.id, idempotencyKey: clave });
  await auditar(req, { accion: 'comprobante.anular', entidad: r.mecanismo === 'RA' ? 'baja' : 'resumen', entidadId: r.id, despues: { comprobantes: datos.comprobanteIds, motivo: datos.motivo, mecanismo: r.mecanismo } });
  res.status(201).json(r);
});

anulacionesRouter.get('/anulaciones', requierePermiso('comprobantes.ver'), async (_req, res) => {
  res.json(await anulaciones.listar());
});

/** Devolución del dinero de una venta anulada por SUNAT, desde la caja abierta. */
anulacionesRouter.post('/ventas/:id/reembolsar', requierePermiso('caja.movimientos'), validarBody(reembolsoSchema), async (req, res) => {
  const id = idParam(req);
  const monto = await anulaciones.reembolsar(id, req.body, { sucursalId: requiereSucursal(req).id, usuarioId: req.sesion!.operador.id });
  await auditar(req, { accion: 'venta.reembolsar', entidad: 'venta', entidadId: id, despues: { monto } });
  res.json({ reembolsado: monto });
});
