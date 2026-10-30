import type { CompraDto, CompraInput, Pagina, TipoDocCompra } from '@sv/shared';
import type { Knex } from 'knex';
import { db } from '../../database/db.js';
import { aCantidad, aPrecio } from '../../shared/decimal.js';
import { ErrorApp, errores } from '../../shared/errors.js';
import { fechaLima } from '../../shared/fechas.js';
import { mover } from '../inventario/inventario.service.js';
import { calcularCompra } from './compras.calculo.js';

const base = (conn: Knex = db) =>
  conn('compras as c')
    .join('proveedores as p', 'p.id', 'c.proveedor_id')
    .join('sucursales as s', 's.id', 'c.sucursal_id')
    .join('usuarios as u', 'u.id', 'c.usuario_id')
    .select('c.*', 'p.razon_social as proveedor_nombre', 'p.num_doc as proveedor_doc', 's.nombre as sucursal_nombre', 'u.nombre as usuario_nombre');

function aDto(f: Record<string, unknown>): CompraDto {
  return {
    id: Number(f.id),
    proveedor: { id: Number(f.proveedor_id), razonSocial: String(f.proveedor_nombre), numDoc: String(f.proveedor_doc) },
    sucursal: { id: Number(f.sucursal_id), nombre: String(f.sucursal_nombre) },
    tipoDocCompra: f.tipo_doc_compra as TipoDocCompra,
    serieNumero: String(f.serie_numero),
    fecha: String(f.fecha),
    moneda: f.moneda as 'PEN' | 'USD',
    tipoCambio: String(f.tipo_cambio),
    preciosIncluyenIgv: Boolean(f.precios_incluyen_igv),
    tasaIgv: String(f.tasa_igv),
    subtotal: String(f.subtotal),
    igv: String(f.igv),
    total: String(f.total),
    estado: f.estado as 'registrada' | 'anulada',
    nota: (f.nota as string | null) ?? null,
    motivoAnulacion: (f.motivo_anulacion as string | null) ?? null,
    usuario: String(f.usuario_nombre),
    creadoEn: new Date(f.created_at as string).toISOString(),
  };
}

export async function obtener(id: number, conn: Knex = db): Promise<CompraDto> {
  const f = await base(conn).where('c.id', id).first();
  if (!f) throw errores.noEncontrado('Compra');
  const items = await conn('compra_items as i')
    .join('productos as p', 'p.id', 'i.producto_id')
    .where('i.compra_id', id)
    .orderBy('i.id')
    .select('i.*', 'p.codigo', 'p.nombre');
  return {
    ...aDto(f),
    items: items.map((i: Record<string, unknown>) => ({
      productoId: Number(i.producto_id),
      codigo: String(i.codigo),
      nombre: String(i.nombre),
      cantidad: String(i.cantidad),
      costoUnitario: String(i.costo_unitario),
      costoNetoPen: String(i.costo_neto_pen),
      total: String(i.total),
    })),
  };
}

export async function listar(
  sucursalIds: number[],
  f: { page: number; pageSize: number; desde?: string; hasta?: string; proveedorId?: number; estado?: 'registrada' | 'anulada'; q?: string },
): Promise<Pagina<CompraDto>> {
  const filtrar = (q: Knex.QueryBuilder) => {
    q.whereIn('c.sucursal_id', sucursalIds);
    if (f.desde) q.where('c.fecha', '>=', f.desde);
    if (f.hasta) q.where('c.fecha', '<=', f.hasta);
    if (f.proveedorId) q.where('c.proveedor_id', f.proveedorId);
    if (f.estado) q.where('c.estado', f.estado);
    if (f.q) q.where((w) => w.where('c.serie_numero', 'like', `%${f.q!.replace(/[\\%_]/g, '')}%`).orWhereILike('p.razon_social', `%${f.q!.replace(/[\\%_]/g, '')}%`));
  };
  const [{ total }] = (await db('compras as c').join('proveedores as p', 'p.id', 'c.proveedor_id').modify(filtrar).count({ total: '*' })) as [{ total: number }];
  const filas = await base().modify(filtrar).orderBy([{ column: 'c.fecha', order: 'desc' }, { column: 'c.id', order: 'desc' }]).limit(f.pageSize).offset((f.page - 1) * f.pageSize);
  return { data: filas.map(aDto), page: f.page, pageSize: f.pageSize, total: Number(total) };
}

