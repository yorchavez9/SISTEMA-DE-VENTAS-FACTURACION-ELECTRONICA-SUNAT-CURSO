import { describe, expect, it } from 'vitest';
import { validarPayloadEmision } from '../../integrations/apiPro/guardas.js';
import { construirPayload, estadoLocal, mensajeValidacion, type ComprobanteParaEnvio } from './contrato.js';

const base: ComprobanteParaEnvio = {
  tipo_doc: '03',
  serie: 'B101',
  fecha_emision: '2026-10-29',
  moneda: 'PEN',
  forma_pago: 'contado',
  modo_envio: 'individual',
  cliente_tipo_doc: '0',
  cliente_num_doc: '-',
  cliente_razon_social: 'CLIENTES VARIOS',
  cliente_direccion: null,
  cliente_email: null,
};
const items = [{ codigo: 'MART', descripcion: 'Martillo', unidad: 'NIU', tip_afe_igv: '10', cantidad: '2.000', precio_unitario: '29.900000' }];

describe('construirPayload', () => {
  it('boleta individual: campos mínimos del contrato, sin totales', () => {
    const p = construirPayload(base, items, [], '0002');
    expect(p).toEqual({
      serie: 'B101',
      fecha_emision: '2026-10-29',
      tipo_moneda: 'PEN',
      forma_pago: 'Contado',
      cliente: { tipo_doc: '0', num_doc: '-', razon_social: 'CLIENTES VARIOS' },
      items: [{ codigo: 'MART', descripcion: 'Martillo', unidad: 'NIU', cantidad: 2, precio_unitario: 29.9, tip_afe_igv: '10' }],
      enviar_automatico: true,
      cod_local: '0002',
    });
    expect(() => validarPayloadEmision(p)).not.toThrow(); // guarda B7
  });

  it('boleta por resumen: solo_registro', () => {
    expect(construirPayload({ ...base, modo_envio: 'resumen' }, items, [], null)).toMatchObject({ solo_registro: true });
  });

  it('factura al crédito: tipo_operacion, forma de pago y cuotas', () => {
    const p = construirPayload(
      { ...base, tipo_doc: '01', serie: 'F101', forma_pago: 'credito', cliente_tipo_doc: '6', cliente_num_doc: '20100070970', cliente_razon_social: 'ACME', cliente_direccion: 'AV X' },
      items,
      [{ monto: '59.80', fecha_pago: '2026-11-28' }],
      null,
    );
    expect(p).toMatchObject({ tipo_operacion: '0101', forma_pago: 'Credito', cuotas: [{ monto: 59.8, fecha_pago: '2026-11-28' }], cliente: { direccion: 'AV X' } });
    expect(p).not.toHaveProperty('solo_registro');
  });

  it('precios con 6 decimales y cantidades fraccionarias se envían exactos', () => {
    const p = construirPayload(base, [{ ...items[0]!, cantidad: '1.234', precio_unitario: '3.326580' }], [], null);
    expect((p.items as Array<{ cantidad: number; precio_unitario: number }>)[0]).toMatchObject({ cantidad: 1.234, precio_unitario: 3.32658 });
  });
});

describe('estadoLocal', () => {
  it.each([
    [{ estado: 'aceptado', codigo: 0, notas: [] }, 'individual', 'aceptado'],
    [{ estado: 'aceptado', codigo: 4252, notas: [] }, 'individual', 'observado'],
    [{ estado: 'aceptado', codigo: 0, notas: ['4287: obs'] }, 'individual', 'observado'],
    [{ estado: 'rechazado', codigo: 2017, notas: null }, 'individual', 'rechazado'],
    [{ estado: 'enviado', codigo: null, notas: null }, 'individual', 'en_proceso'],
    [{ estado: 'pendiente', codigo: 'SUNAT_TIMEOUT', notas: null }, 'individual', 'sin_respuesta_sunat'],
    [{ estado: 'pendiente', codigo: null, notas: null }, 'resumen', 'pendiente_resumen'],
    [{ estado: 'anulado', codigo: null, notas: null }, 'individual', 'anulado'],
  ] as const)('%o (%s) → %s', (sunat, modo, esperado) => {
    expect(estadoLocal({ descripcion: null, ...sunat, notas: sunat.notas as unknown }, modo)).toBe(esperado);
  });
});

it('mensajeValidacion une el mensaje y los errores por campo', () => {
  expect(mensajeValidacion({ mensaje: 'Error de validación', errores: { 'cliente.num_doc': ['RUC inválido'] } })).toBe('Error de validación · cliente.num_doc: RUC inválido');
});
