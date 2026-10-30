import { anularVentaSchema, cotizarSchema, fecha, ventaSchema } from '@sv/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { requierePermiso, requiereSucursal } from '../../middlewares/sesion.js';
import { idParam, validarBody, validarQuery } from '../../middlewares/validar.js';
import { auditar } from '../../shared/auditoria.js';
import { ErrorApp } from '../../shared/errors.js';
import * as ventas from './ventas.service.js';

export const ventasRouter = Router();

function claveIdempotencia(req: Request): string {
  const clave = req.get('Idempotency-Key');
  if (!clave || !/^[0-9a-f-]{36}$/i.test(clave)) throw new ErrorApp(400, 'IDEMPOTENCY_KEY_REQUERIDA', 'Falta la cabecera Idempotency-Key');
  return clave;
}

/** Totales oficiales antes de cobrar (sin efectos). */
ventasRouter.post('/ventas/cotizar', requierePermiso('ventas.crear'), validarBody(cotizarSchema), async (req, res) => {
  const { calculo, tipoCambio, tasaIgv } = await ventas.cotizar(req.body);
  res.json({ ...calculo, tipoCambio, tasaIgv });
});

ventasRouter.post('/ventas', requierePermiso('ventas.crear'), validarBody(ventaSchema), async (req, res) => {
  const s = req.sesion!;
  const { venta, repetida, vuelto } = await ventas.registrar(req.body, {
    sucursalId: requiereSucursal(req).id,
    operadorId: s.operador.id,
    permisos: s.permisos,
    idempotencyKey: claveIdempotencia(req),
  });
  if (repetida) {
    res.setHeader('Idempotent-Replay', 'true');
    res.json({ venta, vuelto });
    return;
  }
  await auditar(req, { accion: 'venta.registrar', entidad: 'venta', entidadId: venta.id, despues: { total: venta.total, moneda: venta.moneda, formaPago: venta.formaPago, descuento: venta.descuento } });
  res.status(201).json({ venta, vuelto });
});

ventasRouter.get(
  '/ventas',
  requierePermiso('ventas.ver'),
  validarQuery(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
      desde: fecha.optional(),
      hasta: fecha.optional(),
      formaPago: z.enum(['contado', 'credito']).optional(),
      estado: z.enum(['confirmada', 'anulacion_en_proceso', 'anulada']).optional(),
    }),
  ),
  async (req, res) => {
    res.json(await ventas.listar(req.sesion!.sucursales.map((x) => x.id), res.locals.query));
  },
);

ventasRouter.get('/ventas/:id', requierePermiso('ventas.ver'), async (req, res) => {
  const v = await ventas.obtener(idParam(req));
  if (!req.sesion!.sucursales.some((s) => s.id === v.sucursal.id)) throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'La venta es de otra sucursal');
  res.json(v);
});

ventasRouter.post('/ventas/:id/anular-interna', requierePermiso('ventas.crear'), validarBody(anularVentaSchema), async (req, res) => {
  const id = idParam(req);
  const s = req.sesion!;
  const antes = await ventas.obtener(id);
  const despues = await ventas.anularInterna(id, req.body, { sucursalId: requiereSucursal(req).id, operadorId: s.operador.id, permisos: s.permisos });
  await auditar(req, { accion: 'venta.anular_interna', entidad: 'venta', entidadId: id, antes: { estado: antes.estado }, despues: { estado: despues.estado, motivo: (req.body as { motivo: string }).motivo } });
  res.json(despues);
});
