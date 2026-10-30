import { Decimal } from 'decimal.js';

// Importes de una venta. Port de ferreteria/app/Servicios/Calculo.php, que a su vez replica el
// redondeo de API-PRO (DocumentCalculationService) para que los totales cuadren al céntimo:
//   - total de línea = round(precio × cantidad, 2);
//   - gravado (10): valor unitario = round(precio / (1 + tasa), 10); base = round(valor × cantidad, 2);
//     IGV = total − base;
//   - exonerado (20) e inafecto (30): el precio ya es el valor, sin IGV;
//   - el descuento global (con IGV) se reparte entre las líneas en céntimos exactos, ajustando el
//     precio unitario (no se envía `descuentos_globales` a la API).
// El servidor es la única fuente de los importes; el navegador usa esta misma función para mostrarlos.

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type Num = Decimal.Value;

const r2 = (v: Decimal) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const r10 = (v: Decimal) => v.toDecimalPlaces(10, Decimal.ROUND_HALF_UP);

export type AfectacionVenta = '10' | '20' | '30';

export interface ItemCalculo {
  productoId: number;
  nombre: string;
  /** Con IGV si la afectación es 10; valor sin impuesto si es 20 o 30. En la moneda de la venta. */
  precioUnitario: Num;
  cantidad: Num;
  tipAfeIgv: AfectacionVenta;
}

export interface LineaCalculada {
  productoId: number;
  tipAfeIgv: AfectacionVenta;
  cantidad: string; // 3 decimales
  /** Precio que se envía a API-PRO (2 decimales, o hasta 6 si la cantidad es fraccionaria con descuento). */
  precioUnitario: string;
  /** Precio de lista antes del descuento. */
  precioLista: string;
  total: string;
  valorVenta: string;
  igv: string;
  descuento: string;
}

export interface CalculoVenta {
  lineas: LineaCalculada[];
  subtotal: string; // suma de líneas antes del descuento (con IGV)
  descuento: string;
  opGravada: string;
  opExonerada: string;
  opInafecta: string;
  igv: string;
  total: string;
}

export class ErrorCalculo extends Error {
  constructor(
    mensaje: string,
    readonly campo?: string,
  ) {
    super(mensaje);
    this.name = 'ErrorCalculo';
  }
}

const totalLinea = (precio: Num, cantidad: Num) => r2(new D(precio).times(cantidad));

/** Reparte `monto` (céntimos) en proporción a `bases` (céntimos), en enteros que suman exacto. */
export function repartir(monto: number, bases: number[]): number[] {
  const suma = bases.reduce((a, b) => a + b, 0);
  const exactos = bases.map((b) => new D(monto).times(b).div(suma));
  const partes = exactos.map((e) => e.floor().toNumber());
  let falta = monto - partes.reduce((a, b) => a + b, 0);
  // Largest remainder: los céntimos que faltan van a las líneas con mayor fracción.
  const orden = exactos.map((e, i) => ({ i, resto: e.minus(e.floor()) })).sort((a, b) => b.resto.comparedTo(a.resto) || a.i - b.i);
  for (const { i } of orden) {
    if (falta <= 0) break;
    partes[i]! += 1;
    falta -= 1;
  }
  partes.forEach((p, i) => {
    if (bases[i]! - p < 1) throw new ErrorCalculo('El descuento es demasiado grande para repartirlo entre los productos.', 'descuento');
  });
  return partes;
}

/** Precio(s) que dan exactamente `neto` céntimos para la cantidad indicada. */
function preciosConDescuento(cantidad: Decimal, netoCent: number, nombre: string): Array<{ cantidad: Decimal; precio: Decimal; totalCent: number }> {
  if (cantidad.isInteger()) {
    // Cantidad entera: dos líneas con precios de 2 decimales (base y base + 0.01).
    const q = cantidad.toNumber();
    const base = Math.floor(netoCent / q);
    const resto = netoCent - base * q;
    const out = [];
    if (q - resto > 0) out.push({ cantidad: new D(q - resto), precio: new D(base).div(100), totalCent: base * (q - resto) });
    if (resto > 0) out.push({ cantidad: new D(resto), precio: new D(base + 1).div(100), totalCent: (base + 1) * resto });
    return out;
  }
  // Cantidad fraccionaria: un precio con hasta 6 decimales, comprobado con el redondeo de la API.
  const objetivo = new D(netoCent).div(100);
  let p = objetivo.div(cantidad).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
  for (let paso = 0; paso < 200; paso++) {
    const t = totalLinea(p, cantidad);
    if (t.equals(objetivo)) return [{ cantidad, precio: p, totalCent: netoCent }];
    p = p.plus(t.lessThan(objetivo) ? '0.000001' : '-0.000001');
  }
  throw new ErrorCalculo(`No se pudo repartir el descuento en "${nombre}". Prueba con otro monto.`, 'descuento');
}

