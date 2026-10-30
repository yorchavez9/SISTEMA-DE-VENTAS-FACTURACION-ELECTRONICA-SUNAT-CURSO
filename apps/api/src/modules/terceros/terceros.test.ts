import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorNumeroDocumento } from '@sv/shared';
import { crearApp } from '../../app.js';
import { env } from '../../config/env.js';
import { db } from '../../database/db.js';
import { hashClave } from '../../shared/claves.js';
import { ApiProFalsa } from '../../test/apiProFalsa.js';
import { hayBaseDatos, prepararBdPrueba } from '../../test/bd.js';

/** Completa un RUC de 10 dígitos con su dígito verificador (módulo 11). */
function ruc(base10: string): string {
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const resto = 11 - (pesos.reduce((a, p, i) => a + p * Number(base10[i]), 0) % 11);
  return base10 + (resto === 10 ? 0 : resto === 11 ? 1 : resto);
}

describe('validación de documentos', () => {
  it.each([
    ['1', '12345678', null],
    ['1', '1234567', 'El DNI tiene 8 dígitos'],
    ['6', '20161515648', null],
    ['6', '20161515649', /RUC inválido/],
    ['6', '30161515648', /RUC inválido/],
    ['4', 'AB12345', null],
    ['7', '12', /Entre 6 y 12/],
  ])('%s %s', (tipo, numero, esperado) => {
    const r = errorNumeroDocumento(tipo, numero);
    if (esperado === null) expect(r).toBeNull();
    else if (esperado instanceof RegExp) expect(r).toMatch(esperado);
    else expect(r).toBe(esperado);
  });
});

const conBd = await hayBaseDatos();
const app = crearApp();
const CLAVE = 'Clave1234';

