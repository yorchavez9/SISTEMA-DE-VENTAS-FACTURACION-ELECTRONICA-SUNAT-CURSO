import { describe, expect, it } from 'vitest';
import { LlamadaProhibida, puedeEnviar, validarPayloadEmision, validarRuta } from './guardas.js';

describe('validarRuta', () => {
  it.each([
    ['GET', '/empresa'],
    ['GET', '/series'],
    ['POST', '/boletas'],
    ['GET', '/anulaciones/15'],
    ['GET', '/guias-remision/7'],
    ['GET', '/boletas/3/pdf?format=ticket-80'],
    ['GET', '/resumenes/4/estado'],
    ['GET', '/consultar-cpe?tipo_doc=03'],
  ])('permite %s %s', (metodo, ruta) => {
    expect(() => validarRuta(metodo, ruta)).not.toThrow();
  });

  it.each([
    ['DELETE', '/empresa'],
    ['GET', '/anulaciones/15/estado'],
    ['GET', '/guias-remision/7/estado'],
    ['POST', '/consultar-cdr'],
    ['POST', '/empresa/credenciales/regenerar'],
    ['GET', '/boletas/3/pdf?formato=ticket-80'],
    ['GET', '/api/sunat/facturas'],
    ['GET', 'empresa'],
  ])('prohíbe %s %s', (metodo, ruta) => {
    expect(() => validarRuta(metodo, ruta)).toThrow(LlamadaProhibida);
  });
});

describe('validarPayloadEmision (B7)', () => {
  const base = {
    serie: 'B101',
    fecha_emision: '2026-10-28',
    cliente: { tipo_doc: '1', num_doc: '12345678', razon_social: 'JUAN' },
    items: [{ descripcion: 'X', unidad: 'NIU', cantidad: 1, precio_unitario: 118, tip_afe_igv: '10' }],
  };

  it('acepta un payload sin totales', () => {
    expect(() => validarPayloadEmision(base)).not.toThrow();
  });

  it('rechaza totales en la raíz', () => {
    expect(() => validarPayloadEmision({ ...base, mto_igv: 18 })).toThrow(/mto_igv/);
  });

  it('rechaza montos calculados en los ítems', () => {
    expect(() => validarPayloadEmision({ ...base, items: [{ ...base.items[0], igv: 18 }] })).toThrow(/igv/);
  });
});

describe('puedeEnviar (B2)', () => {
  it('solo pendiente o rechazado', () => {
    expect(puedeEnviar('pendiente')).toBe(true);
    expect(puedeEnviar('rechazado')).toBe(true);
    for (const e of ['enviado', 'aceptado', 'anulado', 'anulacion_en_proceso']) expect(puedeEnviar(e)).toBe(false);
  });
});
