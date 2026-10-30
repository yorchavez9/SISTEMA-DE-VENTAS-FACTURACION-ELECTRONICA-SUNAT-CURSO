import type { TrasladoDto, TrasladoInput } from '@sv/shared';
import type { Knex } from 'knex';
import { db } from '../../database/db.js';
import { aCantidad } from '../../shared/decimal.js';
import { ErrorApp, errores } from '../../shared/errors.js';
import { mover } from './inventario.service.js';

// Traslado en dos pasos: la salida descuenta el origen al enviar; la entrada suma en el destino
// cuando la sucursal de destino confirma la recepción. Mientras está "enviado", la mercadería
// está en tránsito (no figura en ninguna de las dos sucursales).

async function obtener(id: number, conn: Knex = db): Promise<TrasladoDto> {
  const t = await conn('traslados as t')
    .join('sucursales as so', 'so.id', 't.sucursal_origen_id')
    .join('sucursales as sd', 'sd.id', 't.sucursal_destino_id')
    .join('usuarios as ue', 'ue.id', 't.enviado_por')
    .leftJoin('usuarios as ur', 'ur.id', 't.recibido_por')
    .where('t.id', id)
    .first('t.*', 'so.nombre as origen_nombre', 'sd.nombre as destino_nombre', 'ue.nombre as enviado_nombre', 'ur.nombre as recibido_nombre');
  if (!t) throw errores.noEncontrado('Traslado');
  const items = await conn('traslado_items as i').join('productos as p', 'p.id', 'i.producto_id').where('i.traslado_id', id).orderBy('i.id').select('i.producto_id', 'i.cantidad', 'p.codigo', 'p.nombre');
  return {
    id: Number(t.id),
    origen: { id: Number(t.sucursal_origen_id), nombre: t.origen_nombre },
    destino: { id: Number(t.sucursal_destino_id), nombre: t.destino_nombre },
    estado: t.estado,
    nota: t.nota ?? null,
    enviadoPor: t.enviado_nombre,
    recibidoPor: t.recibido_nombre ?? null,
    creadoEn: new Date(t.created_at).toISOString(),
    recibidoEn: t.recibido_en ? new Date(t.recibido_en).toISOString() : null,
    items: items.map((i: Record<string, unknown>) => ({ productoId: Number(i.producto_id), codigo: String(i.codigo), nombre: String(i.nombre), cantidad: String(i.cantidad) })),
  };
}

export { obtener as obtenerTraslado };

export async function listarTraslados(sucursalIds: number[], estado?: string): Promise<TrasladoDto[]> {
  const q = db('traslados').where((w) => w.whereIn('sucursal_origen_id', sucursalIds).orWhereIn('sucursal_destino_id', sucursalIds)).orderBy('id', 'desc').limit(200);
  if (estado) q.where('estado', estado);
  const ids = await q.pluck('id');
  return Promise.all(ids.map((id: number | string) => obtener(Number(id))));
}

export async function enviar(datos: TrasladoInput, ctx: { origenId: number; usuarioId: number; idempotencyKey: string }): Promise<{ traslado: TrasladoDto; repetido: boolean }> {
  const previo = await db('traslados').where('idempotency_key', ctx.idempotencyKey).first('id');
  if (previo) return { traslado: await obtener(Number(previo.id)), repetido: true };

  if (datos.sucursalDestinoId === ctx.origenId) throw errores.validacion({ sucursalDestinoId: 'El destino debe ser otra sucursal' });
  const destino = await db('sucursales').where({ id: datos.sucursalDestinoId, activo: true }).first('id');
  if (!destino) throw errores.validacion({ sucursalDestinoId: 'Sucursal de destino inválida' });
  const noInventariables = await db('productos').whereIn('id', datos.items.map((i) => i.productoId)).where('inventariable', false).pluck('nombre');
  if (noInventariables.length) throw errores.validacion({ items: `No llevan inventario: ${noInventariables.join(', ')}` });

  const id = await db.transaction(async (trx) => {
    const [trasladoId] = await trx('traslados').insert({
      sucursal_origen_id: ctx.origenId,
      sucursal_destino_id: datos.sucursalDestinoId,
      nota: datos.nota ?? null,
      enviado_por: ctx.usuarioId,
      idempotency_key: ctx.idempotencyKey,
    });
    await trx('traslado_items').insert(datos.items.map((i) => ({ traslado_id: trasladoId, producto_id: i.productoId, cantidad: aCantidad(i.cantidad) })));
    await mover(trx, {
      sucursalId: ctx.origenId,
      usuarioId: ctx.usuarioId,
      origenTipo: 'traslado',
      origenId: Number(trasladoId),
      nota: datos.nota,
      lineas: datos.items.map((i) => ({ productoId: i.productoId, cantidad: `-${i.cantidad}`, tipo: 'traslado_salida' as const })),
    });
    return Number(trasladoId);
  }).catch(async (err) => {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      const otro = await db('traslados').where('idempotency_key', ctx.idempotencyKey).first('id');
      if (otro) return Number(otro.id);
    }
    throw err;
  });
  return { traslado: await obtener(id), repetido: false };
}

async function cambiarEstado(
  id: number,
  accion: 'recibir' | 'anular',
  ctx: { usuarioId: number; sucursalesPermitidas: number[] },
): Promise<{ antes: TrasladoDto; despues: TrasladoDto }> {
  return db.transaction(async (trx) => {
    const t = await trx('traslados').where('id', id).forUpdate().first();
    if (!t) throw errores.noEncontrado('Traslado');
    if (t.estado !== 'enviado') throw new ErrorApp(409, 'ESTADO_NO_PERMITE', `El traslado ya está ${t.estado}`);
    // Recibe la sucursal de destino; anula (devuelve al origen) la sucursal de origen.
    const sucursal = Number(accion === 'recibir' ? t.sucursal_destino_id : t.sucursal_origen_id);
    if (!ctx.sucursalesPermitidas.includes(sucursal)) {
      throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', accion === 'recibir' ? 'Solo la sucursal de destino puede recibir el traslado' : 'Solo la sucursal de origen puede anular el traslado');
    }
    const antes = await obtener(id, trx);
    const items = await trx('traslado_items').where('traslado_id', id).select('producto_id', 'cantidad');
    await mover(trx, {
      sucursalId: sucursal,
      usuarioId: ctx.usuarioId,
      origenTipo: 'traslado',
      origenId: id,
      lineas: items.map((i: { producto_id: number | string; cantidad: string }) => ({
        productoId: Number(i.producto_id),
        cantidad: i.cantidad,
        tipo: accion === 'recibir' ? ('traslado_entrada' as const) : ('anulacion_traslado' as const),
      })),
    });
    await trx('traslados')
      .where('id', id)
      .update(accion === 'recibir' ? { estado: 'recibido', recibido_por: ctx.usuarioId, recibido_en: trx.raw('CURRENT_TIMESTAMP(3)') } : { estado: 'anulado' });
    return { antes, despues: await obtener(id, trx) };
  });
}

export const recibir = (id: number, ctx: { usuarioId: number; sucursalesPermitidas: number[] }) => cambiarEstado(id, 'recibir', ctx);
export const anularTraslado = (id: number, ctx: { usuarioId: number; sucursalesPermitidas: number[] }) => cambiarEstado(id, 'anular', ctx);
