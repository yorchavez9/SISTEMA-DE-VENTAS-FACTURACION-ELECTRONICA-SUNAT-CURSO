import { rucValido } from '@sv/shared';
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
import { registrarManejadoresEmision } from '../facturacion/emision.service.js';
import { construirPayloadGuia } from './guias.service.js';

const conBd = await hayBaseDatos();
const app = crearApp();
const CLAVE = 'Clave1234';
const RUC_EMPRESA = '20161515648';
/** Completa un RUC válido a partir de sus 10 primeros dígitos. */
const ruc = (base: string) => [...'0123456789'].map((d) => base + d).find(rucValido)!;
const RUC_CLIENTE = ruc('2051234567');

describe.skipIf(!conBd)('guía de remisión remitente (integración con API-PRO simulada)', () => {
  const api = new ApiProFalsa(env.APIPRO_KEY || 'clave-de-pruebas-de-al-menos-20');
  const ids: Record<string, number> = {};
  let s: { agente: ReturnType<typeof request.agent>; csrf: string };
  const enviar = (metodo: 'post' | 'put', ruta: string, cuerpo: object = {}, clave: string | null = randomUUID()) => {
    const r = s.agente[metodo](ruta).set('X-CSRF-Token', s.csrf);
    if (clave) r.set('Idempotency-Key', clave);
    return r.send(cuerpo);
  };
  const post = (ruta: string, cuerpo: object = {}, clave?: string | null) => enviar('post', ruta, cuerpo, clave);
  async function correrWorker(rondas = 10) {
    for (let i = 0; i < rondas; i++) {
      await db('outbox_trabajos').where('estado', 'pendiente').update({ ejecutar_en: db.raw('CURRENT_TIMESTAMP(3) - INTERVAL 1 SECOND') });
      if ((await procesarLote()) === 0) break;
    }
  }
  const llamadasGuia = () => api.llamadas.filter((l) => l.ruta.startsWith('/guias-remision'));

  /** Guía por transporte privado, completa y válida. */
  const guiaPrivada = (extra: Record<string, unknown> = {}) => ({
    origen: { tipo: 'manual' },
    destinatario: { tipoDoc: '6', numDoc: RUC_CLIENTE, razonSocial: 'DISTRIBUIDORA NORTE SAC' },
    codTraslado: '01',
    modTraslado: '02',
    fechaTraslado: fechaLima(),
    pesoTotal: '25.5',
    numBultos: 3,
    partida: { ubigeo: '150128', direccion: 'AV ITALIA 123, RIMAC' },
    llegada: { ubigeo: '150101', direccion: 'AV LIMA 456, CERCADO' },
    vehiculoId: ids.vehiculo,
    conductoresIds: [ids.conductor],
    items: [{ productoId: ids.martillo, codigo: 'MART', descripcion: 'Martillo', unidad: 'NIU', cantidad: '3' }],
    ...extra,
  });

  beforeAll(async () => {
    await prepararBdPrueba();
    api.instalar();
    registrarManejadoresEmision();
    ids.sucursal = Number((await db('sucursales').insert({ nombre: 'Centro', cod_local: '0002', api_sucursal_id: 1000, direccion: 'AV ITALIA 123, RIMAC', ubigeo: '150128' }))[0]);
    ids.norte = Number((await db('sucursales').insert({ nombre: 'Norte', cod_local: '0003', api_sucursal_id: 1001, direccion: 'AV MANSICHE 500, TRUJILLO', ubigeo: '130101' }))[0]);
    await db('empresa').insert({ ruc: RUC_EMPRESA, razon_social: 'COMPANY CMA SAC', tasa_igv: '18.00', modo_emision: 'real' });
    ids.b101 = Number((await db('series').insert({ api_serie_id: 1, tipo_doc: '03', serie: 'B101', propia: true, sucursal_id: ids.sucursal }))[0]);
    ids.t101 = Number((await db('series').insert({ api_serie_id: 2, tipo_doc: '09', serie: 'T101', propia: true, sucursal_id: ids.sucursal, predeterminada: true }))[0]);
    const unidad = (await db('unidades').where('codigo_sunat', 'NIU').first('id')).id;
    ids.martillo = Number((await db('productos').insert({ codigo: 'MART', nombre: 'Martillo', unidad_id: unidad, precio_venta: '29.90' }))[0]);
    ids.instalacion = Number((await db('productos').insert({ codigo: 'INST', nombre: 'Instalación', unidad_id: unidad, precio_venta: '50.00', tipo: 'servicio', inventariable: false }))[0]);
    await db('stock').insert({ producto_id: ids.martillo, sucursal_id: ids.sucursal, cantidad: '100' });
    ids.cliente = Number((await db('clientes').insert({ tipo_doc: '1', num_doc: '12345678', razon_social: 'Juan Pérez', direccion: 'JR COMERCIO 456' }))[0]);
    ids.efectivo = Number((await db('metodos_pago').where('codigo', 'EFECTIVO').first('id')).id);
    const rol = (await db('roles').where('codigo', 'admin').first('id')).id;
    await db('usuarios').insert({ usuario: 'admin', nombre: 'Admin', password_hash: await hashClave(CLAVE), rol_id: rol, debe_cambiar_password: false });
    const agente = request.agent(app);
    const login = await agente.post('/api/auth/login').send({ usuario: 'admin', password: CLAVE });
    s = { agente, csrf: login.body.csrfToken };
    ids.caja = Number((await db('cajas').insert({ sucursal_id: ids.sucursal, nombre: 'Caja 1' }))[0]);
    await post('/api/turnos/abrir', { cajaId: ids.caja, saldosIniciales: [{ moneda: 'PEN', monto: '100' }] });

    const v = await post('/api/vehiculos', { placa: 'abc-123', descripcion: 'Furgón' });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    ids.vehiculo = v.body.id;
    ids.conductor = (await post('/api/conductores', { tipoDoc: '1', numDoc: '44004400', nombres: 'Roberto', apellidos: 'Rodríguez Valencia', licencia: 'q44004400' })).body.id;
  }, 60_000);

  beforeEach(() => {
    api.resultadoGuia = 'aceptado';
    api.fallos = [];
  });

  afterAll(async () => {
    api.desinstalar();
    await db.destroy();
  });

  it('datos maestros: normaliza placa y licencia, y rechaza duplicados y RUC inválidos', async () => {
    const lista = await s.agente.get('/api/vehiculos');
    expect(lista.body).toEqual([expect.objectContaining({ placa: 'ABC123', descripcion: 'Furgón' })]);
    expect((await post('/api/vehiculos', { placa: 'ABC 123' })).status).toBe(409);
    expect((await post('/api/vehiculos', { placa: 'AB1' })).status).toBe(422);
    expect((await s.agente.get('/api/conductores')).body[0]).toMatchObject({ licencia: 'Q44004400' });
    expect((await post('/api/transportistas', { ruc: '20123456789', razonSocial: 'TRANSPORTES SAC' })).status).toBe(422);
    const t = await post('/api/transportistas', { ruc: ruc('2098765432'), razonSocial: 'TRANSPORTES SAC', nroMtc: '0001' });
    expect(t.status).toBe(201);
    ids.transportista = t.body.id;
  });

  it('ubigeos: consulta a API-PRO una sola vez y luego usa la caché', async () => {
    const r1 = await s.agente.get('/api/ubigeos/distritos?provincia=1501');
    expect(r1.body).toEqual([{ codigo: '150101', nombre: 'LIMA' }, { codigo: '150128', nombre: 'RIMAC' }]);
    await s.agente.get('/api/ubigeos/regiones');
    await s.agente.get('/api/ubigeos/provincias?region=15');
    const antes = api.llamadas.length;
    await s.agente.get('/api/ubigeos/distritos?provincia=1501');
    expect(api.llamadas.length).toBe(antes);
  });

  it('desde una venta: copia destinatario y bienes (no servicios), se emite y se acepta sin mover stock', async () => {
    const venta = await post('/api/ventas', {
      cajaId: ids.caja,
      tipoComprobante: '03',
      serieId: ids.b101,
      moneda: 'PEN',
      cliente: { id: ids.cliente },
      items: [{ productoId: ids.martillo, cantidad: '3' }, { productoId: ids.instalacion, cantidad: '1' }],
      formaPago: 'contado',
      pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '139.70' }],
    });
    expect(venta.status, JSON.stringify(venta.body)).toBe(201);
    await correrWorker();
    const comp = await db('comprobantes').where('venta_id', venta.body.venta.id).first();
    expect(comp.estado).toBe('aceptado');

    const b = await s.agente.get(`/api/guias/borrador?comprobanteId=${comp.id}`);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body).toMatchObject({
      codTraslado: '01',
      destinatario: { tipoDoc: '1', numDoc: '12345678', razonSocial: 'Juan Pérez' },
      partida: { ubigeo: '150128', direccion: 'AV ITALIA 123, RIMAC' },
      llegada: { ubigeo: '', direccion: 'JR COMERCIO 456' },
      items: [{ productoId: ids.martillo, descripcion: 'Martillo', unidad: 'NIU', cantidad: '3.000' }],
    });
    const stockAntes = (await db('stock').where({ producto_id: ids.martillo, sucursal_id: ids.sucursal }).first('cantidad')).cantidad;

    const r = await post('/api/guias', guiaPrivada({ origen: { tipo: 'venta', comprobanteId: comp.id }, destinatario: b.body.destinatario, llegada: { ubigeo: '150101', direccion: 'JR COMERCIO 456' }, items: b.body.items }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ serie: 'T101', estado: 'pendiente', origen: { tipo: 'venta', comprobante: comp.numero_completo } });

    await correrWorker();
    const g = await s.agente.get(`/api/guias/${r.body.id}`);
    expect(g.body).toMatchObject({ estado: 'aceptado', numeroCompleto: 'T101-1', sunatCodigo: '0', acciones: expect.arrayContaining(['pdf', 'xml', 'cdr']) });
    expect(g.body.partida.lugar).toBe('LIMA / LIMA / RIMAC');

    const [envio] = llamadasGuia().filter((l) => l.metodo === 'POST');
    expect(envio!.cuerpo).toMatchObject({
      serie: 'T101',
      cod_traslado: '01',
      mod_traslado: '02',
      peso_total: 25.5,
      und_peso_total: 'KGM',
      num_bultos: 3,
      destinatario: { tipo_doc: '1', num_doc: '12345678' },
      vehiculo: { placa: 'ABC123' },
      conductores: [{ tipo: 'Principal', tipo_doc: '1', num_doc: '44004400', nombres: 'Roberto', apellidos: 'Rodríguez Valencia', licencia: 'Q44004400' }],
      doc_relacionado: [{ tipo_codigo: '03', numero: comp.numero_completo }],
      items: [{ codigo: 'MART', descripcion: 'Martillo', cantidad: 3, unidad: 'NIU' }],
    });
    expect(envio!.cuerpo).not.toHaveProperty('transportista');
    // El seguimiento nunca usa /estado (bug B1).
    expect(llamadasGuia().some((l) => l.ruta.endsWith('/estado'))).toBe(false);
    expect((await db('stock').where({ producto_id: ids.martillo, sucursal_id: ids.sucursal }).first('cantidad')).cantidad).toBe(stockAntes);

    // La segunda guía de la misma venta avisa que ya hay una.
    expect((await s.agente.get(`/api/guias/borrador?comprobanteId=${comp.id}`)).body.guiasPrevias).toEqual(['T101-1']);
  });

  it('reglas locales: transportista en transporte público, destinatario según motivo, fecha', async () => {
    const r1 = await post('/api/guias', guiaPrivada({ modTraslado: '01' }));
    expect(r1.status).toBe(422);
    expect(r1.body.campos).toMatchObject({ transportistaId: expect.any(String), fechaEntregaTransportista: expect.any(String) });

    const r2 = await post('/api/guias', guiaPrivada({ codTraslado: '04' }));
    expect(r2.status).toBe(422);
    expect(r2.body.campos['destinatario.numDoc']).toContain(RUC_EMPRESA);

    const propio = await post('/api/transportistas', { ruc: RUC_EMPRESA, razonSocial: 'COMPANY CMA SAC' });
    const r3 = await post('/api/guias', guiaPrivada({ modTraslado: '01', transportistaId: propio.body.id, fechaEntregaTransportista: fechaLima() }));
    expect(r3.status).toBe(422);
    expect(r3.body.campos.transportistaId).toMatch(/transporte privado/);

    const r4 = await post('/api/guias', guiaPrivada({ fechaTraslado: '2020-01-01' }));
    expect(r4.status).toBe(422);
    expect(r4.body.campos.fechaTraslado).toBeTruthy();

    // M1L: sin vehículo ni conductor.
    const r5 = await post('/api/guias', guiaPrivada({ vehiculoM1l: true, vehiculoId: undefined, conductoresIds: [] }));
    expect(r5.status, JSON.stringify(r5.body)).toBe(201);
    await correrWorker();
    const envio = llamadasGuia().filter((l) => l.metodo === 'POST').pop()!;
    expect(envio.cuerpo).toMatchObject({ indicadores: ['SUNAT_Envio_IndicadorTrasladoVehiculoM1L'] });
    expect(envio.cuerpo).not.toHaveProperty('vehiculo');
  });

  it('transporte público: envía transportista y fecha de entrega', async () => {
    const r = await post('/api/guias', guiaPrivada({ modTraslado: '01', transportistaId: ids.transportista, fechaEntregaTransportista: fechaLima(), vehiculoId: undefined, conductoresIds: [] }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await correrWorker();
    const envio = llamadasGuia().filter((l) => l.metodo === 'POST').pop()!;
    expect(envio.cuerpo).toMatchObject({ mod_traslado: '01', transportista: { tipo_doc: '6', razon_social: 'TRANSPORTES SAC', nro_mtc: '0001' }, fecha_entrega_transportista: fechaLima() });
    expect(envio.cuerpo).not.toHaveProperty('conductores');
    expect((await db('guias').where('id', r.body.id).first()).estado).toBe('aceptado');
  });

  it('respuesta perdida: se reintenta con la misma Idempotency-Key y no se duplica', async () => {
    api.fallos = ['red_tras_crear'];
    const antes = api.guias.length;
    const r = await post('/api/guias', guiaPrivada());
    await procesarLote();
    expect((await db('guias').where('id', r.body.id).first()).estado).toBe('por_verificar');
    await correrWorker();
    expect(api.guias.length).toBe(antes + 1);
    const claves = llamadasGuia().filter((l) => l.metodo === 'POST').slice(-2);
    expect(claves).toHaveLength(2);
    const g = await db('guias').where('id', r.body.id).first();
    expect(g.estado).toBe('aceptado');
    expect(api.guias.filter((x) => x.clave === g.idempotency_key)).toHaveLength(1);
  });

  it('error de datos (422): se corrige con una clave nueva y se emite', async () => {
    api.fallos = [422];
    const r = await post('/api/guias', guiaPrivada());
    await correrWorker();
    const g = await s.agente.get(`/api/guias/${r.body.id}`);
    expect(g.body).toMatchObject({ estado: 'error_validacion', acciones: ['corregir'] });
    const clave = (await db('guias').where('id', r.body.id).first()).idempotency_key;

    const c = await enviar('put', `/api/guias/${r.body.id}`, guiaPrivada({ llegada: { ubigeo: '150101', direccion: 'AV LIMA 999, CERCADO' } }), null);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    await correrWorker();
    const fila = await db('guias').where('id', r.body.id).first();
    expect(fila).toMatchObject({ estado: 'aceptado', llegada_direccion: 'AV LIMA 999, CERCADO' });
    expect(fila.idempotency_key).not.toBe(clave);
  });

  it('rechazada por SUNAT: se corrige con PUT a API-PRO y vuelve a seguirse', async () => {
    api.resultadoGuia = 'rechazado';
    const r = await post('/api/guias', guiaPrivada());
    await correrWorker();
    const g = await s.agente.get(`/api/guias/${r.body.id}`);
    expect(g.body).toMatchObject({ estado: 'rechazado', sunatCodigo: '2554', acciones: expect.arrayContaining(['reintentar', 'corregir']) });

    api.resultadoGuia = 'aceptado';
    const c = await enviar('put', `/api/guias/${r.body.id}`, guiaPrivada({ pesoTotal: '30' }), null);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.estado).toBe('en_proceso');
    const put = llamadasGuia().filter((l) => l.metodo === 'PUT').pop()!;
    expect(put.ruta).toBe(`/guias-remision/${(await db('guias').where('id', r.body.id).first()).api_id}`);
    expect(put.cuerpo).toMatchObject({ serie: 'T101', peso_total: 30, vehiculo: { placa: 'ABC123' } });
    await correrWorker();
    expect((await db('guias').where('id', r.body.id).first()).estado).toBe('aceptado');
  });

  it('archivos: PDF con ?format= y caché cuando está aceptada', async () => {
    const g = await db('guias').where('estado', 'aceptado').where('simulado', false).first('id', 'api_id');
    const pdf = await s.agente.get(`/api/guias/${g.id}/pdf?formato=a4`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(api.llamadas.some((l) => l.ruta === `/guias-remision/${g.api_id}/pdf?format=a4`)).toBe(true);
    const antes = api.llamadas.length;
    expect((await s.agente.get(`/api/guias/${g.id}/pdf?formato=a4`)).status).toBe(200);
    expect(api.llamadas.length).toBe(antes);
  });

  it('desde un traslado entre sucursales: motivo 04, destinatario propio y códigos de local', async () => {
    const t = await post('/api/inventario/traslados', { sucursalDestinoId: ids.norte, items: [{ productoId: ids.martillo, cantidad: '5' }] });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const trasladoId = t.body.id ?? t.body.traslado?.id;
    const b = await s.agente.get(`/api/guias/borrador?trasladoId=${trasladoId}`);
    expect(b.body).toMatchObject({
      codTraslado: '04',
      destinatario: { tipoDoc: '6', numDoc: RUC_EMPRESA },
      llegada: { ubigeo: '130101', direccion: 'AV MANSICHE 500, TRUJILLO' },
      items: [{ codigo: 'MART', unidad: 'NIU', cantidad: '5.000' }],
    });
    const r = await post('/api/guias', guiaPrivada({ origen: b.body.origen, codTraslado: '04', destinatario: b.body.destinatario, partida: b.body.partida, llegada: b.body.llegada, items: b.body.items }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await correrWorker();
    const envio = llamadasGuia().filter((l) => l.metodo === 'POST').pop()!;
    expect(envio.cuerpo).toMatchObject({ cod_traslado: '04', partida_ruc: RUC_EMPRESA, llegada_ruc: RUC_EMPRESA, partida_cod_local: '0002', llegada_cod_local: '0003' });
    expect((await db('traslados').where('id', trasladoId).first('guia_id')).guia_id).toBe(r.body.id);
  });

  it('modo simulación: numera localmente y no llama a API-PRO', async () => {
    await db('empresa').update({ modo_emision: 'simulacion' });
    const antes = llamadasGuia().length;
    const r = await post('/api/guias', guiaPrivada());
    await correrWorker();
    const g = await s.agente.get(`/api/guias/${r.body.id}`);
    expect(g.body).toMatchObject({ estado: 'aceptado', simulado: true, numeroCompleto: 'T101-1', acciones: [] });
    expect(llamadasGuia().length).toBe(antes);
    await db('empresa').update({ modo_emision: 'real' });
  });

  it('alerta de atascados: una guía sin avanzar más de 30 min aparece en el estado de integración', async () => {
    api.fallos = ['red'];
    const r = await post('/api/guias', guiaPrivada());
    await procesarLote();
    expect((await db('guias').where('id', r.body.id).first()).estado).toBe('por_verificar');
    expect((await s.agente.get('/api/estado-integracion')).body.atascados.items).toEqual([]);

    await db('guias').where('id', r.body.id).update({ updated_at: db.raw('CURRENT_TIMESTAMP(3) - INTERVAL 45 MINUTE') });
    const e = await s.agente.get('/api/estado-integracion');
    expect(e.body.atascados).toMatchObject({ minutos: 30, items: [expect.objectContaining({ tipo: 'guia', id: r.body.id, estado: 'por_verificar' })] });
    await correrWorker();
    expect((await s.agente.get('/api/estado-integracion')).body.atascados.items).toEqual([]);
  });

  it('la misma Idempotency-Key no crea dos guías', async () => {
    const clave = randomUUID();
    const a = await post('/api/guias', guiaPrivada(), clave);
    const b = await post('/api/guias', guiaPrivada(), clave);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
  });
});

describe('construirPayloadGuia', () => {
  it('no incluye montos ni datos de transporte que no correspondan a la modalidad', () => {
    const p = construirPayloadGuia(
      {
        serie: 'T101', fecha_emision: '2026-10-29', destinatario_tipo_doc: '6', destinatario_num_doc: '20000000002', destinatario_razon_social: 'X', cod_traslado: '01', mod_traslado: '01', vehiculo_m1l: false,
        fecha_traslado: '2026-10-29', fecha_entrega_transportista: '2026-10-29', peso_total: '12.500', und_peso_total: 'KGM', num_bultos: null, partida_ubigeo: '150128', partida_direccion: 'A', partida_cod_local: null,
        llegada_ubigeo: '150101', llegada_direccion: 'B', llegada_cod_local: null, transportista: { id: 1, ruc: '20000000002', razon_social: 'T', nro_mtc: null },
        vehiculo: { id: 1, placa: 'ABC123', nro_circulacion: null, secundarios: [] }, conductores: [], docs_relacionados: null, observacion: null,
      } as never,
      [{ producto_id: null, codigo: null, descripcion: 'Caja', unidad: 'NIU', cantidad: '2.000' }],
      RUC_EMPRESA,
    );
    expect(p).toMatchObject({ peso_total: 12.5, transportista: { tipo_doc: '6', num_doc: '20000000002', razon_social: 'T' }, items: [{ descripcion: 'Caja', cantidad: 2, unidad: 'NIU' }] });
    expect(p).not.toHaveProperty('vehiculo');
    expect(p).not.toHaveProperty('partida_ruc');
    expect(p).not.toHaveProperty('doc_relacionado');
  });
});
