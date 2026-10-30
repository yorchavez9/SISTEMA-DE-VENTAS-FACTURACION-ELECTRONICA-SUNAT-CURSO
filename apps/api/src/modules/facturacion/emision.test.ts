import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearApp } from '../../app.js';
import { env } from '../../config/env.js';
import { db } from '../../database/db.js';
import { procesarLote } from '../../jobs/outbox.js';
import { hashClave } from '../../shared/claves.js';
import { ApiProFalsa } from '../../test/apiProFalsa.js';
import { hayBaseDatos, prepararBdPrueba } from '../../test/bd.js';
import { registrarManejadoresEmision } from './emision.service.js';
import { reanudar } from './pausa.js';

const conBd = await hayBaseDatos();
const app = crearApp();
const CLAVE = 'Clave1234';

describe.skipIf(!conBd)('emisión de comprobantes (integración con API-PRO simulada)', () => {
  const api = new ApiProFalsa(env.APIPRO_KEY || 'clave-de-pruebas-de-al-menos-20');
  const ids: Record<string, number> = {};
  let s: { agente: ReturnType<typeof request.agent>; csrf: string };
  const post = (ruta: string, cuerpo: object = {}, clave: string | null = randomUUID()) => {
    const r = s.agente.post(ruta).set('X-CSRF-Token', s.csrf);
    if (clave) r.set('Idempotency-Key', clave);
    return r.send(cuerpo);
  };

  /** Ejecuta el worker hasta vaciar la cola de trabajos ya vencidos (adelantando los reintentos). */
  async function correrWorker(rondas = 6): Promise<void> {
    for (let i = 0; i < rondas; i++) {
      await db('outbox_trabajos').where('estado', 'pendiente').update({ ejecutar_en: db.raw('CURRENT_TIMESTAMP(3) - INTERVAL 1 SECOND') });
      if ((await procesarLote()) === 0) break;
    }
  }
  const comprobante = async (ventaId: number) => db('comprobantes').where('venta_id', ventaId).first();
  async function vender(extra: Record<string, unknown> = {}): Promise<number> {
    const r = await post('/api/ventas', {
      cajaId: ids.caja,
      tipoComprobante: '03',
      serieId: ids.b101,
      moneda: 'PEN',
      cliente: null,
      items: [{ productoId: ids.producto, cantidad: '2' }],
      formaPago: 'contado',
      pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '59.80' }],
      ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.venta.id;
  }
  const modo = (m: 'simulacion' | 'real') => db('empresa').update({ modo_emision: m });

  beforeAll(async () => {
    await prepararBdPrueba();
    api.instalar();
    registrarManejadoresEmision();
    ids.sucursal = Number((await db('sucursales').insert({ nombre: 'Centro', cod_local: '0002', api_sucursal_id: 1000 }))[0]);
    await db('empresa').insert({ ruc: '20161515648', razon_social: 'EMPRESA', tasa_igv: '18.00', modo_emision: 'simulacion' });
    ids.b101 = Number((await db('series').insert({ api_serie_id: 1, tipo_doc: '03', serie: 'B101', propia: true, sucursal_id: ids.sucursal }))[0]);
    ids.f101 = Number((await db('series').insert({ api_serie_id: 2, tipo_doc: '01', serie: 'F101', propia: true, sucursal_id: ids.sucursal }))[0]);
    const unidad = (await db('unidades').where('codigo_sunat', 'NIU').first('id')).id;
    ids.producto = Number((await db('productos').insert({ codigo: 'MART', nombre: 'Martillo', unidad_id: unidad, precio_venta: '29.90' }))[0]);
    await db('stock').insert({ producto_id: ids.producto, sucursal_id: ids.sucursal, cantidad: '1000' });
    ids.cliente = Number((await db('clientes').insert({ tipo_doc: '6', num_doc: '20100070970', razon_social: 'ACME SAC', direccion: 'AV. X 123' }))[0]);
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
    api.fallos = [];
    api.resultadoSunat = { estado: 'aceptado', codigo: 0, descripcion: 'Aceptada', notas: [] };
    await reanudar();
  });

  afterAll(async () => {
    api.desinstalar();
    await db.destroy();
  });

  it('modo simulación: numera localmente, sin llamar a API-PRO', async () => {
    await modo('simulacion');
    const antes = api.llamadas.length;
    const v1 = await vender();
    const v2 = await vender({ modoBoleta: 'resumen' });
    await correrWorker();
    expect(await comprobante(v1)).toMatchObject({ estado: 'aceptado', simulado: 1, numero_completo: 'B101-000001' });
    expect(await comprobante(v2)).toMatchObject({ estado: 'pendiente_resumen', simulado: 1, numero_completo: 'B101-000002' });
    expect(api.llamadas.length).toBe(antes);
  });

  it('modo real: envía el payload del contrato, guarda el número y consulta hasta "aceptado"', async () => {
    await modo('real');
    const v = await vender();
    await correrWorker();
    const c = await comprobante(v);
    expect(c).toMatchObject({ estado: 'aceptado', numero_completo: 'B101-000001', total_api: '59.80', simulado: 0 });
    const post = api.llamadas.find((l) => l.metodo === 'POST' && l.ruta === '/boletas')!;
    expect(post.cuerpo).toMatchObject({ serie: 'B101', tipo_moneda: 'PEN', forma_pago: 'Contado', cod_local: '0002', cliente: { tipo_doc: '0', num_doc: '-', razon_social: 'CLIENTES VARIOS' } });
    expect(post.cuerpo).not.toHaveProperty('mto_igv');
    expect(api.llamadas.some((l) => l.metodo === 'GET' && l.ruta === `/boletas/${c.api_id}`)).toBe(true);
    expect(await db('integracion_intentos').where({ entidad_tipo: 'comprobante', entidad_id: c.id }).count({ n: '*' })).toEqual([{ n: 2 }]);
  });

  it('observaciones de SUNAT → "observado"; rechazo → "rechazado"', async () => {
    await modo('real');
    api.resultadoSunat = { estado: 'aceptado', codigo: 4252, descripcion: 'Aceptada con observaciones', notas: ['4252 - obs'] };
    const v1 = await vender();
    await correrWorker();
    expect((await comprobante(v1)).estado).toBe('observado');

    api.resultadoSunat = { estado: 'rechazado', codigo: 2017, descripcion: 'El número de RUC del receptor no existe', notas: null };
    const v2 = await vender({ tipoComprobante: '01', serieId: ids.f101, cliente: { id: ids.cliente } });
    await correrWorker();
    expect(await comprobante(v2)).toMatchObject({ estado: 'rechazado', sunat_codigo: '2017' });
  });

  it('respuesta perdida tras crear (timeout): reintenta con la misma clave y no duplica', async () => {
    await modo('real');
    api.fallos = ['red_tras_crear'];
    const antes = api.emitidos.length;
    const v = await vender();
    await procesarLote(); // primer intento: API-PRO lo crea pero no llega la respuesta
    expect((await comprobante(v)).estado).toBe('por_verificar');
    await correrWorker();
    expect((await comprobante(v)).estado).toBe('aceptado');
    expect(api.emitidos.length).toBe(antes + 1); // un solo comprobante en API-PRO
  });

  it('error 500 o sin red: queda "por verificar" y se recupera solo', async () => {
    await modo('real');
    api.fallos = ['red', 500];
    const v = await vender();
    await procesarLote();
    expect((await comprobante(v)).estado).toBe('por_verificar');
    await correrWorker();
    expect((await comprobante(v)).estado).toBe('aceptado');
  });

  it('422 de API-PRO → "datos inválidos"; corregir el cliente vuelve a emitir con clave nueva', async () => {
    await modo('real');
    api.fallos = [422];
    const v = await vender({ tipoComprobante: '01', serieId: ids.f101, cliente: { id: ids.cliente } });
    await correrWorker();
    const c = await comprobante(v);
    expect(c.estado).toBe('error_validacion');
    expect(c.ultimo_error).toMatch(/RUC no es válido/);

    const detalle = await s.agente.get(`/api/comprobantes/${c.id}`);
    expect(detalle.body.acciones).toEqual(expect.arrayContaining(['corregir', 'anular_interna']));
    const corr = await s.agente.put(`/api/comprobantes/${c.id}/corregir`).set('X-CSRF-Token', s.csrf).send({ cliente: { tipoDoc: '6', numDoc: '20161515648', razonSocial: 'CLIENTE CORRECTO SAC', direccion: 'AV. Y 456' } });
    expect(corr.status, JSON.stringify(corr.body)).toBe(200);
    expect((await comprobante(v)).idempotency_key).not.toBe(c.idempotency_key);
    await correrWorker();
    expect(await comprobante(v)).toMatchObject({ estado: 'aceptado', cliente_num_doc: '20161515648' });
  });

  it('credenciales inválidas (401) pausan la emisión sin gastar intentos; al reanudar se emite', async () => {
    await modo('real');
    api.fallos = [401];
    const v = await vender();
    await procesarLote();
    expect((await comprobante(v)).estado).toBe('pendiente');
    const estado = await s.agente.get('/api/estado-integracion');
    expect(estado.body).toMatchObject({ colaPausada: true, pausa: { codigo: 'APIPRO_CREDENCIALES' } });

    const antes = api.llamadas.length;
    await correrWorker();
    expect(api.llamadas.length).toBe(antes); // pausado: no se llama a la API
    expect((await post('/api/estado-integracion/reanudar', {}, null)).status).toBe(204);
    await correrWorker();
    expect((await comprobante(v)).estado).toBe('aceptado');
  });

  it('cupo agotado (429 limit_reached) también pausa', async () => {
    await modo('real');
    api.fallos = ['cupo'];
    const v = await vender();
    await procesarLote();
    expect((await s.agente.get('/api/estado-integracion')).body.pausa.codigo).toBe('limit_reached');
    expect((await comprobante(v)).estado).toBe('pendiente');
  });

  it('reintentar un rechazado: lee el estado remoto y solo reenvía si lo permite (guarda B2)', async () => {
    await modo('real');
    api.resultadoSunat = { estado: 'rechazado', codigo: 2800, descripcion: 'Error temporal', notas: null };
    const v = await vender();
    await correrWorker();
    const c = await comprobante(v);
    api.resultadoSunat = { estado: 'aceptado', codigo: 0, descripcion: 'Aceptada', notas: [] };
    const r = await post(`/api/comprobantes/${c.id}/reintentar`, {}, null);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(api.llamadas.some((l) => l.ruta === `/boletas/${c.api_id}/enviar`)).toBe(true);
    await correrWorker();
    expect((await comprobante(v)).estado).toBe('aceptado');

    // Si en API-PRO ya está anulado, no se reenvía.
    const v2 = await vender();
    await correrWorker();
    const c2 = await comprobante(v2);
    await db('comprobantes').where('id', c2.id).update({ estado: 'rechazado' });
    api.emitidos.find((e) => e.id === Number(c2.api_id))!.sunat = { estado: 'anulado', codigo: null, descripcion: null, notas: null };
    const antes = api.llamadas.filter((l) => l.ruta.endsWith('/enviar')).length;
    const bloqueado = await post(`/api/comprobantes/${c2.id}/reintentar`, {}, null);
    expect(bloqueado.status).toBe(409);
    expect(api.llamadas.filter((l) => l.ruta.endsWith('/enviar')).length).toBe(antes);
  });

  it('PDF: usa ?format= y guarda en caché cuando el estado es definitivo', async () => {
    await modo('real');
    const v = await vender();
    await correrWorker();
    const c = await comprobante(v);
    const r1 = await s.agente.get(`/api/comprobantes/${c.id}/pdf?formato=ticket-80`);
    expect(r1.status).toBe(200);
    expect(r1.headers['content-type']).toMatch(/application\/pdf/);
    expect(api.llamadas.some((l) => l.ruta === `/boletas/${c.api_id}/pdf?format=ticket-80`)).toBe(true);
    expect(api.llamadas.some((l) => l.ruta.includes('formato='))).toBe(false);

    const antes = api.llamadas.length;
    const r2 = await s.agente.get(`/api/comprobantes/${c.id}/pdf?formato=ticket-80`);
    expect(r2.status).toBe(200);
    expect(api.llamadas.length).toBe(antes); // desde caché
    expect((await s.agente.get(`/api/comprobantes/${c.id}/xml`)).headers['content-type']).toMatch(/xml/);
  });

  it('un comprobante simulado no tiene archivos de SUNAT', async () => {
    await modo('simulacion');
    const v = await vender();
    await correrWorker();
    const c = await comprobante(v);
    expect((await s.agente.get(`/api/comprobantes/${c.id}/pdf`)).status).toBe(409);
  });

  it('listado con filtro de atención y contadores en el estado de la integración', async () => {
    const lista = await s.agente.get('/api/comprobantes?atencion=true');
    expect(lista.body.data.every((c: { estado: string }) => ['rechazado', 'error_validacion', 'por_verificar', 'sin_respuesta_sunat'].includes(c.estado))).toBe(true);
    const estado = await s.agente.get('/api/estado-integracion');
    expect(estado.body.contadores).toHaveProperty('problemas');
  });
});
