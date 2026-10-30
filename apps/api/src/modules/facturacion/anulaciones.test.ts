import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

describe.skipIf(!conBd)('anulaciones: comunicación de baja y resumen de anulación (API-PRO simulada)', () => {
  const api = new ApiProFalsa(env.APIPRO_KEY || 'clave-de-pruebas-de-al-menos-20');
  const ids: Record<string, number> = {};
  const s: Record<string, { agente: ReturnType<typeof request.agent>; csrf: string }> = {};
  const post = (u: string, ruta: string, cuerpo: object = {}, clave: string | null = randomUUID()) => {
    const r = s[u]!.agente.post(ruta).set('X-CSRF-Token', s[u]!.csrf);
    if (clave) r.set('Idempotency-Key', clave);
    return r.send(cuerpo);
  };
  async function correrWorker(rondas = 10) {
    for (let i = 0; i < rondas; i++) {
      await db('outbox_trabajos').where('estado', 'pendiente').update({ ejecutar_en: db.raw('CURRENT_TIMESTAMP(3) - INTERVAL 1 SECOND') });
      if ((await procesarLote()) === 0) break;
    }
  }
  const stock = async () => Number((await db('stock').where({ producto_id: ids.martillo, sucursal_id: ids.sucursal }).first('cantidad')).cantidad);
  const comp = async (id: number) => db('comprobantes').where('id', id).first();

  /** Venta aceptada (factura o boleta); devuelve el id del comprobante. */
  async function vendida(tipo: '01' | '03', extra: Record<string, unknown> = {}): Promise<number> {
    const r = await post('admin', '/api/ventas', {
      cajaId: ids.caja,
      tipoComprobante: tipo,
      serieId: tipo === '01' ? ids.f101 : ids.b101,
      moneda: 'PEN',
      cliente: { id: tipo === '01' ? ids.ruc : ids.dni },
      items: [{ productoId: ids.martillo, cantidad: '2' }],
      formaPago: 'contado',
      pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '59.80' }],
      ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await correrWorker();
    const c = await db('comprobantes').where('venta_id', r.body.venta.id).first('id', 'estado');
    expect(c.estado).toBe('aceptado');
    return Number(c.id);
  }

  beforeAll(async () => {
    await prepararBdPrueba();
    api.instalar();
    registrarManejadoresEmision();
    ids.sucursal = Number((await db('sucursales').insert({ nombre: 'Centro', cod_local: '0002', api_sucursal_id: 1000 }))[0]);
    await db('empresa').insert({ ruc: '20161515648', razon_social: 'EMPRESA', tasa_igv: '18.00', modo_emision: 'real' });
    const serie = async (tipo: string, codigo: string, aplica: string | null, apiId: number) =>
      Number((await db('series').insert({ api_serie_id: apiId, tipo_doc: tipo, serie: codigo, aplica_a: aplica, propia: true, sucursal_id: ids.sucursal, predeterminada: true }))[0]);
    ids.b101 = await serie('03', 'B101', null, 1);
    ids.f101 = await serie('01', 'F101', null, 2);
    ids.fc11 = await serie('07', 'FC11', 'F', 3);
    const unidad = (await db('unidades').where('codigo_sunat', 'NIU').first('id')).id;
    ids.martillo = Number((await db('productos').insert({ codigo: 'MART', nombre: 'Martillo', unidad_id: unidad, precio_venta: '29.90' }))[0]);
    await db('stock').insert({ producto_id: ids.martillo, sucursal_id: ids.sucursal, cantidad: '100' });
    ids.ruc = Number((await db('clientes').insert({ tipo_doc: '6', num_doc: '20100070970', razon_social: 'ACME SAC', direccion: 'AV X' }))[0]);
    ids.dni = Number((await db('clientes').insert({ tipo_doc: '1', num_doc: '12345678', razon_social: 'Juan Pérez' }))[0]);
    ids.efectivo = Number((await db('metodos_pago').where('codigo', 'EFECTIVO').first('id')).id);
    for (const [usuario, rol] of [['admin', 'admin'], ['cajero', 'cajero']] as const) {
      const r = (await db('roles').where('codigo', rol).first('id')).id;
      const [id] = await db('usuarios').insert({ usuario, nombre: usuario, password_hash: await hashClave(CLAVE), rol_id: r, debe_cambiar_password: false });
      await db('usuario_sucursales').insert({ usuario_id: id, sucursal_id: ids.sucursal });
      const agente = request.agent(app);
      const login = await agente.post('/api/auth/login').send({ usuario, password: CLAVE });
      s[usuario] = { agente, csrf: login.body.csrfToken };
    }
    ids.caja = Number((await db('cajas').insert({ sucursal_id: ids.sucursal, nombre: 'Caja 1' }))[0]);
    ids.turno = (await post('admin', '/api/turnos/abrir', { cajaId: ids.caja, saldosIniciales: [{ moneda: 'PEN', monto: '300' }] })).body.turno.id;
  }, 60_000);

  beforeEach(() => {
    api.rechazarAnulacion = false;
  });

  afterAll(async () => {
    api.desinstalar();
    await db.destroy();
  });

  it('factura: comunicación de baja; al confirmarse, devuelve stock y deja el reembolso pendiente', async () => {
    const id = await vendida('01');
    const v = await post('admin', '/api/anulaciones/validar', { comprobanteIds: [id] }, null);
    expect(v.body).toMatchObject({ mecanismo: 'RA', permitido: true, bloqueos: [] });
    expect((await s.admin!.agente.get(`/api/comprobantes/${id}`)).body.acciones).toContain('anular');

    const stockAntes = await stock();
    const r = await post('admin', '/api/anulaciones', { comprobanteIds: [id], motivo: 'Error en el pedido del cliente' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.mecanismo).toBe('RA');
    const c = await comp(id);
    expect(c.estado).toBe('anulacion_en_proceso');
    expect((await db('ventas').where('id', c.venta_id).first('estado')).estado).toBe('anulacion_en_proceso');
    expect(await stock()).toBe(stockAntes); // los efectos esperan la confirmación de SUNAT

    await correrWorker();
    const envio = api.llamadas.find((l) => l.metodo === 'POST' && l.ruta === '/anulaciones')!;
    expect(envio.cuerpo).toMatchObject({ fecha_generacion: c.fecha_emision, fecha_comunicacion: fechaLima(), detalles: [{ tipo_documento: '01', serie: 'F101', correlativo: String(c.correlativo), motivo: 'Error en el pedido del cliente' }] });
    expect(api.llamadas.some((l) => /\/anulaciones\/\d+\/estado$/.test(l.ruta))).toBe(false); // guarda B1

    expect((await comp(id)).estado).toBe('anulado');
    expect(await stock()).toBe(stockAntes + 2);
    const venta = await db('ventas').where('id', c.venta_id).first('estado', 'reembolso_pendiente');
    expect(venta).toMatchObject({ estado: 'anulada', reembolso_pendiente: '59.80' });

    const reemb = await post('admin', `/api/ventas/${c.venta_id}/reembolsar`, { cajaId: ids.caja, metodoPagoId: ids.efectivo }, null);
    expect(reemb.body).toEqual({ reembolsado: '59.80' });
    expect(await db('movimientos_caja').where({ origen_tipo: 'reembolso', origen_id: c.venta_id }).first()).toMatchObject({ monto: '-59.80' });
    expect((await post('admin', `/api/ventas/${c.venta_id}/reembolsar`, { cajaId: ids.caja, metodoPagoId: ids.efectivo }, null)).status).toBe(409);
  });

  it('si SUNAT rechaza la baja, el comprobante y la venta vuelven a estar vigentes sin tocar el stock', async () => {
    const id = await vendida('01');
    api.rechazarAnulacion = true;
    const stockAntes = await stock();
    await post('admin', '/api/anulaciones', { comprobanteIds: [id], motivo: 'Prueba de rechazo' });
    await correrWorker();
    const c = await comp(id);
    expect(c.estado).toBe('aceptado');
    expect((await db('ventas').where('id', c.venta_id).first('estado')).estado).toBe('confirmada');
    expect(await stock()).toBe(stockAntes);
    expect((await s.admin!.agente.get('/api/anulaciones')).body[0]).toMatchObject({ mecanismo: 'RA', estado: 'rechazado' });
  });

  it('boleta: resumen de anulación con el id interno de API-PRO', async () => {
    const id = await vendida('03');
    const c = await comp(id);
    const r = await post('admin', '/api/anulaciones', { comprobanteIds: [id], motivo: 'Boleta emitida por error' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.mecanismo).toBe('RC');
    await correrWorker();
    const envio = api.llamadas.filter((l) => l.metodo === 'POST' && l.ruta === '/resumenes').at(-1)!;
    expect(envio.cuerpo).toEqual({ fecha_resumen: c.fecha_emision, anular: [{ id: Number(c.api_id), motivo: 'Boleta emitida por error' }] });
    expect((await comp(id)).estado).toBe('anulado');
    // El resumen de anulación no aparece en el listado del resumen diario de envío.
    expect((await s.admin!.agente.get('/api/resumenes')).body.every((x: { tipo: string }) => x.tipo === 'envio')).toBe(true);
  });

  it('bloqueos: mezclar boletas con facturas, fuera de plazo, con notas vigentes o sin permiso', async () => {
    const f = await vendida('01');
    const b = await vendida('03');
    const mezcla = await post('admin', '/api/anulaciones/validar', { comprobanteIds: [f, b] }, null);
    expect(mezcla.body.permitido).toBe(false);
    expect(mezcla.body.bloqueos.join()).toMatch(/por separado/);

    const viejo = await vendida('01');
    await db('comprobantes').where('id', viejo).update({ fecha_emision: dentroDe(-10) });
    expect((await post('admin', '/api/anulaciones/validar', { comprobanteIds: [viejo] }, null)).body.bloqueos.join()).toMatch(/plazo/);

    const conNota = await vendida('01');
    const nc = await post('admin', '/api/notas-credito', { comprobanteAfectadoId: conNota, codMotivo: '07', desMotivo: 'Devuelve una unidad', items: [{ comprobanteItemId: (await s.admin!.agente.get(`/api/comprobantes/${conNota}/saldo-nota`)).body.lineas[0].id, cantidad: '1' }], devuelveStock: true, reintegro: { tipo: 'ninguno' } });
    expect(nc.status).toBe(201);
    const bloqueada = await post('admin', '/api/anulaciones', { comprobanteIds: [conNota], motivo: 'No debería poder' });
    expect(bloqueada.status).toBe(409);
    expect(bloqueada.body.error).toMatch(/notas vigentes/);

    expect((await post('cajero', '/api/anulaciones', { comprobanteIds: [f], motivo: 'Sin permiso' })).status).toBe(403);
  });

  it('venta al crédito: la deuda se anula al confirmarse; con cobros no se puede anular', async () => {
    const credito = { formaPago: 'credito', pagos: [], cuotas: [{ monto: '59.80', fechaVencimiento: dentroDe(30) }] };
    const id = await vendida('01', credito);
    await post('admin', '/api/anulaciones', { comprobanteIds: [id], motivo: 'Venta al crédito anulada' });
    await correrWorker();
    const venta = (await comp(id)).venta_id;
    expect(await db('cuentas_por_cobrar').where('venta_id', venta).first('estado', 'saldo')).toMatchObject({ estado: 'anulada', saldo: '0.00' });
    expect((await db('ventas').where('id', venta).first('reembolso_pendiente')).reembolso_pendiente).toBe('0.00');

    const conCobro = await vendida('01', credito);
    await post('admin', '/api/cobros', { clienteId: ids.ruc, cajaId: ids.caja, metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '10.00' });
    const r = await post('admin', '/api/anulaciones', { comprobanteIds: [conCobro], motivo: 'Tiene cobros' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/cobros/);
  });

  it('la misma solicitud reenviada no crea dos bajas', async () => {
    const id = await vendida('01');
    const clave = randomUUID();
    const a = await post('admin', '/api/anulaciones', { comprobanteIds: [id], motivo: 'Duplicado de prueba' }, clave);
    const b = await post('admin', '/api/anulaciones', { comprobanteIds: [id], motivo: 'Duplicado de prueba' }, clave);
    expect(a.body.id).toBe(b.body.id);
    await correrWorker();
    const apiId = Number((await comp(id)).api_id);
    expect(api.bajas.filter((x) => x.docs.includes(apiId)).length).toBe(1);
  });

  it('modo simulación: la anulación se simula al instante', async () => {
    await db('empresa').update({ modo_emision: 'simulacion' });
    const id = await vendida('03');
    const antes = api.llamadas.length;
    const r = await post('admin', '/api/anulaciones', { comprobanteIds: [id], motivo: 'Simulación de anulación' });
    expect(r.body).toMatchObject({ mecanismo: 'RC', estado: 'aceptado', simulado: true });
    expect((await comp(id)).estado).toBe('anulado');
    expect(api.llamadas.length).toBe(antes);
    await db('empresa').update({ modo_emision: 'real' });
  });
});
