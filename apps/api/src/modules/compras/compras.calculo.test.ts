import { describe, expect, it } from 'vitest';
import { calcularCompra } from './compras.calculo.js';

const IGV = '18.00';

describe('calcularCompra', () => {
  it('factura con precios que incluyen IGV: el costo de inventario es sin IGV', () => {
    const r = calcularCompra([{ cantidad: '10', costoUnitario: '11.80' }], { tipoDoc: '01', preciosIncluyenIgv: true, tasaIgv: IGV, tipoCambio: '1' });
    expect(r).toMatchObject({ subtotal: '100.00', igv: '18.00', total: '118.00' });
    expect(r.lineas[0]!.costoNetoPen).toBe('10.000000');
  });

  it('factura con valores sin IGV', () => {
    const r = calcularCompra([{ cantidad: '3', costoUnitario: '33.333333' }], { tipoDoc: '01', preciosIncluyenIgv: false, tasaIgv: IGV, tipoCambio: '1' });
    expect(r).toMatchObject({ subtotal: '100.00', igv: '18.00', total: '118.00' });
    expect(r.lineas[0]!.costoNetoPen).toBe('33.333333');
  });

  it('boleta: el IGV no es recuperable, el costo es lo pagado', () => {
    const r = calcularCompra([{ cantidad: '2', costoUnitario: '59.00' }], { tipoDoc: '03', preciosIncluyenIgv: true, tasaIgv: IGV, tipoCambio: '1' });
    expect(r).toMatchObject({ subtotal: '118.00', igv: '0.00', total: '118.00' });
    expect(r.lineas[0]!.costoNetoPen).toBe('59.000000');
  });

  it('compra en dólares: el costo del kardex se convierte a soles', () => {
    const r = calcularCompra([{ cantidad: '1', costoUnitario: '118' }], { tipoDoc: '01', preciosIncluyenIgv: true, tasaIgv: IGV, tipoCambio: '3.7520' });
    expect(r.total).toBe('118.00'); // en la moneda de la compra
    expect(r.lineas[0]!.costoNetoPen).toBe('375.200000'); // 100 × 3.752
  });

  it('redondea por línea y suma (sin arrastrar decimales binarios)', () => {
    const r = calcularCompra(
      [{ cantidad: '0.333', costoUnitario: '3' }, { cantidad: '0.333', costoUnitario: '3' }, { cantidad: '0.334', costoUnitario: '3' }],
      { tipoDoc: '03', preciosIncluyenIgv: true, tasaIgv: IGV, tipoCambio: '1' },
    );
    expect(r.total).toBe('3.00');
  });
});
