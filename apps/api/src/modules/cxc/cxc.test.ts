import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../../app.js';
import { db } from '../../database/db.js';
import { hashClave } from '../../shared/claves.js';
import { fechaLima } from '../../shared/fechas.js';
import { hayBaseDatos, prepararBdPrueba } from '../../test/bd.js';

const conBd = await hayBaseDatos();
const app = crearApp();
const CLAVE = 'Clave1234';
const dentroDe = (dias: number) => {
  const d = new Date(`${fechaLima()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

describe.skipIf(!conBd)('cuentas por cobrar (integración)', () => {
  const ids: Record<string, number> = {};
  const s: Record<string, { agente: ReturnType<typeof request.agent>; csrf: string }> = {};
  const post = (u: string, ruta: string, cuerpo: object, clave: string | null = randomUUID()) => {
    const r = s[u]!.agente.post(ruta).set('X-CSRF-Token', s[u]!.csrf);
    if (clave) r.set('Idempotency-Key', clave);
    return r.send(cuerpo);
  };
  const cuotas = async (ventaId: number) =>
    db('cuotas as q').join('cuentas_por_cobrar as x', 'x.id', 'q.cxc_id').where('x.venta_id', ventaId).orderBy('q.numero').select('q.id', 'q.saldo', 'q.estado');

  /** Venta al crédito sin inicial con las cuotas indicadas (montos que suman el total). */
  async function ventaCredito(moneda: 'PEN' | 'USD', cantidad: string, cuotasVenta: Array<[string, number]>) {
    const r = await post('super', '/api/ventas', {
      cajaId: ids.caja,
      tipoComprobante: '03',
      serieId: ids.serie,
      moneda,
      cliente: { id: ids.cliente },
      items: [{ productoId: ids.producto, cantidad }],
      formaPago: 'credito',
      pagos: [],
      cuotas: cuotasVenta.map(([monto, dias]) => ({ monto, fechaVencimiento: dentroDe(dias) })),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.venta.id as number;
  }

  beforeAll(async () => {
    await prepararBdPrueba();
    ids.sucursal = Number((await db('sucursales').insert({ nombre: 'Centro', cod_local: '0101' }))[0]);
    await db('empresa').insert({ ruc: '20161515648', razon_social: 'EMPRESA', tasa_igv: '18.00' });
    ids.serie = Number((await db('series').insert({ api_serie_id: 1, tipo_doc: '03', serie: 'B101', propia: true, sucursal_id: ids.sucursal }))[0]);
    const unidad = (await db('unidades').where('codigo_sunat', 'NIU').first('id')).id;
    ids.producto = Number((await db('productos').insert({ codigo: 'P', nombre: 'Producto', unidad_id: unidad, precio_venta: '10.00', precio_venta_usd: '5.00' }))[0]);
    await db('stock').insert({ producto_id: ids.producto, sucursal_id: ids.sucursal, cantidad: '1000' });
    ids.cliente = Number((await db('clientes').insert({ tipo_doc: '1', num_doc: '12345678', razon_social: 'Juan Pérez' }))[0]);
    ids.efectivo = Number((await db('metodos_pago').where('codigo', 'EFECTIVO').first('id')).id);
    ids.yape = Number((await db('metodos_pago').where('codigo', 'YAPE').first('id')).id);
    for (const [usuario, rol] of [['cajero', 'cajero'], ['super', 'supervisor']] as const) {
      const r = (await db('roles').where('codigo', rol).first('id')).id;
      const [id] = await db('usuarios').insert({ usuario, nombre: usuario, password_hash: await hashClave(CLAVE), rol_id: r, debe_cambiar_password: false });
      await db('usuario_sucursales').insert({ usuario_id: id, sucursal_id: ids.sucursal });
      const agente = request.agent(app);
      const login = await agente.post('/api/auth/login').send({ usuario, password: CLAVE });
      s[usuario] = { agente, csrf: login.body.csrfToken };
    }
    ids.caja = Number((await db('cajas').insert({ sucursal_id: ids.sucursal, nombre: 'Caja 1' }))[0]);
    await post('cajero', '/api/turnos/abrir', { cajaId: ids.caja, saldosIniciales: [{ moneda: 'PEN', monto: '100' }] });
    await db('tipos_cambio').insert({ fecha: fechaLima(), compra: '3.7400', venta: '3.7500' });

    ids.ventaA = await ventaCredito('PEN', '10', [['50.00', 30], ['50.00', 60]]); // S/ 100
    ids.ventaB = await ventaCredito('PEN', '3', [['30.00', 15]]); // S/ 30, vence antes
    ids.ventaUsd = await ventaCredito('USD', '4', [['20.00', 45]]); // US$ 20
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
  });

  it('sin indicar cuotas, el cobro paga primero la que vence antes', async () => {
    const r = await post('cajero', '/api/cobros', { clienteId: ids.cliente, cajaId: ids.caja, metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '45.00' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // B (30, vence a 15 días) queda pagada; A cuota 1 recibe 15.
    expect(r.body.aplicaciones).toEqual([
      expect.objectContaining({ ventaId: ids.ventaB, numero: 1, monto: '30.00' }),
      expect.objectContaining({ ventaId: ids.ventaA, numero: 1, monto: '15.00' }),
    ]);
    expect((await cuotas(ids.ventaB))[0]).toMatchObject({ saldo: '0.00', estado: 'pagada' });
    expect((await cuotas(ids.ventaA))[0]).toMatchObject({ saldo: '35.00', estado: 'parcial' });
    expect(await db('cuentas_por_cobrar').where('venta_id', ids.ventaB).first()).toMatchObject({ saldo: '0.00', estado: 'pagada' });
    expect(await db('cuentas_por_cobrar').where('venta_id', ids.ventaA).first()).toMatchObject({ saldo: '85.00', estado: 'parcial' });
    expect(await db('movimientos_caja').where({ origen_tipo: 'cobro', origen_id: r.body.id }).first()).toMatchObject({ tipo: 'cobro', monto: '45.00' });
  });

  it('no admite pagar más de lo adeudado ni Yape sin número de operación', async () => {
    const exceso = await post('cajero', '/api/cobros', { clienteId: ids.cliente, cajaId: ids.caja, metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '500.00' });
    expect(exceso.status).toBe(422);
    expect(exceso.body.campos.monto).toMatch(/supera la deuda/);
    expect((await post('cajero', '/api/cobros', { clienteId: ids.cliente, cajaId: ids.caja, metodoPagoId: ids.yape, moneda: 'PEN', monto: '10.00' })).status).toBe(422);
  });

  it('el mismo cobro reenviado no se aplica dos veces', async () => {
    const clave = randomUUID();
    const cuerpo = { clienteId: ids.cliente, cajaId: ids.caja, metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '5.00' };
    const [a, b] = await Promise.all([post('cajero', '/api/cobros', cuerpo, clave), post('cajero', '/api/cobros', cuerpo, clave)]);
    expect(a.body.id).toBe(b.body.id);
    expect((await cuotas(ids.ventaA))[0]!.saldo).toBe('30.00');
  });

  it('cuota en dólares pagada en soles, aplicándola explícitamente', async () => {
    const [cuotaUsd] = await cuotas(ids.ventaUsd);
    // US$ 20 × 3.75 = S/ 75.00
    const mal = await post('cajero', '/api/cobros', { clienteId: ids.cliente, cajaId: ids.caja, metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '70.00', aplicaciones: [{ cuotaId: cuotaUsd!.id, monto: '20.00' }] });
    expect(mal.status).toBe(422);
    const ok = await post('cajero', '/api/cobros', { clienteId: ids.cliente, cajaId: ids.caja, metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '75.00', aplicaciones: [{ cuotaId: cuotaUsd!.id, monto: '20.00' }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ moneda: 'PEN', monto: '75.00', tipoCambio: '3.7500' });
    expect((await cuotas(ids.ventaUsd))[0]).toMatchObject({ saldo: '0.00', estado: 'pagada' });
  });

  it('anular un cobro devuelve el saldo y saca el dinero de caja (requiere permiso)', async () => {
    const cobro = await post('cajero', '/api/cobros', { clienteId: ids.cliente, cajaId: ids.caja, metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '30.00' });
    expect((await cuotas(ids.ventaA))[0]).toMatchObject({ saldo: '0.00', estado: 'pagada' });

    const sin = await post('cajero', `/api/cobros/${cobro.body.id}/anular`, { motivo: 'Cobro duplicado', cajaId: ids.caja }, null);
    expect(sin.status).toBe(403);
    const ok = await post('super', `/api/cobros/${cobro.body.id}/anular`, { motivo: 'Cobro duplicado', cajaId: ids.caja }, null);
    expect(ok.status).toBe(200);
    expect(ok.body.estado).toBe('anulado');
    expect((await cuotas(ids.ventaA))[0]).toMatchObject({ saldo: '30.00', estado: 'parcial' });
    expect(await db('movimientos_caja').where({ origen_tipo: 'cobro', origen_id: cobro.body.id, tipo: 'anulacion' }).first()).toMatchObject({ monto: '-30.00' });
    expect((await post('super', `/api/cobros/${cobro.body.id}/anular`, { motivo: 'Otra vez', cajaId: ids.caja }, null)).status).toBe(409);
  });

  it('una venta con cobros no se anula internamente; tras anular los cobros, sí', async () => {
    const r = await post('super', `/api/ventas/${ids.ventaB}/anular-interna`, { motivo: 'Prueba de bloqueo', cajaId: ids.caja }, null);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cobros/);
  });

  it('estado de cuenta y antigüedad de la deuda', async () => {
    // Vence la cuota 2 de A hace 40 días.
    const [, cuota2] = await cuotas(ids.ventaA);
    await db('cuotas').where('id', cuota2!.id).update({ fecha_vencimiento: dentroDe(-40) });

    const ec = await s.cajero!.agente.get(`/api/clientes/${ids.cliente}/estado-cuenta`);
    expect(ec.status).toBe(200);
    expect(ec.body.saldos).toEqual([{ moneda: 'PEN', saldo: '80.00', vencido: '50.00' }]); // USD ya pagado
    expect(ec.body.cuentas.find((c: { ventaId: number }) => c.ventaId === ids.ventaA)).toMatchObject({ vencida: true, saldo: '80.00' });
    expect(ec.body.cobros.length).toBeGreaterThanOrEqual(4);

    const ant = await s.cajero!.agente.get('/api/cxc/antiguedad');
    expect(ant.body).toEqual([{ moneda: 'PEN', porVencer: '30.00', d1a30: '0.00', d31a60: '50.00', d61a90: '0.00', mas90: '0.00', total: '80.00' }]);

    const vencidas = await s.cajero!.agente.get('/api/cxc?vencidas=true');
    expect(vencidas.body.data.map((c: { ventaId: number }) => c.ventaId)).toEqual([ids.ventaA]);
  });
});
