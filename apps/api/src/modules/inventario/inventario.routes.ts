import { ajusteSchema, fecha, type AjusteInput, type MovimientoDto } from '@sv/shared';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../database/db.js';
import { requierePermiso, requiereSucursal } from '../../middlewares/sesion.js';
import { validarBody, validarQuery } from '../../middlewares/validar.js';
import { auditar } from '../../shared/auditoria.js';
import { dec } from '../../shared/decimal.js';
import { ErrorApp, errores } from '../../shared/errors.js';
import { mover } from './inventario.service.js';

export const inventarioRouter = Router();

/** Kardex de un producto en la sucursal activa (o la indicada, si el usuario tiene acceso). */
inventarioRouter.get(
  '/inventario/kardex/:productoId',
  requierePermiso('inventario.ver'),
  validarQuery(z.object({ sucursalId: z.coerce.number().int().positive().optional(), desde: fecha.optional(), hasta: fecha.optional() })),
  async (req, res) => {
    const productoId = Number(req.params.productoId);
    if (!Number.isInteger(productoId) || productoId <= 0) throw errores.noEncontrado('Producto');
    const f = res.locals.query as { sucursalId?: number; desde?: string; hasta?: string };
    const sucursalId = f.sucursalId ?? requiereSucursal(req).id;
    if (!req.sesion!.sucursales.some((s) => s.id === sucursalId)) throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'No tienes acceso a esa sucursal');

    const q = db('movimientos_stock as m')
      .leftJoin('usuarios as u', 'u.id', 'm.usuario_id')
      .where({ 'm.producto_id': productoId, 'm.sucursal_id': sucursalId })
      .orderBy('m.id', 'desc')
      .limit(500)
      .select('m.*', 'u.nombre as usuario');
    if (f.desde) q.where('m.fecha', '>=', `${f.desde} 05:00:00`); // 00:00 en Lima = 05:00 UTC
    if (f.hasta) q.where('m.fecha', '<', db.raw('DATE_ADD(?, INTERVAL 29 HOUR)', [f.hasta]));
    const filas = await q;
    res.json(
      filas.map((m: Record<string, unknown>): MovimientoDto => ({
        id: Number(m.id),
        fecha: new Date(m.fecha as string).toISOString(),
        tipo: String(m.tipo),
        cantidad: String(m.cantidad),
        stockResultante: String(m.stock_resultante),
        costoUnitario: m.costo_unitario == null ? null : String(m.costo_unitario),
        origenTipo: String(m.origen_tipo),
        origenId: Number(m.origen_id),
        usuario: (m.usuario as string | null) ?? null,
        nota: (m.nota as string | null) ?? null,
      })),
    );
  },
);

/**
 * Ajuste de inventario (entradas y salidas con motivo). Exige Idempotency-Key:
 * reenviar el mismo ajuste devuelve el original sin mover el stock otra vez.
 */
inventarioRouter.post('/inventario/ajustes', requierePermiso('inventario.ajustar'), validarBody(ajusteSchema), async (req, res) => {
  const clave = req.get('Idempotency-Key');
  if (!clave || !/^[0-9a-f-]{36}$/i.test(clave)) throw new ErrorApp(400, 'IDEMPOTENCY_KEY_REQUERIDA', 'Falta la cabecera Idempotency-Key');
  const sucursal = requiereSucursal(req);
  const datos = req.body as AjusteInput;

  const existente = await db('ajustes_inventario').where('idempotency_key', clave).first('id');
  if (existente) {
    res.setHeader('Idempotent-Replay', 'true');
    res.json({ id: Number(existente.id) });
    return;
  }

  const id = await db.transaction(async (trx) => {
    const [ajusteId] = await trx('ajustes_inventario').insert({
      sucursal_id: sucursal.id,
      usuario_id: req.sesion!.operador.id,
      motivo: datos.motivo,
      idempotency_key: clave,
    });
    await trx('ajuste_items').insert(datos.items.map((i) => ({ ajuste_id: ajusteId, producto_id: i.productoId, cantidad: i.cantidad })));
    const resultado = await mover(trx, {
      sucursalId: sucursal.id,
      usuarioId: req.sesion!.operador.id,
      origenTipo: 'ajuste',
      origenId: Number(ajusteId),
      nota: datos.motivo,
      lineas: datos.items.map((i) => ({ productoId: i.productoId, cantidad: i.cantidad, tipo: dec(i.cantidad).isNegative() ? 'ajuste_salida' : 'ajuste_entrada' })),
    });
    if (resultado.every((r) => !r.aplicado)) throw new ErrorApp(422, 'VALIDACION', 'Ningún producto del ajuste lleva inventario');
    await auditar(req, { accion: 'inventario.ajuste', entidad: 'ajuste', entidadId: Number(ajusteId), despues: { ...datos, resultado } }, trx);
    return Number(ajusteId);
  }).catch(async (err) => {
    // Dos envíos simultáneos con la misma clave: el segundo choca con el índice único y devuelve el primero.
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      const otro = await db('ajustes_inventario').where('idempotency_key', clave).first('id');
      if (otro) return Number(otro.id);
    }
    throw err;
  });
  res.status(201).json({ id });
});
