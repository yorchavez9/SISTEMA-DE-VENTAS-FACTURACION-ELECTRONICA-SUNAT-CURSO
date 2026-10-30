import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../../app.js';
import { env } from '../../config/env.js';
import { db } from '../../database/db.js';
import { procesarLote } from '../../jobs/outbox.js';
import { hashClave } from '../../shared/claves.js';
import { fechaLima } from '../../shared/fechas.js';
import { ApiProFalsa } from '../../test/apiProFalsa.js';
import { hayBaseDatos, prepararBdPrueba } from '../../test/bd.js';
import { registrarManejadoresEmision } from './emision.service.js';

const conBd = await hayBaseDatos();
const app = crearApp();
const CLAVE = 'Clave1234';
const dentroDe = (dias: number) => {
  const d = new Date(`${fechaLima()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

describe.skipIf(!conBd)('notas de crédito y débito (integración con API-PRO simulada)', () => {
  const api = new ApiProFalsa(env.APIPRO_KEY || 'clave-de-pruebas-de-al-menos-20');
  const ids: Record<string, number> = {};
  let s: { agente: ReturnType<typeof request.agent>; csrf: string };
  const post = (ruta: string, cuerpo: object = {}, clave: string | null = randomUUID()) => {
    const r = s.agente.post(ruta).set('X-CSRF-Token', s.csrf);
    if (clave) r.set('Idempotency-Key', clave);
    return r.send(cuerpo);
  };
  async function correrWorker(rondas = 8) {
    for (let i = 0; i < rondas; i++) {
      await db('outbox_trabajos').where('estado', 'pendiente').update({ ejecutar_en: db.raw('CURRENT_TIMESTAMP(3) - INTERVAL 1 SECOND') });
      if ((await procesarLote()) === 0) break;
    }
  }
  const stock = async () => Number((await db('stock').where({ producto_id: ids.martillo, sucursal_id: ids.sucursal }).first('cantidad')).cantidad);
  const efectivoCaja = async () => {
    const r = await s.agente.get(`/api/turnos/${ids.turno}`);
    return Number(r.body.efectivo.find((e: { moneda: string }) => e.moneda === 'PEN').esperado);
  };

  /** Venta aceptada por SUNAT; devuelve el id del comprobante. */
  async function ventaAceptada(extra: Record<string, unknown> = {}): Promise<number> {
    const r = await post('/api/ventas', {
      cajaId: ids.caja,
      tipoComprobante: '03',
      serieId: ids.b101,
      moneda: 'PEN',
      cliente: { id: ids.cliente },
      items: [{ productoId: ids.martillo, cantidad: '3' }],
      formaPago: 'contado',
      pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '89.70' }],
      ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await correrWorker();
    const c = await db('comprobantes').where('venta_id', r.body.venta.id).first();
    expect(c.estado).toBe('aceptado');
    return Number(c.id);
  }

  beforeAll(async () => {
    await prepararBdPrueba();
    api.instalar();
    registrarManejadoresEmision();
    ids.sucursal = Number((await db('sucursales').insert({ nombre: 'Centro', cod_local: '0002', api_sucursal_id: 1000 }))[0]);
    await db('empresa').insert({ ruc: '20161515648', razon_social: 'EMPRESA', tasa_igv: '18.00', modo_emision: 'real' });
    const serie = async (tipo: string, codigo: string, aplica: string | null, apiId: number, predeterminada = false) =>
      Number((await db('series').insert({ api_serie_id: apiId, tipo_doc: tipo, serie: codigo, aplica_a: aplica, propia: true, sucursal_id: ids.sucursal, predeterminada }))[0]);
    ids.b101 = await serie('03', 'B101', null, 1);
    ids.bc11 = await serie('07', 'BC11', 'B', 2, true);
    ids.bd11 = await serie('08', 'BD11', 'B', 3, true);
    const unidad = (await db('unidades').where('codigo_sunat', 'NIU').first('id')).id;
    ids.martillo = Number((await db('productos').insert({ codigo: 'MART', nombre: 'Martillo', unidad_id: unidad, precio_venta: '29.90' }))[0]);
    await db('stock').insert({ producto_id: ids.martillo, sucursal_id: ids.sucursal, cantidad: '100' });
    ids.cliente = Number((await db('clientes').insert({ tipo_doc: '1', num_doc: '12345678', razon_social: 'Juan Pérez' }))[0]);
    ids.efectivo = Number((await db('metodos_pago').where('codigo', 'EFECTIVO').first('id')).id);
    const rol = (await db('roles').where('codigo', 'admin').first('id')).id;
    await db('usuarios').insert({ usuario: 'admin', nombre: 'Admin', password_hash: await hashClave(CLAVE), rol_id: rol, debe_cambiar_password: false });
    const agente = request.agent(app);
    const login = await agente.post('/api/auth/login').send({ usuario: 'admin', password: CLAVE });
    s = { agente, csrf: login.body.csrfToken };
    ids.caja = Number((await db('cajas').insert({ sucursal_id: ids.sucursal, nombre: 'Caja 1' }))[0]);
    ids.turno = (await post('/api/turnos/abrir', { cajaId: ids.caja, saldosIniciales: [{ moneda: 'PEN', monto: '500' }] })).body.turno.id;
  }, 60_000);

  afterAll(async () => {
    api.desinstalar();
    await db.destroy();
  });

  it('devolución por ítem: devuelve stock y dinero, y se emite con los datos del documento afectado', async () => {
    const afectado = await ventaAceptada();
    const saldo = await s.agente.get(`/api/comprobantes/${afectado}/saldo-nota`);
    expect(saldo.body).toMatchObject({ total: '89.70', acreditado: '0.00', saldo: '89.70', seriesNc: [{ serie: 'BC11', predeterminada: true }] });
    const linea = saldo.body.lineas[0];
    expect(linea).toMatchObject({ cantidad: '3.000', disponible: '3.000', inventariable: true });

    const [stockAntes, cajaAntes] = [await stock(), await efectivoCaja()];
    const r = await post('/api/notas-credito', {
      comprobanteAfectadoId: afectado,
      codMotivo: '07',
      desMotivo: 'Cliente devuelve una unidad',
      items: [{ comprobanteItemId: linea.id, cantidad: '1' }],
      devuelveStock: true,
      reintegro: { tipo: 'caja', cajaId: ids.caja, metodoPagoId: ids.efectivo },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ tipoDoc: '07', serie: 'BC11', total: '29.90', estado: 'pendiente' });
    expect(await stock()).toBe(stockAntes + 1);
    expect(await efectivoCaja()).toBeCloseTo(cajaAntes - 29.9, 2);

    await correrWorker();
    const nc = await db('comprobantes').where('id', r.body.id).first();
    expect(nc.estado).toBe('aceptado');
    const envio = api.llamadas.find((l) => l.metodo === 'POST' && l.ruta === '/notas-credito')!;
    const afectadoDb = await db('comprobantes').where('id', afectado).first('serie', 'correlativo');
    expect(envio.cuerpo).toMatchObject({
      serie: 'BC11',
      doc_afectado_tipo: '03',
      doc_afectado_serie: afectadoDb.serie,
      doc_afectado_correlativo: String(afectadoDb.correlativo),
      cod_motivo: '07',
      items: [expect.objectContaining({ cantidad: 1, precio_unitario: 29.9 })],
    });
    expect(envio.cuerpo).not.toHaveProperty('forma_pago');
    expect(envio.cuerpo).not.toHaveProperty('cuotas');

    const despues = await s.agente.get(`/api/comprobantes/${afectado}/saldo-nota`);
    expect(despues.body).toMatchObject({ acreditado: '29.90', saldo: '59.80' });
    expect(despues.body.lineas[0].disponible).toBe('2.000');
  });

  it('no acredita más de lo vendido ni repite una devolución total sobre un comprobante ya acreditado', async () => {
    const afectado = await ventaAceptada();
    const linea = (await s.agente.get(`/api/comprobantes/${afectado}/saldo-nota`)).body.lineas[0];
    const base = { comprobanteAfectadoId: afectado, desMotivo: 'Devolución de prueba', devuelveStock: false, reintegro: { tipo: 'ninguno' } };
    const exceso = await post('/api/notas-credito', { ...base, codMotivo: '07', items: [{ comprobanteItemId: linea.id, cantidad: '4' }] });
    expect(exceso.status).toBe(422);
    const fraccion = await post('/api/notas-credito', { ...base, codMotivo: '07', items: [{ comprobanteItemId: linea.id, cantidad: '0.5' }] });
    expect(fraccion.status).toBe(422);

    expect((await post('/api/notas-credito', { ...base, codMotivo: '07', items: [{ comprobanteItemId: linea.id, cantidad: '1' }] })).status).toBe(201);
    const total = await post('/api/notas-credito', { ...base, codMotivo: '06' });
    expect(total.status).toBe(409);
    expect(total.body.codigo).toBe('SALDO_NC_EXCEDIDO');
  });

  it('devolución total con la misma clave no duplica; luego el saldo queda en cero', async () => {
    const afectado = await ventaAceptada();
    const stockAntes = await stock();
    const cuerpo = { comprobanteAfectadoId: afectado, codMotivo: '06', desMotivo: 'Devolución total del pedido', devuelveStock: true, reintegro: { tipo: 'caja', cajaId: ids.caja, metodoPagoId: ids.efectivo } };
    const clave = randomUUID();
    const [a, b] = await Promise.all([post('/api/notas-credito', cuerpo, clave), post('/api/notas-credito', cuerpo, clave)]);
    expect(a.body.id).toBe(b.body.id);
    expect(a.body.total).toBe('89.70');
    expect(await stock()).toBe(stockAntes + 3);
    expect((await s.agente.get(`/api/comprobantes/${afectado}/saldo-nota`)).body.saldo).toBe('0.00');
    expect((await post('/api/notas-credito', { ...cuerpo, codMotivo: '01' })).status).toBe(409);
  });

  it('solo sobre comprobantes aceptados', async () => {
    await db('empresa').update({ modo_emision: 'real' });
    await correrWorker(); // que ningún envío pendiente de otra prueba consuma el fallo inyectado
    api.fallos = [422];
    const r = await post('/api/ventas', {
      cajaId: ids.caja, tipoComprobante: '03', serieId: ids.b101, moneda: 'PEN', cliente: null,
      items: [{ productoId: ids.martillo, cantidad: '1' }], formaPago: 'contado', pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '29.90' }],
    });
    await correrWorker();
    const c = await db('comprobantes').where('venta_id', r.body.venta.id).first('id', 'estado');
    expect(c.estado).toBe('error_validacion');
    const nc = await post('/api/notas-credito', { comprobanteAfectadoId: c.id, codMotivo: '01', desMotivo: 'No procede aún', devuelveStock: false, reintegro: { tipo: 'ninguno' } });
    expect(nc.status).toBe(409);
  });

  it('venta al crédito: la NC rebaja la deuda desde la última cuota', async () => {
    const afectado = await ventaAceptada({
      formaPago: 'credito',
      pagos: [],
      cuotas: [{ monto: '44.85', fechaVencimiento: dentroDe(30) }, { monto: '44.85', fechaVencimiento: dentroDe(60) }],
    });
    const linea = (await s.agente.get(`/api/comprobantes/${afectado}/saldo-nota`)).body.lineas[0];
    const r = await post('/api/notas-credito', { comprobanteAfectadoId: afectado, codMotivo: '07', desMotivo: 'Devuelve una unidad', items: [{ comprobanteItemId: linea.id, cantidad: '1' }], devuelveStock: true, reintegro: { tipo: 'cxc' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const venta = (await db('comprobantes').where('id', afectado).first('venta_id')).venta_id;
    const cxc = await db('cuentas_por_cobrar').where('venta_id', venta).first();
    expect(cxc).toMatchObject({ total: '59.80', saldo: '59.80' });
    const cuotas = await db('cuotas').where('cxc_id', cxc.id).orderBy('numero').select('monto', 'saldo');
    expect(cuotas).toEqual([{ monto: '44.85', saldo: '44.85' }, { monto: '14.95', saldo: '14.95' }]);
  });

  it('nota de débito: se cobra en caja o se agrega como cuota a la deuda', async () => {
    const afectado = await ventaAceptada();
    const cajaAntes = await efectivoCaja();
    const nd = await post('/api/notas-debito', {
      comprobanteAfectadoId: afectado,
      codMotivo: '02',
      desMotivo: 'Recargo por flete no facturado',
      items: [{ descripcion: 'Flete', cantidad: '1', precioUnitario: '11.80', tipAfeIgv: '10' }],
      cobro: { tipo: 'caja', cajaId: ids.caja, metodoPagoId: ids.efectivo },
    });
    expect(nd.status, JSON.stringify(nd.body)).toBe(201);
    expect(nd.body).toMatchObject({ tipoDoc: '08', serie: 'BD11', total: '11.80', opGravada: '10.00', igv: '1.80' });
    expect(await efectivoCaja()).toBeCloseTo(cajaAntes + 11.8, 2);
    await correrWorker();
    expect((await db('comprobantes').where('id', nd.body.id).first('estado')).estado).toBe('aceptado');
    const envio = api.llamadas.filter((l) => l.metodo === 'POST' && l.ruta === '/notas-debito').at(-1)!;
    expect(envio.cuerpo).toMatchObject({ cod_motivo: '02', doc_afectado_tipo: '03', items: [expect.objectContaining({ descripcion: 'Flete', unidad: 'ZZ' })] });

    // Sobre una venta al crédito, la ND se suma como nueva cuota.
    const credito = await ventaAceptada({ formaPago: 'credito', pagos: [], cuotas: [{ monto: '89.70', fechaVencimiento: dentroDe(30) }] });
    const nd2 = await post('/api/notas-debito', {
      comprobanteAfectadoId: credito,
      codMotivo: '01',
      desMotivo: 'Intereses por mora',
      items: [{ descripcion: 'Intereses', cantidad: '1', precioUnitario: '5.90', tipAfeIgv: '10' }],
      cobro: { tipo: 'cxc', fechaVencimiento: dentroDe(45) },
    });
    expect(nd2.status, JSON.stringify(nd2.body)).toBe(201);
    const venta = (await db('comprobantes').where('id', credito).first('venta_id')).venta_id;
    expect(await db('cuentas_por_cobrar').where('venta_id', venta).first()).toMatchObject({ total: '95.60', saldo: '95.60' });
  });

  it('nota sobre un comprobante simulado: se simula también (SUNAT no conoce el afectado)', async () => {
    await db('empresa').update({ modo_emision: 'simulacion' });
    const afectado = await ventaAceptada();
    await db('empresa').update({ modo_emision: 'real' });
    const antes = api.llamadas.filter((l) => l.ruta === '/notas-credito').length;
    const r = await post('/api/notas-credito', { comprobanteAfectadoId: afectado, codMotivo: '01', desMotivo: 'Anulación de la operación', devuelveStock: true, reintegro: { tipo: 'ninguno' } });
    expect(r.status).toBe(201);
    await correrWorker();
    expect(await db('comprobantes').where('id', r.body.id).first('estado', 'simulado')).toMatchObject({ estado: 'aceptado', simulado: 1 });
    expect(api.llamadas.filter((l) => l.ruta === '/notas-credito').length).toBe(antes);
  });

  it('el detalle del comprobante aceptado ofrece emitir notas', async () => {
    const afectado = await ventaAceptada();
    expect((await s.agente.get(`/api/comprobantes/${afectado}`)).body.acciones).toEqual(expect.arrayContaining(['nota_credito', 'nota_debito']));
  });
});