/** Registra la compra y su entrada al inventario en una sola transacción. Idempotente por clave. */
export async function registrar(
  datos: CompraInput,
  ctx: { sucursalId: number; usuarioId: number; idempotencyKey: string },
): Promise<{ compra: CompraDto; repetida: boolean }> {
  const previa = await db('compras').where('idempotency_key', ctx.idempotencyKey).first('id');
  if (previa) return { compra: await obtener(Number(previa.id)), repetida: true };

  if (datos.fecha > fechaLima()) throw errores.validacion({ fecha: 'La fecha no puede ser futura' });
  const proveedor = await db('proveedores').where('id', datos.proveedorId).first('id', 'activo');
  if (!proveedor) throw errores.validacion({ proveedorId: 'Proveedor inválido' });
  if (!proveedor.activo) throw errores.validacion({ proveedorId: 'El proveedor está desactivado' });

  const dup = await db('compras')
    .where({ proveedor_id: datos.proveedorId, tipo_doc_compra: datos.tipoDocCompra, serie_numero: datos.serieNumero })
    .first('id', 'estado');
  if (dup) throw new ErrorApp(409, 'DUPLICADO', `Ese comprobante del proveedor ya está registrado (compra ${dup.id}, ${dup.estado})`, { serieNumero: 'Ya registrado' });

  const productos = await db('productos').whereIn('id', datos.items.map((i) => i.productoId)).select('id', 'activo');
  if (productos.length !== datos.items.length) throw errores.validacion({ items: 'Algún producto no existe' });

  const empresa = await db('empresa').first('tasa_igv');
  const tasaIgv = empresa?.tasa_igv ?? '18.00';
  const tipoCambio = datos.moneda === 'USD' ? datos.tipoCambio! : '1';
  const preciosIncluyenIgv = datos.tipoDocCompra === '01' ? datos.preciosIncluyenIgv : true;
  const calculo = calcularCompra(datos.items, { tipoDoc: datos.tipoDocCompra, preciosIncluyenIgv, tasaIgv, tipoCambio });

  const id = await db.transaction(async (trx) => {
    const [compraId] = await trx('compras').insert({
      proveedor_id: datos.proveedorId,
      sucursal_id: ctx.sucursalId,
      tipo_doc_compra: datos.tipoDocCompra,
      serie_numero: datos.serieNumero,
      fecha: datos.fecha,
      moneda: datos.moneda,
      tipo_cambio: tipoCambio,
      precios_incluyen_igv: preciosIncluyenIgv,
      tasa_igv: tasaIgv,
      subtotal: calculo.subtotal,
      igv: calculo.igv,
      total: calculo.total,
      nota: datos.nota ?? null,
      usuario_id: ctx.usuarioId,
      idempotency_key: ctx.idempotencyKey,
    });
    await trx('compra_items').insert(
      datos.items.map((it, i) => ({
        compra_id: compraId,
        producto_id: it.productoId,
        cantidad: aCantidad(it.cantidad),
        costo_unitario: aPrecio(it.costoUnitario),
        costo_neto_pen: calculo.lineas[i]!.costoNetoPen,
        total: calculo.lineas[i]!.total,
      })),
    );
    await mover(trx, {
      sucursalId: ctx.sucursalId,
      usuarioId: ctx.usuarioId,
      origenTipo: 'compra',
      origenId: Number(compraId),
      nota: `${datos.tipoDocCompra}-${datos.serieNumero}`,
      lineas: datos.items.map((it, i) => ({ productoId: it.productoId, cantidad: it.cantidad, tipo: 'compra', costoUnitario: calculo.lineas[i]!.costoNetoPen })),
    });
    return Number(compraId);
  }).catch(async (err) => {
    // Reintento simultáneo con la misma clave: devuelve la compra ya registrada.
    if ((err as { code?: string; sqlMessage?: string }).code === 'ER_DUP_ENTRY') {
      const otra = await db('compras').where('idempotency_key', ctx.idempotencyKey).first('id');
      if (otra) return Number(otra.id);
      throw new ErrorApp(409, 'DUPLICADO', 'Ese comprobante del proveedor ya está registrado');
    }
    throw err;
  });
  return { compra: await obtener(id), repetida: false };
}

/**
 * Anula la compra revirtiendo su entrada de stock. Falla con 409 STOCK_INSUFICIENTE si la
 * mercadería ya se vendió o trasladó. El costo promedio no se recalcula hacia atrás.
 */
export async function anular(id: number, motivo: string, ctx: { usuarioId: number }): Promise<{ antes: CompraDto; despues: CompraDto }> {
  return db.transaction(async (trx) => {
    const compra = await trx('compras').where('id', id).forUpdate().first();
    if (!compra) throw errores.noEncontrado('Compra');
    if (compra.estado === 'anulada') throw new ErrorApp(409, 'ESTADO_NO_PERMITE', 'La compra ya está anulada');
    const antes = await obtener(id, trx);

    const items = await trx('compra_items').where('compra_id', id).select('producto_id', 'cantidad');
    await mover(trx, {
      sucursalId: Number(compra.sucursal_id),
      usuarioId: ctx.usuarioId,
      origenTipo: 'compra',
      origenId: id,
      nota: `Anulación: ${motivo}`,
      lineas: items.map((i: { producto_id: number | string; cantidad: string }) => ({ productoId: Number(i.producto_id), cantidad: `-${i.cantidad}`, tipo: 'anulacion_compra' as const })),
    });
    await trx('compras').where('id', id).update({ estado: 'anulada', motivo_anulacion: motivo, anulada_por: ctx.usuarioId, anulada_en: trx.raw('CURRENT_TIMESTAMP(3)') });
    return { antes, despues: await obtener(id, trx) };
  });
}