export function calcularVenta(items: ItemCalculo[], opciones: { descuento?: Num; tasaIgv: Num }): CalculoVenta {
  if (!items.length) throw new ErrorCalculo('Agrega al menos un producto', 'items');
  const factor = new D(1).plus(new D(opciones.tasaIgv).div(100));

  const brutosCent = items.map((it) => {
    const t = totalLinea(it.precioUnitario, it.cantidad);
    if (t.lessThan('0.01')) throw new ErrorCalculo(`"${it.nombre}": la cantidad es tan pequeña que el importe queda en cero.`, 'items');
    return t.times(100).toNumber();
  });
  const subtotalCent = brutosCent.reduce((a, b) => a + b, 0);
  const descuentoCent = r2(new D(opciones.descuento ?? 0)).times(100).toNumber();
  if (descuentoCent < 0 || (descuentoCent > 0 && descuentoCent >= subtotalCent)) {
    throw new ErrorCalculo(`El descuento debe ser menor que el subtotal (${new D(subtotalCent).div(100).toFixed(2)}).`, 'descuento');
  }
  const partes = descuentoCent ? repartir(descuentoCent, brutosCent) : brutosCent.map(() => 0);

  const lineas: LineaCalculada[] = [];
  let gravada = new D(0);
  let exonerada = new D(0);
  let inafecta = new D(0);
  let igv = new D(0);
  let totalCent = 0;

  items.forEach((it, i) => {
    const cantidad = new D(it.cantidad);
    const netoCent = brutosCent[i]! - partes[i]!;
    const tramos = partes[i]!
      ? preciosConDescuento(cantidad, netoCent, it.nombre)
      : [{ cantidad, precio: new D(it.precioUnitario), totalCent: netoCent }];
    tramos.forEach((t, k) => {
      const total = new D(t.totalCent).div(100);
      let valorVenta: Decimal;
      let igvLinea: Decimal;
      if (it.tipAfeIgv === '10') {
        const valorUnitario = r10(t.precio.div(factor));
        valorVenta = r2(valorUnitario.times(t.cantidad));
        igvLinea = total.minus(valorVenta);
        gravada = gravada.plus(valorVenta);
        igv = igv.plus(igvLinea);
      } else {
        valorVenta = total;
        igvLinea = new D(0);
        if (it.tipAfeIgv === '20') exonerada = exonerada.plus(total);
        else inafecta = inafecta.plus(total);
      }
      // El descuento de la línea (informativo) se anota en su primer tramo.
      const descTramo = k === 0 ? partes[i]! : 0;
      totalCent += t.totalCent;
      lineas.push({
        productoId: it.productoId,
        tipAfeIgv: it.tipAfeIgv,
        cantidad: t.cantidad.toFixed(3),
        precioUnitario: t.precio.toDecimalPlaces(6).toString(),
        precioLista: new D(it.precioUnitario).toDecimalPlaces(6).toString(),
        total: total.toFixed(2),
        valorVenta: valorVenta.toFixed(2),
        igv: igvLinea.toFixed(2),
        descuento: new D(descTramo).div(100).toFixed(2),
      });
    });
  });

  if (totalCent !== subtotalCent - descuentoCent) {
    throw new Error(`Descuadre de cálculo: ${totalCent} frente a ${subtotalCent - descuentoCent}`);
  }
  return {
    lineas,
    subtotal: new D(subtotalCent).div(100).toFixed(2),
    descuento: new D(descuentoCent).div(100).toFixed(2),
    opGravada: gravada.toFixed(2),
    opExonerada: exonerada.toFixed(2),
    opInafecta: inafecta.toFixed(2),
    igv: igv.toFixed(2),
    total: new D(totalCent).div(100).toFixed(2),
  };
}

/** Descuento en importe a partir de un porcentaje sobre el subtotal (redondeado a céntimos). */
export function descuentoPorPorcentaje(subtotal: Num, porcentaje: Num): string {
  return r2(new D(subtotal).times(porcentaje).div(100)).toFixed(2);
}

/** Precio en dólares de un producto sin precio USD propio: precio PEN / tipo de cambio venta, a 2 decimales. */
export function convertirAUsd(precioPen: Num, tipoCambioVenta: Num): string {
  return r2(new D(precioPen).div(tipoCambioVenta)).toFixed(2);
}

/** Equivalente en soles (para la regla de boletas mayores a S/ 700). */
export function aSoles(monto: Num, moneda: 'PEN' | 'USD', tipoCambioVenta: Num): Decimal {
  return moneda === 'PEN' ? new D(monto) : r2(new D(monto).times(tipoCambioVenta));
}
