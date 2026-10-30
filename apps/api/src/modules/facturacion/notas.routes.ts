import { MOTIVOS_NC, MOTIVOS_ND, notaCreditoSchema, notaDebitoSchema } from '@sv/shared';
import { Router, type Request } from 'express';
import { db } from '../../database/db.js';
import { requierePermiso, requiereSucursal } from '../../middlewares/sesion.js';
import { idParam, validarBody } from '../../middlewares/validar.js';
import { auditar } from '../../shared/auditoria.js';
import { ErrorApp } from '../../shared/errors.js';
import { obtener as obtenerComprobante } from './comprobantes.service.js';
import * as notas from './notas.service.js';

export const notasRouter = Router();

function claveIdempotencia(req: Request): string {
  const clave = req.get('Idempotency-Key');
  if (!clave || !/^[0-9a-f-]{36}$/i.test(clave)) throw new ErrorApp(400, 'IDEMPOTENCY_KEY_REQUERIDA', 'Falta la cabecera Idempotency-Key');
  return clave;
}

async function verificarAcceso(req: Request, comprobanteId: number): Promise<void> {
  const c = await db('comprobantes').where('id', comprobanteId).first('sucursal_id');
  if (c && !req.sesion!.sucursales.some((s) => s.id === Number(c.sucursal_id))) throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'El comprobante es de otra sucursal');
}

notasRouter.get('/notas/motivos', (_req, res) => {
  res.json({ credito: MOTIVOS_NC, debito: MOTIVOS_ND });
});

/** Saldo acreditable del comprobante, por línea, y las series disponibles para sus notas. */
notasRouter.get('/comprobantes/:id/saldo-nota', requierePermiso('notas.crear'), async (req, res) => {
  const id = idParam(req);
  await verificarAcceso(req, id);
  res.json(await notas.saldo(id, requiereSucursal(req).id));
});

notasRouter.post('/notas-credito', requierePermiso('notas.crear'), validarBody(notaCreditoSchema), async (req, res) => {
  await verificarAcceso(req, req.body.comprobanteAfectadoId);
  const id = await notas.crearNotaCredito(req.body, { sucursalId: requiereSucursal(req).id, operadorId: req.sesion!.operador.id, idempotencyKey: claveIdempotencia(req) });
  const nota = await obtenerComprobante(id);
  await auditar(req, { accion: 'nota_credito.crear', entidad: 'comprobante', entidadId: id, despues: { afectado: req.body.comprobanteAfectadoId, motivo: req.body.codMotivo, total: nota.total, reintegro: req.body.reintegro.tipo } });
  res.status(201).json(nota);
});

notasRouter.post('/notas-debito', requierePermiso('notas.crear'), validarBody(notaDebitoSchema), async (req, res) => {
  await verificarAcceso(req, req.body.comprobanteAfectadoId);
  const id = await notas.crearNotaDebito(req.body, { sucursalId: requiereSucursal(req).id, operadorId: req.sesion!.operador.id, idempotencyKey: claveIdempotencia(req) });
  const nota = await obtenerComprobante(id);
  await auditar(req, { accion: 'nota_debito.crear', entidad: 'comprobante', entidadId: id, despues: { afectado: req.body.comprobanteAfectadoId, motivo: req.body.codMotivo, total: nota.total, cobro: req.body.cobro.tipo } });
  res.status(201).json(nota);
});
