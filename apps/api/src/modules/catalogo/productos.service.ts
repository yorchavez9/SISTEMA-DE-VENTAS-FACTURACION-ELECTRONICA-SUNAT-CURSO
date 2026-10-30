import type { Pagina, ProductoDto, ProductoInput } from '@sv/shared';
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { db, type Trx } from '../../database/db.js';
import { aCantidad, aPrecio, dec } from '../../shared/decimal.js';
import { ErrorApp, errores } from '../../shared/errors.js';
import { mover } from '../inventario/inventario.service.js';
import { urlImagen } from './imagenes.js';

interface Fila {
  id: number | string;
  codigo: string;
  codigo_barras: string | null;
  nombre: string;
  descripcion: string | null;
  categoria_id: number | string | null;
  categoria_nombre: string | null;
  unidad_id: number | string;
  unidad_codigo: string;
  unidad_nombre: string;
  unidad_fraccionable: number | boolean;
  tipo: 'bien' | 'servicio';
  inventariable: number | boolean;
  tip_afe_igv: '10' | '20' | '30';
  cod_producto_sunat: string | null;
  precio_venta: string;
  precio_venta_usd: string | null;
  costo_promedio: string;
  stock_minimo: string;
  peso_kg: string | null;
  imagen: string | null;
  activo: number | boolean;
  stock: string | null;
}

function aDto(f: Fila): ProductoDto {
  const inventariable = Boolean(f.inventariable);
  const stock = inventariable ? aCantidad(f.stock ?? 0) : null;
  return {
    id: Number(f.id),
    codigo: f.codigo,
    codigoBarras: f.codigo_barras,
    nombre: f.nombre,
    descripcion: f.descripcion,
    categoria: f.categoria_id == null ? null : { id: Number(f.categoria_id), nombre: f.categoria_nombre ?? '' },
    unidad: { id: Number(f.unidad_id), codigoSunat: f.unidad_codigo, nombre: f.unidad_nombre, fraccionable: Boolean(f.unidad_fraccionable) },
    tipo: f.tipo,
    inventariable,
    tipAfeIgv: f.tip_afe_igv,
    codProductoSunat: f.cod_producto_sunat,
    precioVenta: f.precio_venta,
    precioVentaUsd: f.precio_venta_usd,
    costoPromedio: f.costo_promedio,
    stockMinimo: f.stock_minimo,
    pesoKg: f.peso_kg,
    imagenUrl: urlImagen(Number(f.id), f.imagen),
    activo: Boolean(f.activo),
    stock,
    stockBajo: inventariable && dec(f.stock_minimo).gt(0) && dec(stock).lte(f.stock_minimo),
  };
}

function consulta(sucursalId: number | null, conn: Knex = db) {
  return conn('productos as p')
    .join('unidades as u', 'u.id', 'p.unidad_id')
    .leftJoin('categorias as c', 'c.id', 'p.categoria_id')
    .leftJoin('stock as s', function () {
      this.on('s.producto_id', 'p.id').andOnVal('s.sucursal_id', sucursalId ?? 0);
    })
    .select(
      'p.*', 'c.nombre as categoria_nombre', 'u.codigo_sunat as unidad_codigo', 'u.nombre as unidad_nombre',
      'u.fraccionable as unidad_fraccionable', 's.cantidad as stock',
    );
}

