import { calcularVenta, convertirAUsd, descuentoPorPorcentaje, repartir, type ItemCalculo } from '@sv/shared';
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

// Casos portados de ferreteria/tests/calculo_test.php, más pruebas contra la regla de API-PRO.

const item = (precio: string, cantidad: string, tipAfeIgv: '10' | '20' | '30' = '10', id = 1): ItemCalculo => ({
  productoId: id,
  nombre: `P${id}`,
  precioUnitario: precio,
  cantidad,
  tipAfeIgv,
});

/**
 * Lo que calcularía API-PRO con las líneas que se le envían (DocumentCalculationService):
 * total = round(precio × cantidad, 2); valor = round(precio / 1.18, 10); base = round(valor × cantidad, 2).
 */
function segunApi(lineas: Array<{ precioUnitario: string; cantidad: string; tipAfeIgv: string }>, tasa = 18) {
  let total = new Decimal(0);
  let gravada = new Decimal(0);
  let igv = new Decimal(0);
  for (const l of lineas) {
    const t = new Decimal(l.precioUnitario).times(l.cantidad).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    total = total.plus(t);
    if (l.tipAfeIgv === '10') {
      const valor = new Decimal(l.precioUnitario).div(1 + tasa / 100).toDecimalPlaces(10, Decimal.ROUND_HALF_UP);
      const base = valor.times(l.cantidad).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      gravada = gravada.plus(base);
      igv = igv.plus(t.minus(base));
    }
  }
  return { total: total.toFixed(2), gravada: gravada.toFixed(2), igv: igv.toFixed(2) };
}

const decimales = (precio: string) => (precio.split('.')[1] ?? '').length;

describe('calcularVenta (casos de ferretería)', () => {
  it('sin descuento: 2 × 29.90 + 10.5 m × 2.50 = 86.05', () => {
    const r = calcularVenta([item('29.90', '2'), item('2.50', '10.5', '10', 2)], { tasaIgv: 18 });
    expect(r.total).toBe('86.05');
    expect(new Decimal(r.opGravada).plus(r.igv).toFixed(2)).toBe(r.total);
    expect(Math.abs(Number(r.igv) - (86.05 - 86.05 / 1.18))).toBeLessThanOrEqual(0.01);
  });

  it('con descuento de S/ 10: total exacto y la API suma lo mismo', () => {
    const r = calcularVenta([item('29.90', '3'), item('2.50', '10.5', '10', 2)], { tasaIgv: 18, descuento: '10' });
    expect(r.total).toBe('105.95');
    expect(segunApi(r.lineas)).toEqual({ total: r.total, gravada: r.opGravada, igv: r.igv });
    // Solo la línea en metros puede tener más de 2 decimales.
    expect(r.lineas.filter((l) => decimales(l.precioUnitario) > 2).length).toBeLessThanOrEqual(1);
  });

  it('descuento que no divide exacto: 7 × 0.35 − 0.03 = 2.42 en dos líneas de 2 decimales', () => {
    const r = calcularVenta([item('0.35', '7')], { tasaIgv: 18, descuento: '0.03' });
    expect(r.total).toBe('2.42');
    expect(r.lineas).toHaveLength(2);
    expect(r.lineas.every((l) => decimales(l.precioUnitario) <= 2)).toBe(true);
    expect(segunApi(r.lineas).total).toBe('2.42');
  });

  it('exonerado: sin IGV', () => {
    const r = calcularVenta([item('12.00', '1', '20')], { tasaIgv: 18 });
    expect(r).toMatchObject({ igv: '0.00', opGravada: '0.00', opExonerada: '12.00', total: '12.00' });
  });

  it.each([['0.01', '1'], ['4.99', '1'], ['1.37', '3'], ['7.77', '9']])('descuento %s con cantidades mixtas cuadra con la API', (desc, q) => {
    const r = calcularVenta([item('3.33', '1.234'), item('1.11', q, '10', 2)], { tasaIgv: 18, descuento: desc });
    expect(segunApi(r.lineas)).toEqual({ total: r.total, gravada: r.opGravada, igv: r.igv });
  });

  it('rechaza un descuento igual o mayor al subtotal', () => {
    expect(() => calcularVenta([item('10.00', '1')], { tasaIgv: 18, descuento: '10' })).toThrow(/menor que el subtotal/);
  });
});

describe('calcularVenta (reglas adicionales)', () => {
  it('mezcla gravado, exonerado e inafecto', () => {
    const r = calcularVenta([item('118', '1'), item('50', '2', '20', 2), item('10', '3', '30', 3)], { tasaIgv: 18 });
    expect(r).toMatchObject({ opGravada: '100.00', igv: '18.00', opExonerada: '100.00', opInafecta: '30.00', total: '248.00' });
  });

  it('cantidades fraccionarias muy pequeñas que dan importe cero se rechazan', () => {
    expect(() => calcularVenta([item('0.01', '0.1')], { tasaIgv: 18 })).toThrow(/importe queda en cero/);
  });

  it('respeta otra tasa de IGV (la informa API-PRO)', () => {
    const r = calcularVenta([item('110', '1')], { tasaIgv: 10 });
    expect(r).toMatchObject({ opGravada: '100.00', igv: '10.00' });
  });

  it('500 ventas aleatorias: siempre cuadra al céntimo con la regla de API-PRO', () => {
    let semilla = 12345;
    const azar = () => ((semilla = (semilla * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 500; n++) {
      const items: ItemCalculo[] = Array.from({ length: 1 + Math.floor(azar() * 5) }, (_, i) => {
        const fraccion = azar() < 0.3;
        return item(
          (0.5 + azar() * 300).toFixed(2),
          fraccion ? (0.1 + azar() * 20).toFixed(3) : String(1 + Math.floor(azar() * 12)),
          (['10', '10', '10', '20', '30'] as const)[Math.floor(azar() * 5)],
          i + 1,
        );
      });
      const sinDesc = calcularVenta(items, { tasaIgv: 18 });
      const desc = azar() < 0.5 ? '0' : new Decimal(sinDesc.subtotal).times(azar() * 0.3).toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed(2);
      const r = calcularVenta(items, { tasaIgv: 18, descuento: desc });
      expect(new Decimal(r.total).toFixed(2)).toBe(new Decimal(r.subtotal).minus(r.descuento).toFixed(2));
      expect(segunApi(r.lineas)).toEqual({ total: r.total, gravada: r.opGravada, igv: r.igv });
      expect(new Decimal(r.opGravada).plus(r.igv).plus(r.opExonerada).plus(r.opInafecta).toFixed(2)).toBe(r.total);
    }
  });
});

describe('utilidades', () => {
  it('repartir suma exacto y no deja líneas en cero', () => {
    expect(repartir(100, [300, 300, 400])).toEqual([30, 30, 40]);
    expect(repartir(1, [2, 2, 2]).reduce((a, b) => a + b, 0)).toBe(1);
    expect(() => repartir(3, [1, 1, 1])).toThrow(/demasiado grande/);
  });

  it('descuento por porcentaje y conversión a dólares', () => {
    expect(descuentoPorPorcentaje('86.05', '10')).toBe('8.61');
    expect(convertirAUsd('29.90', '3.7520')).toBe('7.97');
  });
});
