import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../../app.js';
import { db } from '../../database/db.js';
import { hayBaseDatos, prepararBdPrueba } from '../../test/bd.js';

const conBd = await hayBaseDatos();
const app = crearApp();
const datos = { usuario: 'Jorge', nombre: 'Jorge Chavez', password: 'Segura2026', repetir: 'Segura2026' };

describe.skipIf(!conBd)('primera instalación (super administrador)', () => {
  beforeAll(async () => {
    await prepararBdPrueba();
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
  });

  it('sin usuarios: está pendiente y valida los datos', async () => {
    expect((await request(app).get('/api/auth/instalacion')).body).toEqual({ pendiente: true, requiereCodigo: false });
    const r = await request(app).post('/api/auth/instalacion').send({ ...datos, repetir: 'Otra2026x' });
    expect(r.status).toBe(422);
    expect(r.body.campos.repetir).toMatch(/no coinciden/);
  });

  it('dos solicitudes simultáneas: solo una crea el administrador', async () => {
    const [a, b] = await Promise.all([
      request(app).post('/api/auth/instalacion').send(datos),
      request(app).post('/api/auth/instalacion').send({ ...datos, usuario: 'intruso', nombre: 'Intruso' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const usuarios = await db('usuarios as u').join('roles as r', 'r.id', 'u.rol_id').select('u.usuario', 'r.codigo', 'u.debe_cambiar_password');
    expect(usuarios).toHaveLength(1);
    expect(usuarios[0]).toMatchObject({ codigo: 'admin', debe_cambiar_password: 0 });
  });

  it('queda con la sesión abierta y después la instalación se cierra', async () => {
    await db('sesiones').delete();
    await db('usuarios').delete();
    await db('auditoria').delete();
    const agente = request.agent(app);
    const r = await agente.post('/api/auth/instalacion').send(datos);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ usuario: { usuario: 'jorge', nombre: 'Jorge Chavez' }, csrfToken: expect.any(String) });
    expect((await agente.get('/api/auth/me')).status).toBe(200);

    expect((await request(app).get('/api/auth/instalacion')).body.pendiente).toBe(false);
    const otra = await request(app).post('/api/auth/instalacion').send({ ...datos, usuario: 'otro' });
    expect(otra.status).toBe(409);
    expect(otra.body.codigo).toBe('YA_INSTALADO');

    // El administrador entra con su contraseña normal (sin cambio obligatorio).
    const login = await request(app).post('/api/auth/login').send({ usuario: 'jorge', password: datos.password });
    expect(login.status).toBe(200);
    expect(await db('auditoria').where('accion', 'usuario.instalacion').count({ n: '*' })).toEqual([{ n: 1 }]);

    // Recién instalado no hay sucursales: el inicio y los reportes responden vacíos, sin error.
    const dash = await agente.get('/api/dashboard');
    expect(dash.status, JSON.stringify(dash.body)).toBe(200);
    expect(dash.body.ventas).toMatchObject({ totalPen: '0.00', n: 0 });
    for (const tipo of ['ventas', 'comprobantes', 'inventario', 'compras', 'caja', 'cxc']) {
      const r = await agente.get(`/api/reportes/${tipo}`);
      expect(r.status, `${tipo}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body.filas).toEqual([]);
    }
    expect((await agente.get('/api/reportes/ventas?agrupar=metodo')).status).toBe(200);
    expect((await agente.get('/api/estado-integracion')).status).toBe(200);
  });
});
