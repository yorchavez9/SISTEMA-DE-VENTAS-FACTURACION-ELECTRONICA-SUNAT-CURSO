import { fecha, tipoCambioSchema, type TipoCambioDto } from '@sv/shared';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../database/db.js';
import { requierePermiso } from '../../middlewares/sesion.js';
import { validarBody, validarQuery } from '../../middlewares/validar.js';
import { auditar } from '../../shared/auditoria.js';
import { ErrorApp, errores } from '../../shared/errors.js';
import { fechaLima } from '../../shared/fechas.js';

export const tiposCambioRouter = Router();

const aDto = (f: { fecha: string; compra: string; venta: string; fuente: 'manual' }): TipoCambioDto => ({
  fecha: f.fecha,
  compra: f.compra,
  venta: f.venta,
  fuente: f.fuente,
});

tiposCambioRouter.get('/tipos-cambio', validarQuery(z.object({ desde: fecha.optional(), hasta: fecha.optional() })), async (_req, res) => {
  const { desde, hasta } = res.locals.query as { desde?: string; hasta?: string };
  const q = db('tipos_cambio').orderBy('fecha', 'desc').limit(62).select('fecha', 'compra', 'venta', 'fuente');
  if (desde) q.where('fecha', '>=', desde);
  if (hasta) q.where('fecha', '<=', hasta);
  res.json((await q).map(aDto));
});

tiposCambioRouter.get('/tipos-cambio/hoy', async (_req, res) => {
  const hoy = fechaLima();
  const f = await db('tipos_cambio').where('fecha', hoy).first('fecha', 'compra', 'venta', 'fuente');
  if (!f) throw new ErrorApp(404, 'TIPO_CAMBIO_NO_REGISTRADO', `Registra el tipo de cambio de hoy (${hoy})`);
  res.json(aDto(f));
});

tiposCambioRouter.put('/tipos-cambio/:fecha', requierePermiso('tipocambio.editar'), validarBody(tipoCambioSchema), async (req, res) => {
  const dia = fecha.safeParse(req.params.fecha);
  if (!dia.success) throw errores.validacion({ fecha: 'Fecha inválida (AAAA-MM-DD)' });
  if (dia.data > fechaLima()) throw errores.validacion({ fecha: 'No se puede registrar un tipo de cambio futuro' });

  const { compra, venta } = req.body as { compra: string; venta: string };
  const antes = await db('tipos_cambio').where('fecha', dia.data).first('compra', 'venta');
  await db('tipos_cambio')
    .insert({ fecha: dia.data, compra, venta, fuente: 'manual', usuario_id: req.sesion!.usuario.id })
    .onConflict('fecha')
    .merge(['compra', 'venta', 'usuario_id']);
  await auditar(req, { accion: 'tipo_cambio.registrar', entidad: 'tipo_cambio', entidadId: dia.data, antes: antes ?? null, despues: { compra, venta } });
  res.json(aDto({ fecha: dia.data, compra, venta, fuente: 'manual' }));
});