/** Escapa los comodines de LIKE en el texto de búsqueda. */
const like = (t: string) => `%${t.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

export async function listar(
  sucursalId: number | null,
  f: { page: number; pageSize: number; q?: string; categoriaId?: number; activo: 'true' | 'false' | 'todos'; stockBajo?: boolean; soloInventariables?: boolean },
): Promise<Pagina<ProductoDto>> {
  const filtrar = (q: Knex.QueryBuilder) => {
    if (f.activo !== 'todos') q.where('p.activo', f.activo === 'true');
    if (f.categoriaId) q.where('p.categoria_id', f.categoriaId);
    if (f.soloInventariables) q.where('p.inventariable', true);
    if (f.q) q.where((w) => w.whereILike('p.nombre', like(f.q!)).orWhere('p.codigo', f.q!.toUpperCase()).orWhere('p.codigo_barras', f.q!).orWhereILike('p.codigo', like(f.q!)));
    if (f.stockBajo) q.where('p.inventariable', true).andWhere('p.stock_minimo', '>', 0).andWhereRaw('COALESCE(s.cantidad, 0) <= p.stock_minimo');
  };
  const base = consulta(sucursalId).modify(filtrar);
  const [{ total }] = (await db.from(base.clone().clearSelect().select('p.id').as('t')).count({ total: '*' })) as [{ total: number }];
  const filas = (await base.orderBy('p.nombre').limit(f.pageSize).offset((f.page - 1) * f.pageSize)) as Fila[];
  return { data: filas.map(aDto), page: f.page, pageSize: f.pageSize, total: Number(total) };
}

/** Búsqueda ligera para el POS: coincidencia exacta de código o barras primero, luego por nombre. */
export async function buscarPos(sucursalId: number, q: string): Promise<ProductoDto[]> {
  const texto = q.trim();
  if (!texto) return [];
  const filas = (await consulta(sucursalId)
    .where('p.activo', true)
    .andWhere((w) => w.where('p.codigo', texto.toUpperCase()).orWhere('p.codigo_barras', texto).orWhereILike('p.nombre', like(texto)).orWhereILike('p.codigo', like(texto)))
    .orderByRaw('(p.codigo = ? OR p.codigo_barras = ?) DESC, p.nombre', [texto.toUpperCase(), texto])
    .limit(30)) as Fila[];
  return filas.map(aDto);
}

export async function obtener(id: number, sucursalId: number | null, conn: Knex = db): Promise<ProductoDto> {
  const f = (await consulta(sucursalId, conn).where('p.id', id).first()) as Fila | undefined;
  if (!f) throw errores.noEncontrado('Producto');
  return aDto(f);
}

async function validarReferencias(trx: Trx, datos: ProductoInput, id?: number): Promise<void> {
  const unidad = await trx('unidades').where({ id: datos.unidadId, activo: true }).first('id');
  if (!unidad) throw errores.validacion({ unidadId: 'Unidad inválida' });
  if (datos.categoriaId) {
    const c = await trx('categorias').where({ id: datos.categoriaId }).first('id');
    if (!c) throw errores.validacion({ categoriaId: 'Categoría inválida' });
  }
  const dupCodigo = await trx('productos').where('codigo', datos.codigo).modify((q) => id && q.whereNot('id', id)).first('id');
  if (dupCodigo) throw errores.validacion({ codigo: 'Ya existe un producto con ese código' });
  if (datos.codigoBarras) {
    const dup = await trx('productos').where('codigo_barras', datos.codigoBarras).modify((q) => id && q.whereNot('id', id)).first('id');
    if (dup) throw errores.validacion({ codigoBarras: 'Ese código de barras ya está asignado' });
  }
}

function columnas(d: ProductoInput) {
  return {
    codigo: d.codigo,
    codigo_barras: d.codigoBarras ?? null,
    nombre: d.nombre,
    descripcion: d.descripcion || null,
    categoria_id: d.categoriaId ?? null,
    unidad_id: d.unidadId,
    tipo: d.tipo,
    inventariable: d.inventariable,
    tip_afe_igv: d.tipAfeIgv,
    cod_producto_sunat: d.codProductoSunat ?? null,
    precio_venta: aPrecio(d.precioVenta),
    precio_venta_usd: d.precioVentaUsd ? aPrecio(d.precioVentaUsd) : null,
    stock_minimo: aCantidad(d.stockMinimo),
    peso_kg: d.pesoKg ?? null,
    activo: d.activo,
  };
}

export async function crear(datos: ProductoInput, ctx: { sucursalId: number | null; usuarioId: number }): Promise<ProductoDto> {
  return db.transaction(async (trx) => {
    await validarReferencias(trx, datos);
    const [id] = await trx('productos').insert(columnas(datos));
    const productoId = Number(id);

    if (datos.inventariable && datos.stockInicial && dec(datos.stockInicial).gt(0)) {
      if (!ctx.sucursalId) throw new ErrorApp(409, 'SIN_SUCURSAL', 'Elige una sucursal para registrar el stock inicial');
      const [ajusteId] = await trx('ajustes_inventario').insert({
        sucursal_id: ctx.sucursalId,
        usuario_id: ctx.usuarioId,
        tipo: 'stock_inicial',
        motivo: 'Stock inicial al crear el producto',
        idempotency_key: randomUUID(),
      });
      await trx('ajuste_items').insert({ ajuste_id: ajusteId, producto_id: productoId, cantidad: aCantidad(datos.stockInicial) });
      await mover(trx, {
        sucursalId: ctx.sucursalId,
        usuarioId: ctx.usuarioId,
        origenTipo: 'ajuste',
        origenId: Number(ajusteId),
        nota: 'Stock inicial',
        lineas: [{ productoId, cantidad: datos.stockInicial, tipo: 'stock_inicial' }],
      });
    }
    return obtener(productoId, ctx.sucursalId, trx);
  });
}

export async function editar(id: number, datos: ProductoInput, sucursalId: number | null): Promise<{ antes: ProductoDto; despues: ProductoDto }> {
  return db.transaction(async (trx) => {
    const antes = await obtener(id, sucursalId, trx);
    await validarReferencias(trx, datos, id);
    if (antes.inventariable && !datos.inventariable) {
      const [{ total }] = (await trx('stock').where('producto_id', id).sum({ total: 'cantidad' })) as [{ total: string | null }];
      if (dec(total).gt(0)) {
        throw new ErrorApp(409, 'ESTADO_NO_PERMITE', 'El producto tiene stock: ajústalo a cero antes de quitarle el control de inventario');
      }
    }
    // El stock inicial solo se admite al crear.
    await trx('productos').where('id', id).update(columnas(datos));
    return { antes, despues: await obtener(id, sucursalId, trx) };
  });
}
