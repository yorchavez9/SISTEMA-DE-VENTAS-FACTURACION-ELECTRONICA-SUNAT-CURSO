import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../../app.js';
import { env } from '../../config/env.js';
import { db } from '../../database/db.js';
import { hashClave } from '../../shared/claves.js';
import { fechaLima } from '../../shared/fechas.js';
import { ApiProFalsa } from '../../test/apiProFalsa.js';
import { hayBaseDatos, prepararBdPrueba } from '../../test/bd.js';

const conBd = await hayBaseDatos();
const app = crearApp();
const CLAVE = 'Clave1234';

describe.skipIf(!conBd)('empresa, sucursales, series y tipo de cambio (integración con API-PRO simulada)', () => {
  const api = new ApiProFalsa(env.APIPRO_KEY || 'clave-de-pruebas-de-al-menos-20');
  let admin: { agente: ReturnType<typeof request.agent>; csrf: string };
  let sucursalId: number;

  async function entrar(usuario: string) {
    const agente = request.agent(app);
    const res = await agente.post('/api/auth/login').send({ usuario, password: CLAVE });
    expect(res.status).toBe(200);
    return { agente, csrf: res.body.csrfToken as string };
  }
  const post = (ruta: string, cuerpo?: object) => admin.agente.post(ruta).set('X-CSRF-Token', admin.csrf).send(cuerpo);
  const escrituras = () => api.llamadas.filter((l) => l.metodo !== 'GET');

  beforeAll(async () => {
    await prepararBdPrueba();
    api.instalar();
    const rol = async (c: string) => (await db('roles').where('codigo', c).first('id')).id;
    await db('usuarios').insert([
      { usuario: 'admin', nombre: 'Admin', password_hash: await hashClave(CLAVE), rol_id: await rol('admin'), debe_cambiar_password: false },
      { usuario: 'cajero', nombre: 'Cajero', password_hash: await hashClave(CLAVE), rol_id: await rol('cajero'), debe_cambiar_password: false },
    ]);
    admin = await entrar('admin');
  }, 60_000);

  afterAll(async () => {
    api.desinstalar();
    await db.destroy();
  });

  it('probar la conexión registra la empresa y sincroniza las series como externas', async () => {
    const res = await post('/api/empresa/probar-conexion');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ruc: '20161515648', entorno: 'beta', tasaIgv: 18, rateLimitPorMinuto: 30 });
    expect(res.body.seriesSincronizadas).toBe(4); // R001 (retención) no se refleja
    expect(res.body.avisos.join()).toMatch(/beta/);

    const series = await admin.agente.get('/api/series');
    expect(series.body.every((s: { propia: boolean }) => !s.propia)).toBe(true);
    expect(series.body.find((s: { serie: string }) => s.serie === 'B099').activo).toBe(false);
    expect(escrituras()).toHaveLength(0); // solo lecturas

    // El historial de integración no guarda el usuario SOL.
    const intento = await db('integracion_intentos').where('operacion', 'empresa.leer').first('response_json');
    expect(JSON.stringify(intento.response_json)).not.toContain('USUARIOSOL');
  });

  it('crea una sucursal local y la vincula a una sucursal de API-PRO adoptando su código', async () => {
    const creada = await post('/api/sucursales', { nombre: 'Centro', codLocal: '0101', direccion: 'Av. Central 425', ubigeo: '150101' });
    expect(creada.status).toBe(201);
    sucursalId = creada.body.id;

    const vinculada = await post(`/api/sucursales/${sucursalId}/vincular`, { apiSucursalId: 14 });
    expect(vinculada.status).toBe(200);
    expect(vinculada.body).toMatchObject({ apiSucursalId: 14, codLocal: '0001' });

    const series = await admin.agente.get(`/api/series?sucursalId=${sucursalId}`);
    expect(series.body.map((s: { serie: string }) => s.serie).sort()).toEqual(['B001', 'B099', 'BC01', 'F001']);
  });

  it('importa desde API-PRO las sucursales que faltan (solo lectura) y les asigna sus series', async () => {
    api.sucursales[0] = { ...api.sucursales[0]!, direccion: 'Av. Italia 123', ubigeo: '150128' } as (typeof api.sucursales)[number];
    const antes = escrituras().length;
    const r = await post('/api/sucursales/importar', {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // La 14 ya estaba vinculada a "Centro"; solo se crea la 46 (código 0000).
    expect(r.body.creadas).toEqual([expect.objectContaining({ nombre: 'Sucursal Principal', codLocal: '0000', apiSucursalId: 46, direccion: 'Av. Italia 123', ubigeo: '150128' })]);
    expect(escrituras().length).toBe(antes);
    expect((await post('/api/sucursales/importar', {})).body.creadas).toEqual([]);
    expect((await admin.agente.get('/api/sucursales')).body).toHaveLength(2);
  });

  it('crear una serie: valida, exige escribir su nombre y la marca como propia', async () => {
    const op = { operacion: 'crear', tipoDoc: '03', serie: 'b101', sucursalId, correlativoInicial: 0 };
    const previa = await post('/api/series/validar', op);
    expect(previa.body).toMatchObject({ permitido: true, confirmacionRequerida: 'B101' });
    expect(escrituras()).toHaveLength(0); // validar no escribe en la API

    const mal = await post('/api/series/operaciones', { ...op, confirmacion: 'B10' });
    expect(mal.status).toBe(422);
    expect(escrituras()).toHaveLength(0);

    const ok = await post('/api/series/operaciones', { ...op, confirmacion: 'B101' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ serie: 'B101', propia: true, activo: true, ultimoCorrelativo: 0 });
    expect(escrituras()).toEqual([expect.objectContaining({ metodo: 'POST', ruta: '/series', cuerpo: { tipo: 'boleta', serie: 'B101', sucursal_id: 14, correlativo_inicial: 0 } })]);
  });

  it('nunca "crea" encima de una serie inactiva (API-PRO reiniciaría el correlativo)', async () => {
    const antes = escrituras().length;
    const res = await post('/api/series/operaciones', { operacion: 'crear', tipoDoc: '03', serie: 'B099', sucursalId, correlativoInicial: 0, confirmacion: 'B099' });
    expect(res.status).toBe(409);
    expect(res.body.codigo).toBe('SERIE_BLOQUEADA');
    expect(escrituras().length).toBe(antes);
    expect(api.series.find((s) => s.serie === 'B099')!.correlativo).toBe(30);
  });

  it('reactivar conserva la numeración', async () => {
    const serie = (await admin.agente.get('/api/series')).body.find((s: { serie: string }) => s.serie === 'B099');
    const res = await post('/api/series/operaciones', { operacion: 'activar', serieId: serie.id, activo: true, confirmacion: 'B099', confirmacionReforzada: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ activo: true, ultimoCorrelativo: 30 });
  });

  it('no permite bajar el correlativo y sí subirlo', async () => {
    const serie = (await admin.agente.get('/api/series')).body.find((s: { serie: string }) => s.serie === 'B101');
    api.series.find((s) => s.serie === 'B101')!.correlativo = 12; // otra emisión avanzó la serie en API-PRO

    const bajar = await post('/api/series/operaciones', { operacion: 'correlativo', serieId: serie.id, correlativo: 10, confirmacion: 'B101' });
    expect(bajar.status).toBe(409); // se evalúa contra el valor real recién sincronizado (12)

    const subir = await post('/api/series/operaciones', { operacion: 'correlativo', serieId: serie.id, correlativo: 50, confirmacion: 'B101' });
    expect(subir.status).toBe(200);
    expect(subir.body.ultimoCorrelativo).toBe(50);
  });

  it('una serie externa exige confirmación reforzada y no puede ser predeterminada', async () => {
    const f001 = (await admin.agente.get('/api/series')).body.find((s: { serie: string }) => s.serie === 'F001');
    const sinReforzar = await post('/api/series/operaciones', { operacion: 'correlativo', serieId: f001.id, correlativo: 800, confirmacion: 'F001' });
    expect(sinReforzar.status).toBe(422);
    const pred = await post('/api/series/operaciones', { operacion: 'predeterminada', serieId: f001.id, confirmacion: 'F001' });
    expect(pred.status).toBe(409);
    expect(api.series.find((s) => s.serie === 'F001')!.correlativo).toBe(719);
  });

  it('marca una serie propia como predeterminada sin llamar a la API', async () => {
    const b101 = (await admin.agente.get('/api/series')).body.find((s: { serie: string }) => s.serie === 'B101');
    const antes = api.llamadas.length;
    const res = await post('/api/series/operaciones', { operacion: 'predeterminada', serieId: b101.id, confirmacion: 'B101' });
    expect(res.status).toBe(200);
    expect(res.body.predeterminada).toBe(true);
    expect(api.llamadas.length).toBe(antes);
  });

  it('las credenciales se prueban antes de guardarse y quedan cifradas', async () => {
    const base = { baseUrl: 'https://sunat.kodevo.es/api/v1', apiKey: 'clave-nueva-de-mas-de-20-caracteres', apiSecret: 'secreto-nuevo-de-mas-de-20-caracteres' };
    expect((await admin.agente.put('/api/empresa/credenciales-api').set('X-CSRF-Token', admin.csrf).send({ ...base, password: 'mala' })).status).toBe(422);
    expect((await admin.agente.put('/api/empresa/credenciales-api').set('X-CSRF-Token', admin.csrf).send({ ...base, password: CLAVE })).status).toBe(502); // API-PRO las rechaza

    api.claves.set(base.apiKey, '20999999990'); // credenciales de otro RUC
    const otroRuc = await admin.agente.put('/api/empresa/credenciales-api').set('X-CSRF-Token', admin.csrf).send({ ...base, password: CLAVE });
    expect(otroRuc.status).toBe(409);
    expect(otroRuc.body.codigo).toBe('EMPRESA_DISTINTA');

    api.claves.set(base.apiKey, api.ruc);
    const ok = await admin.agente.put('/api/empresa/credenciales-api').set('X-CSRF-Token', admin.csrf).send({ ...base, password: CLAVE });
    expect(ok.status).toBe(200);
    expect(ok.body.api).toMatchObject({ origen: 'base_datos', apiKey: '••••eres' });

    const fila = await db('empresa').first('apipro_key_enc', 'apipro_secret_enc');
    expect(Buffer.from(fila.apipro_secret_enc).toString('utf8')).not.toContain('secreto-nuevo');
    const auditoria = await db('auditoria').where('accion', 'empresa.credenciales_api').first('despues');
    expect(JSON.stringify(auditoria.despues)).not.toContain('secreto-nuevo');
  });

  it('tipo de cambio: registra el de hoy, rechaza fechas futuras y respeta permisos', async () => {
    const hoy = fechaLima();
    const ok = await admin.agente.put(`/api/tipos-cambio/${hoy}`).set('X-CSRF-Token', admin.csrf).send({ compra: '3.7410', venta: '3.7520' });
    expect(ok.status).toBe(200);
    expect((await admin.agente.get('/api/tipos-cambio/hoy')).body).toMatchObject({ fecha: hoy, venta: '3.7520' });

    expect((await admin.agente.put('/api/tipos-cambio/2999-01-01').set('X-CSRF-Token', admin.csrf).send({ compra: '3.7', venta: '3.8' })).status).toBe(422);
    expect((await admin.agente.put(`/api/tipos-cambio/${hoy}`).set('X-CSRF-Token', admin.csrf).send({ compra: '3.9', venta: '3.8' })).status).toBe(422);

    const cajero = await entrar('cajero');
    expect((await cajero.agente.put(`/api/tipos-cambio/${hoy}`).set('X-CSRF-Token', cajero.csrf).send({ compra: '3.7', venta: '3.8' })).status).toBe(403);
    expect((await cajero.agente.get('/api/tipos-cambio/hoy')).status).toBe(200);
  });

  it('ajustes tipados: valida y audita', async () => {
    const mal = await admin.agente.put('/api/configuracion').set('X-CSRF-Token', admin.csrf).send({ 'sesion.inactividad_min': 2 });
    expect(mal.status).toBe(422);
    const ok = await admin.agente.put('/api/configuracion').set('X-CSRF-Token', admin.csrf).send({ 'sesion.inactividad_min': 45 });
    expect(ok.status).toBe(204);
    expect((await admin.agente.get('/api/configuracion')).body['sesion.inactividad_min']).toBe(45);
  });
});