describe.skipIf(!conBd)('clientes y proveedores (integración con API-PRO simulada)', () => {
  const api = new ApiProFalsa(env.APIPRO_KEY || 'clave-de-pruebas-de-al-menos-20');
  const rucExterno = ruc('2051234567');
  const rucBaja = ruc('2060000000');
  const rucCaido = ruc('2070000000');
  const sesiones: Record<string, { agente: ReturnType<typeof request.agent>; csrf: string }> = {};

  const como = (u: string) => sesiones[u]!;
  const post = (u: string, ruta: string, cuerpo: object) => como(u).agente.post(ruta).set('X-CSRF-Token', como(u).csrf).send(cuerpo);

  beforeAll(async () => {
    await prepararBdPrueba();
    api.instalar();
    api.documentos.set(rucExterno, { razon_social: 'ACME SAC', direccion: 'AV. LOS OLIVOS 123', estado: 'ACTIVO', condicion: 'HABIDO' });
    api.documentos.set(rucBaja, { razon_social: 'CERRADA EIRL', estado: 'BAJA DE OFICIO', condicion: 'NO HABIDO' });
    api.documentos.set('44556677', { razon_social: 'PEREZ GOMEZ JUAN' });
    api.documentoQueFalla = rucCaido;
    const [s] = await db('sucursales').insert({ nombre: 'Centro', cod_local: '0101' });
    for (const [usuario, rol] of [['admin', 'admin'], ['cajero', 'cajero'], ['almacen', 'almacen']] as const) {
      const r = (await db('roles').where('codigo', rol).first('id')).id;
      const [id] = await db('usuarios').insert({ usuario, nombre: usuario, password_hash: await hashClave(CLAVE), rol_id: r, debe_cambiar_password: false });
      await db('usuario_sucursales').insert({ usuario_id: id, sucursal_id: s });
      const agente = request.agent(app);
      const login = await agente.post('/api/auth/login').send({ usuario, password: CLAVE });
      sesiones[usuario] = { agente, csrf: login.body.csrfToken };
    }
  }, 60_000);

  afterAll(async () => {
    api.desinstalar();
    await db.destroy();
  });

  it('crea clientes validando el documento y evita duplicados', async () => {
    const ok = await post('admin', '/api/clientes', { tipoDoc: '1', numDoc: '12345678', razonSocial: 'María López', email: '' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ tipoDoc: '1', numDoc: '12345678', email: null });

    const dniMalo = await post('admin', '/api/clientes', { tipoDoc: '1', numDoc: '1234567', razonSocial: 'X Y' });
    expect(dniMalo.status).toBe(422);
    expect(dniMalo.body.campos.numDoc).toBe('El DNI tiene 8 dígitos');

    const rucMalo = await post('admin', '/api/clientes', { tipoDoc: '6', numDoc: '20161515649', razonSocial: 'Empresa' });
    expect(rucMalo.status).toBe(422);

    const dup = await post('admin', '/api/clientes', { tipoDoc: '1', numDoc: '12345678', razonSocial: 'Otra persona' });
    expect(dup.status).toBe(409);
    expect(dup.body.codigo).toBe('DUPLICADO');
  });

  it('el límite de crédito exige moneda', async () => {
    const res = await post('admin', '/api/clientes', { tipoDoc: '1', numDoc: '87654321', razonSocial: 'Con crédito', limiteCredito: '1500' });
    expect(res.status).toBe(422);
    expect(res.body.campos.monedaCredito).toBeTruthy();
    const ok = await post('admin', '/api/clientes', { tipoDoc: '1', numDoc: '87654321', razonSocial: 'Con crédito', limiteCredito: '1500', monedaCredito: 'PEN' });
    expect(ok.body).toMatchObject({ limiteCredito: '1500.00', monedaCredito: 'PEN' });
  });

  it('buscar: primero local, sin llamar a API-PRO', async () => {
    const antes = api.llamadas.length;
    const res = await como('cajero').agente.get('/api/clientes/buscar?tipoDoc=1&numDoc=12345678');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ origen: 'local', razonSocial: 'María López' });
    expect(res.body.id).toBeGreaterThan(0);
    expect(api.llamadas.length).toBe(antes);
  });

  it('buscar: RUC no registrado se consulta en SUNAT a través de API-PRO, sin crearlo', async () => {
    const res = await como('cajero').agente.get(`/api/clientes/buscar?tipoDoc=6&numDoc=${rucExterno}`);
    expect(res.body).toMatchObject({ origen: 'externo', id: null, razonSocial: 'ACME SAC', direccion: 'AV. LOS OLIVOS 123', avisos: [] });
    expect(await db('clientes').where('num_doc', rucExterno).first()).toBeUndefined();
  });

  it('buscar: avisa si el RUC no está activo o no habido', async () => {
    const res = await como('admin').agente.get(`/api/clientes/buscar?tipoDoc=6&numDoc=${rucBaja}`);
    expect(res.body.avisos).toHaveLength(2);
    expect(res.body.avisos.join()).toMatch(/BAJA DE OFICIO/);
  });

  it('buscar: no encontrado y API caída no bloquean (permiten ingresar a mano)', async () => {
    const nada = await como('admin').agente.get(`/api/clientes/buscar?tipoDoc=6&numDoc=${ruc('2099999999')}`);
    expect(nada.body).toMatchObject({ origen: 'no_encontrado', avisos: [] });
    const caida = await como('admin').agente.get(`/api/clientes/buscar?tipoDoc=6&numDoc=${rucCaido}`);
    expect(caida.status).toBe(200);
    expect(caida.body.origen).toBe('no_encontrado');
    expect(caida.body.avisos.join()).toMatch(/manualmente/);
  });

  it('buscar: carnet de extranjería no se consulta afuera; documento inválido → 422', async () => {
    const antes = api.llamadas.length;
    expect((await como('admin').agente.get('/api/clientes/buscar?tipoDoc=4&numDoc=AB12345')).body.origen).toBe('no_encontrado');
    expect(api.llamadas.length).toBe(antes);
    expect((await como('admin').agente.get('/api/clientes/buscar?tipoDoc=1&numDoc=123')).status).toBe(422);
  });

  it('proveedores: CRUD con permisos por rol', async () => {
    const almacen = await post('almacen', '/api/proveedores', { tipoDoc: '6', numDoc: rucExterno, razonSocial: 'ACME SAC', contacto: 'Luis' });
    expect(almacen.status).toBe(201);
    expect((await post('cajero', '/api/proveedores', { tipoDoc: '6', numDoc: ruc('2011111111'), razonSocial: 'Otro' })).status).toBe(403);

    const edit = await como('almacen').agente.put(`/api/proveedores/${almacen.body.id}`).set('X-CSRF-Token', como('almacen').csrf).send({ tipoDoc: '6', numDoc: rucExterno, razonSocial: 'ACME S.A.C.', activo: false });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ razonSocial: 'ACME S.A.C.', activo: false });

    const activos = await como('almacen').agente.get('/api/proveedores');
    expect(activos.body.total).toBe(0);
    const todos = await como('almacen').agente.get('/api/proveedores?activo=todos&q=acme');
    expect(todos.body.total).toBe(1);
  });

  it('listado de clientes con búsqueda por nombre o inicio del documento', async () => {
    const porNombre = await como('admin').agente.get('/api/clientes?q=lópez');
    expect(porNombre.body.data.map((c: { numDoc: string }) => c.numDoc)).toEqual(['12345678']);
    const porDoc = await como('admin').agente.get('/api/clientes?q=8765');
    expect(porDoc.body.data[0].razonSocial).toBe('Con crédito');
  });
});
