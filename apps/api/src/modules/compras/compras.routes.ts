import { anularSchema, compraSchema, filtroComprasSchema, trasladoSchema } from '@sv/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { requierePermiso, requiereSucursal } from '../../middlewares/sesion.js';
import { idParam, validarBody, validarQuery } from '../../middlewares/validar.js';
import { auditar } from '../../shared/auditoria.js';
import { ErrorApp } from '../../shared/errors.js';
import { anularTraslado, enviar, listarTraslados, obtenerTraslado, recibir } from '../inventario/traslados.service.js';
import * as compras from './compras.service.js';

export const comprasRouter = Router();

function claveIdempotencia(req: Request): string {
  const clave = req.get('Idempotency-Key');
  if (!clave || !/^[0-9a-f-]{36}$/i.test(clave)) throw new ErrorApp(400, 'IDEMPOTENCY_KEY_REQUERIDA', 'Falta la cabecera Idempotency-Key');
  return clave;
}

const sucursalesDe = (req: Request) => req.sesion!.sucursales.map((s) => s.id);

// ---------- Compras ----------

comprasRouter.get('/compras', requierePermiso('compras.ver'), validarQuery(filtroComprasSchema), async (req, res) => {
  res.json(await compras.listar(sucursalesDe(req), res.locals.query));
});

comprasRouter.get('/compras/:id', requierePermiso('compras.ver'), async (req, res) => {
  const c = await compras.obtener(idParam(req));
  if (!sucursalesDe(req).includes(c.sucursal.id)) throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'No tienes acceso a esa sucursal');
  res.json(c);
});

comprasRouter.post('/compras', requierePermiso('compras.crear'), validarBody(compraSchema), async (req, res) => {
  const { compra, repetida } = await compras.registrar(req.body, {
    sucursalId: requiereSucursal(req).id,
    usuarioId: req.sesion!.operador.id,
    idempotencyKey: claveIdempotencia(req),
  });
  if (repetida) {
    res.setHeader('Idempotent-Replay', 'true');
    res.json(compra);
    return;
  }
  await auditar(req, { accion: 'compra.registrar', entidad: 'compra', entidadId: compra.id, despues: compra });
  res.status(201).json(compra);
});

comprasRouter.post('/compras/:id/anular', requierePermiso('compras.anular'), validarBody(anularSchema), async (req, res) => {
  const id = idParam(req);
  const actual = await compras.obtener(id);
  if (!sucursalesDe(req).includes(actual.sucursal.id)) throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'No tienes acceso a esa sucursal');
  const { antes, despues } = await compras.anular(id, (req.body as { motivo: string }).motivo, { usuarioId: req.sesion!.operador.id });
  await auditar(req, { accion: 'compra.anular', entidad: 'compra', entidadId: id, antes, despues });
  res.json(despues);
});

// ---------- Traslados entre sucursales ----------

comprasRouter.get('/inventario/traslados', requierePermiso('inventario.ver'), validarQuery(z.object({ estado: z.enum(['enviado', 'recibido', 'anulado']).optional() })), async (req, res) => {
  res.json(await listarTraslados(sucursalesDe(req), (res.locals.query as { estado?: string }).estado));
});

comprasRouter.get('/inventario/traslados/:id', requierePermiso('inventario.ver'), async (req, res) => {
  const t = await obtenerTraslado(idParam(req));
  if (![t.origen.id, t.destino.id].some((s) => sucursalesDe(req).includes(s))) throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'No tienes acceso a ese traslado');
  res.json(t);
});

comprasRouter.post('/inventario/traslados', requierePermiso('inventario.trasladar'), validarBody(trasladoSchema), async (req, res) => {
  const { traslado, repetido } = await enviar(req.body, {
    origenId: requiereSucursal(req).id,
    usuarioId: req.sesion!.operador.id,
    idempotencyKey: claveIdempotencia(req),
  });
  if (repetido) {
    res.setHeader('Idempotent-Replay', 'true');
    res.json(traslado);
    return;
  }
  await auditar(req, { accion: 'traslado.enviar', entidad: 'traslado', entidadId: traslado.id, despues: traslado });
  res.status(201).json(traslado);
});

for (const [ruta, fn, accion] of [['recibir', recibir, 'traslado.recibir'], ['anular', anularTraslado, 'traslado.anular']] as const) {
  comprasRouter.post(`/inventario/traslados/:id/${ruta}`, requierePermiso('inventario.trasladar'), async (req, res) => {
    const id = idParam(req);
    const { antes, despues } = await fn(id, { usuarioId: req.sesion!.operador.id, sucursalesPermitidas: sucursalesDe(req) });
    await auditar(req, { accion, entidad: 'traslado', entidadId: id, antes, despues });
    res.json(despues);
  });
}
