import type { FaltanteStock } from '@sv/shared';
import type { Trx } from '../../database/db.js';
import { aCantidad, aPrecio, dec, Decimal } from '../../shared/decimal.js';
import { ErrorApp } from '../../shared/errors.js';

export type TipoMovimiento =
  | 'stock_inicial' | 'compra' | 'venta' | 'devolucion_nc' | 'anulacion' | 'ajuste_entrada' | 'ajuste_salida'
  | 'traslado_salida' | 'traslado_entrada' | 'anulacion_compra' | 'anulacion_traslado';

export interface LineaMovimiento {
  productoId: number;
  /** Con signo: positiva entra, negativa sale. */
  cantidad: Decimal.Value;
  tipo: TipoMovimiento;
  /** Costo de una entrada por compra: recalcula el costo promedio ponderado del producto. */
  costoUnitario?: Decimal.Value;
}

export interface Movimiento {
  sucursalId: number;
  usuarioId: number | null;
  origenTipo: string;
  origenId: number;
  nota?: string;
  lineas: LineaMovimiento[];
}

export interface ResultadoLinea {
  productoId: number;
  stockAnterior: string;
  stockResultante: string;
  aplicado: boolean; // false si el producto no es inventariable
}

/**
 * Único punto que modifica el stock (docs/02-modelo-datos.md §11). Debe llamarse dentro de la
 * transacción del documento de origen:
 *  - bloquea las filas de stock en orden de producto (evita deadlocks entre ventas simultáneas);
 *  - rechaza cualquier línea que deje el stock negativo (409 STOCK_INSUFICIENTE con el detalle);
 *  - registra el kardex con un índice único por origen: el mismo documento no mueve dos veces.
 * Los productos no inventariables (servicios) se ignoran.
 */
export async function mover(trx: Trx, mov: Movimiento): Promise<ResultadoLinea[]> {
  if (!mov.lineas.length) return [];

  // Agrupa por (producto, tipo) para que un mismo producto repetido se valide sumado.
  const agrupadas = new Map<string, LineaMovimiento & { cantidad: Decimal }>();
  for (const l of mov.lineas) {
    const clave = `${l.productoId}:${l.tipo}`;
    const previa = agrupadas.get(clave);
    if (previa && l.costoUnitario !== undefined) {
      throw new ErrorApp(422, 'VALIDACION', 'Un producto con costo aparece dos veces en el mismo documento');
    }
    agrupadas.set(clave, { ...l, cantidad: dec(l.cantidad).plus(previa?.cantidad ?? 0) });
  }
  const lineas = [...agrupadas.values()].sort((a, b) => a.productoId - b.productoId);
  const ids = [...new Set(lineas.map((l) => l.productoId))];

  interface FilaProducto {
    id: number | string;
    nombre: string;
    inventariable: number | boolean;
    costo_promedio: string;
  }
  const productos = (await trx('productos').whereIn('id', ids).forUpdate().select('id', 'nombre', 'inventariable', 'costo_promedio')) as FilaProducto[];
  const mapa = new Map(productos.map((p) => [Number(p.id), p]));
  for (const id of ids) if (!mapa.has(id)) throw new ErrorApp(422, 'VALIDACION', `El producto ${id} no existe`);
  const porId = { get: (id: number) => mapa.get(id)! };

  const inventariables = ids.filter((id) => Boolean(porId.get(id).inventariable));
  if (inventariables.length) {
    await trx.raw(
      `INSERT IGNORE INTO stock (producto_id, sucursal_id, cantidad) VALUES ${inventariables.map(() => '(?, ?, 0)').join(', ')}`,
      inventariables.flatMap((id) => [id, mov.sucursalId]),
    );
  }
  const filasStock = inventariables.length
    ? await trx('stock').where('sucursal_id', mov.sucursalId).whereIn('producto_id', inventariables).orderBy('producto_id').forUpdate().select('producto_id', 'cantidad')
    : [];
  const actual = new Map<number, Decimal>(filasStock.map((s: { producto_id: number | string; cantidad: string }) => [Number(s.producto_id), dec(s.cantidad)]));

  // Validación completa antes de escribir: se informan todos los faltantes a la vez.
  const saldo = new Map(actual);
  const faltantes: FaltanteStock[] = [];
  for (const l of lineas) {
    if (!porId.get(l.productoId).inventariable) continue;
    const nuevo = (saldo.get(l.productoId) ?? dec(0)).plus(l.cantidad);
    if (nuevo.isNegative()) {
      faltantes.push({
        productoId: l.productoId,
        nombre: porId.get(l.productoId).nombre,
        disponible: aCantidad(saldo.get(l.productoId) ?? 0),
        solicitado: aCantidad(dec(l.cantidad).abs()),
      });
    }
    saldo.set(l.productoId, nuevo);
  }
  if (faltantes.length) {
    const primero = faltantes[0]!;
    throw new ErrorApp(
      409,
      'STOCK_INSUFICIENTE',
      faltantes.length === 1 ? `Stock insuficiente de ${primero.nombre}: hay ${dec(primero.disponible)}` : `Stock insuficiente en ${faltantes.length} productos`,
      undefined,
      { faltantes },
    );
  }

  const resultados: ResultadoLinea[] = [];
  const corriente = new Map(actual);
  for (const l of lineas) {
    const p = porId.get(l.productoId);
    if (!p.inventariable) {
      resultados.push({ productoId: l.productoId, stockAnterior: '0.000', stockResultante: '0.000', aplicado: false });
      continue;
    }
    const anterior = corriente.get(l.productoId) ?? dec(0);
    const resultante = anterior.plus(l.cantidad);
    corriente.set(l.productoId, resultante);

    if (l.costoUnitario !== undefined && dec(l.cantidad).gt(0)) {
      // Promedio ponderado sobre el stock total de todas las sucursales.
      const [{ total }] = (await trx('stock').where('producto_id', l.productoId).sum({ total: 'cantidad' })) as [{ total: string | null }];
      const stockTotal = dec(total);
      const nuevoPromedio = stockTotal.isZero() || stockTotal.isNegative()
        ? dec(l.costoUnitario)
        : stockTotal.times(p.costo_promedio).plus(dec(l.cantidad).times(l.costoUnitario)).div(stockTotal.plus(l.cantidad));
      await trx('productos').where('id', l.productoId).update({ costo_promedio: aPrecio(nuevoPromedio) });
    }

    await trx('stock').where({ producto_id: l.productoId, sucursal_id: mov.sucursalId }).update({ cantidad: aCantidad(resultante) });
    try {
      await trx('movimientos_stock').insert({
        producto_id: l.productoId,
        sucursal_id: mov.sucursalId,
        tipo: l.tipo,
        cantidad: aCantidad(l.cantidad),
        costo_unitario: l.costoUnitario === undefined ? null : aPrecio(l.costoUnitario),
        stock_resultante: aCantidad(resultante),
        origen_tipo: mov.origenTipo,
        origen_id: mov.origenId,
        usuario_id: mov.usuarioId,
        nota: mov.nota?.slice(0, 255) ?? null,
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
        throw new ErrorApp(409, 'MOVIMIENTO_DUPLICADO', `El documento ${mov.origenTipo} ${mov.origenId} ya movió el stock de este producto`);
      }
      throw err;
    }
    resultados.push({ productoId: l.productoId, stockAnterior: aCantidad(anterior), stockResultante: aCantidad(resultante), aplicado: true });
  }
  return resultados;
}
