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
import { envioProgramado } from './resumenes.service.js';

const conBd = await hayBaseDatos();
const app = crearApp();
const CLAVE = 'Clave1234';
const ayer = () => {
  const d = new Date(`${fechaLima()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

describe.skipIf(!conBd)('resumen diario de boletas (integración con API-PRO simulada)', () => {
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
  /** Boleta para resumen ya registrada en API-PRO (estado local "pendiente_resumen"). */
  async function boletaResumen(): Promise<{ ventaId: number; comprobanteId: number; apiId: number }> {
    const r = await post('/api/ventas', {
      cajaId: ids.caja,
      tipoComprobante: '03',
      serieId: ids.b101,
      modoBoleta: 'resumen',
      moneda: 'PEN',
      cliente: null,
      items: [{ productoId: ids.producto, cantidad: '1' }],
      formaPago: 'contado',
      pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '29.90' }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await correrWorker();
    const c = await db('comprobantes').where('venta_id', r.body.venta.id).first();
    expect(c.estado).toBe('pendiente_resumen');
    return { ventaId: r.body.venta.id, comprobanteId: Number(c.id), apiId: Number(c.api_id) };
  }
  const estado = async (id: number) => (await db('comprobantes').where('id', id).first('estado')).estado;

  beforeAll(async () => {
    await prepararBdPrueba();
    api.instalar();
    registrarManejadoresEmision();
    ids.sucursal = Number((await db('sucursales').insert({ nombre: 'Centro', cod_local: '0002', api_sucursal_id: 1000, modo_boletas: 'resumen', hora_resumen: '00:00:00' }))[0]);
    await db('empresa').insert({ ruc: '20161515648', razon_social: 'EMPRESA', tasa_igv: '18.00', modo_emision: 'real' });
    ids.b101 = Number((await db('series').insert({ api_serie_id: 1, tipo_doc: '03', serie: 'B101', propia: true, sucursal_id: ids.sucursal }))[0]);
    const unidad = (await db('unidades').where('codigo_sunat', 'NIU').first('id')).id;
    ids.producto = Number((await db('productos').insert({ codigo: 'MART', nombre: 'Martillo', unidad_id: unidad, precio_venta: '29.90' }))[0]);
    await db('stock').insert({ producto_id: ids.producto, sucursal_id: ids.sucursal, cantidad: '1000' });
    ids.efectivo = Number((await db('metodos_pago').where('codigo', 'EFECTIVO').first('id')).id);
    const rol = (await db('roles').where('codigo', 'admin').first('id')).id;
    await db('usuarios').insert({ usuario: 'admin', nombre: 'Admin', password_hash: await hashClave(CLAVE), rol_id: rol, debe_cambiar_password: false });
    const agente = request.agent(app);
    const login = await agente.post('/api/auth/login').send({ usuario: 'admin', password: CLAVE });
    s = { agente, csrf: login.body.csrfToken };
    ids.caja = Number((await db('cajas').insert({ sucursal_id: ids.sucursal, nombre: 'Caja 1' }))[0]);
    await post('/api/turnos/abrir', { cajaId: ids.caja, saldosIniciales: [] });
  }, 60_000);

  beforeEach(async () => {
    // Cada prueba parte sin boletas pendientes de resumen.
    await db('comprobantes').where('estado', 'pendiente_resumen').update({ estado: 'aceptado' });
    for (const e of api.emitidos) if (e.sunat.estado === 'pendiente') e.sunat = { estado: 'aceptado', codigo: 0, descripcion: null, notas: [] };
    await db('resumenes').whereIn('estado', ['verificando', 'enviado', 'bloqueado', 'error']).update({ estado: 'rechazado' });
  });

  afterAll(async () => {
    api.desinstalar();
    await db.destroy();
  });

  it('la boleta para resumen se registra en API-PRO con solo_registro y queda "para resumen"', async () => {
    const b = await boletaResumen();
    const envio = api.llamadas.filter((l) => l.metodo === 'POST' && l.ruta === '/boletas').at(-1)!;
    expect(envio.cuerpo).toMatchObject({ solo_registro: true });
    expect((await s.agente.get('/api/resumenes/pendientes')).body).toEqual([expect.objectContaining({ fecha: fechaLima(), boletas: 1, vencido: false })]);
    expect(await estado(b.comprobanteId)).toBe('pendiente_resumen');
  });

  it('verificar y enviar: solo boletas propias; luego se consulta hasta "aceptado"', async () => {
    const a = await boletaResumen();
    const b = await boletaResumen();
    const v = await post('/api/resumenes/verificar', { fecha: fechaLima() }, null);
    expect(v.body).toMatchObject({ propias: 2, ajenas: [], noEncontradas: [], puedeEnviar: true });

    const r = await post('/api/resumenes', { fecha: fechaLima() }, null);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ estado: 'enviado', documentos: 2, incidente: false });
    expect(r.body.identifier).toMatch(/^RC-/);
    expect(await estado(a.comprobanteId)).toBe('en_resumen');

    await correrWorker();
    expect((await s.agente.get(`/api/resumenes/${r.body.id}`)).body.estado).toBe('aceptado');
    expect(await estado(a.comprobanteId)).toBe('aceptado');
    expect(await estado(b.comprobanteId)).toBe('aceptado');
  });

  it('si hay boletas pendientes de otro sistema, NO envía el RC; el respaldo envía las propias una por una', async () => {
    const propia = await boletaResumen();
    const ajena = api.agregarBoletaAjena(fechaLima());
    const antes = api.llamadas.filter((l) => l.ruta === '/resumenes').length;

    const r = await post('/api/resumenes', { fecha: fechaLima() }, null);
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('RESUMEN_BLOQUEADO_BOLETAS_AJENAS');
    expect(r.body.detalle.verificacion.ajenas).toEqual([expect.objectContaining({ apiId: ajena, cliente: 'OTRO SISTEMA' })]);
    expect(api.llamadas.filter((l) => l.ruta === '/resumenes').length).toBe(antes); // no se envió nada
    expect((await s.agente.get(`/api/resumenes/${r.body.detalle.resumenId}`)).body.estado).toBe('bloqueado');

    const ind = await post('/api/resumenes/enviar-individual', { comprobanteIds: [propia.comprobanteId] }, null);
    expect(ind.body).toMatchObject({ enviadas: 1, omitidas: [] });
    expect(api.llamadas.some((l) => l.ruta === `/boletas/${propia.apiId}/enviar`)).toBe(true);
    await correrWorker();
    expect(await estado(propia.comprobanteId)).toBe('aceptado');
    // La ajena sigue intacta en API-PRO.
    expect(api.emitidos.find((e) => e.id === ajena)!.sunat.estado).toBe('pendiente');
    api.emitidos.find((e) => e.id === ajena)!.sunat = { estado: 'aceptado', codigo: 0, descripcion: null, notas: [] };
  });

  it('no acepta fechas fuera del plazo de 7 días ni futuras', async () => {
    expect((await post('/api/resumenes', { fecha: '2020-01-01' }, null)).status).toBe(422);
    expect((await post('/api/resumenes', { fecha: '2999-01-01' }, null)).status).toBe(422);
  });

  it('envío automático: las boletas de días anteriores se declaran sin intervención', async () => {
    const b = await boletaResumen();
    // Se mueve la boleta a ayer, aquí y en API-PRO.
    await db('comprobantes').where('id', b.comprobanteId).update({ fecha_emision: ayer() });
    api.emitidos.find((e) => e.id === b.apiId)!.payload.fecha_emision = ayer();

    await envioProgramado();
    const r = await db('resumenes').where({ fecha_resumen: ayer(), estado: 'enviado' }).first();
    expect(r).toBeTruthy();
    expect(r.creado_por).toBeNull(); // automático
    await correrWorker();
    expect(await estado(b.comprobanteId)).toBe('aceptado');
  });

  it('modo simulación: el resumen se simula sin llamar a API-PRO', async () => {
    await db('empresa').update({ modo_emision: 'simulacion' });
    const r1 = await post('/api/ventas', {
      cajaId: ids.caja, tipoComprobante: '03', serieId: ids.b101, modoBoleta: 'resumen', moneda: 'PEN', cliente: null,
      items: [{ productoId: ids.producto, cantidad: '1' }], formaPago: 'contado', pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '29.90' }],
    });
    await correrWorker();
    const antes = api.llamadas.length;
    const r = await post('/api/resumenes', { fecha: fechaLima() }, null);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ estado: 'aceptado', simulado: true });
    expect(api.llamadas.length).toBe(antes);
    expect((await db('comprobantes').where('venta_id', r1.body.venta.id).first('estado')).estado).toBe('aceptado');
    await db('empresa').update({ modo_emision: 'real' });
  });
});
