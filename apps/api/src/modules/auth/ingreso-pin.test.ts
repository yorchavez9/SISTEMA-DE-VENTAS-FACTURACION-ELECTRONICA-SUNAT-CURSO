import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../../app.js';
import { db } from '../../database/db.js';
import { hashClave } from '../../shared/claves.js';
import { hayBaseDatos, prepararBdPrueba } from '../../test/bd.js';

const conBd = await hayBaseDatos();
const app = crearApp();

describe.skipIf(!conBd)('ingreso con PIN (lista de usuarios, como ferretería)', () => {
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    await prepararBdPrueba();
    const rol = async (c: string) => (await db('roles').where('codigo', c).first('id')).id;
    const crear = async (usuario: string, nombre: string, r: string, pin: string | null, activo = true) =>
      Number((await db('usuarios').insert({ usuario, nombre, password_hash: await hashClave('Clave1234'), pin_hash: pin ? await hashClave(pin) : null, rol_id: await rol(r), activo, debe_cambiar_password: false }))[0]);
    ids.ana = await crear('ana', 'Ana Cajera', 'cajero', '1234');
    ids.beto = await crear('beto', 'Beto Admin', 'admin', '9876');
    ids.sinPin = await crear('carla', 'Carla Sin PIN', 'cajero', null);
    ids.inactivo = await crear('dario', 'Darío Inactivo', 'cajero', '1111', false);
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
  });

  it('lista solo usuarios activos con PIN, sin datos de acceso', async () => {
    const r = await request(app).get('/api/auth/ingreso/usuarios');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      { id: ids.ana, nombre: 'Ana Cajera', rol: 'cajero' },
      { id: ids.beto, nombre: 'Beto Admin', rol: 'admin' },
    ]);
    expect(JSON.stringify(r.body)).not.toContain('"usuario"');
  });

  it('PIN incorrecto se rechaza; el correcto abre la sesión', async () => {
    const mal = await request(app).post('/api/auth/ingreso/pin').send({ usuarioId: ids.ana, pin: '0000' });
    expect(mal.status).toBe(401);
    expect(mal.body.codigo).toBe('PIN_INVALIDO');

    const agente = request.agent(app);
    const ok = await agente.post('/api/auth/ingreso/pin').send({ usuarioId: ids.ana, pin: '1234' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ usuario: { nombre: 'Ana Cajera' }, csrfToken: expect.any(String) });
    expect((await agente.get('/api/auth/me')).status).toBe(200);
    // Un acierto reinicia el contador de fallos.
    expect((await db('usuarios').where('id', ids.ana).first('pin_intentos')).pin_intentos).toBe(0);
  });

  it('usuarios sin PIN o inactivos no entran por PIN', async () => {
    expect((await request(app).post('/api/auth/ingreso/pin').send({ usuarioId: ids.sinPin, pin: '1234' })).status).toBe(401);
    expect((await request(app).post('/api/auth/ingreso/pin').send({ usuarioId: ids.inactivo, pin: '1111' })).status).toBe(401);
  });

  it('tras varios fallos el PIN queda bloqueado un tiempo', async () => {
    let r;
    for (let i = 0; i < 6; i++) r = await request(app).post('/api/auth/ingreso/pin').send({ usuarioId: ids.beto, pin: '0000' });
    expect(r!.status).toBe(423);
    expect(r!.body.codigo).toBe('BLOQUEADO');
    // Bloqueado, ni siquiera el PIN correcto entra.
    expect((await request(app).post('/api/auth/ingreso/pin').send({ usuarioId: ids.beto, pin: '9876' })).status).toBe(423);
  });
});
