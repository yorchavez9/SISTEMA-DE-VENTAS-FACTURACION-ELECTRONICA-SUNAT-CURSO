import type { TipoDocCompra } from '@sv/shared';
import { aImporte, aPrecio, dec, Decimal } from '../../shared/decimal.js';

// Cálculo de una compra. Reglas del MVP (documentadas en docs/02-modelo-datos.md §5):
//  - Solo la factura (01) discrimina IGV: su costo para inventario es el valor SIN IGV (crédito fiscal).
//  - Boleta, ticket u otro: el IGV no es recuperable, el costo es el precio pagado e igv = 0.
//  - Se asume que todo lo comprado está gravado (las compras exoneradas se registran con "Otro").
//  - El costo para el kardex se expresa en soles (USD × tipo de cambio).
//  - Redondeo a 2 decimales por línea y luego se suma.

export interface LineaCompra {
  cantidad: string;
  costoUnitario: string;
}

export interface CalculoCompra {
  lineas: Array<{ costoNetoPen: string; total: string }>;
  subtotal: string;
  igv: string;
  total: string;
}

export function calcularCompra(
  lineas: LineaCompra[],
  opciones: { tipoDoc: TipoDocCompra; preciosIncluyenIgv: boolean; tasaIgv: Decimal.Value; tipoCambio: Decimal.Value },
): CalculoCompra {
  const factor = dec(1).plus(dec(opciones.tasaIgv).div(100));
  const discrimina = opciones.tipoDoc === '01';
  let subtotal = dec(0);
  let total = dec(0);

  const resultado = lineas.map((l) => {
    const bruto = dec(l.cantidad).times(l.costoUnitario);
    let baseLinea: Decimal;
    let totalLinea: Decimal;
    let costoNeto: Decimal;
    if (!discrimina) {
      totalLinea = bruto.toDecimalPlaces(2);
      baseLinea = totalLinea;
      costoNeto = dec(l.costoUnitario);
    } else if (opciones.preciosIncluyenIgv) {
      totalLinea = bruto.toDecimalPlaces(2);
      baseLinea = totalLinea.div(factor).toDecimalPlaces(2);
      costoNeto = dec(l.costoUnitario).div(factor);
    } else {
      baseLinea = bruto.toDecimalPlaces(2);
      totalLinea = baseLinea.times(factor).toDecimalPlaces(2);
      costoNeto = dec(l.costoUnitario);
    }
    subtotal = subtotal.plus(baseLinea);
    total = total.plus(totalLinea);
    return { costoNetoPen: aPrecio(costoNeto.times(opciones.tipoCambio)), total: aImporte(totalLinea) };
  });

  return { lineas: resultado, subtotal: aImporte(subtotal), igv: aImporte(total.minus(subtotal)), total: aImporte(total) };
}
