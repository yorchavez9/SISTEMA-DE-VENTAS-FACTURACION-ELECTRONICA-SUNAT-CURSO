import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../../app.js';
import { db } from '../../database/db.js';
import { hashClave } from '../../shared/claves.js';
import { hayBaseDatos, prepararBdPrueba } from '../../test/bd.js';
import { consumirAutorizacion } from './auth.service.js';

const conBd = await hayBaseDatos();
if (!conBd) console.warn('⚠ MySQL no disponible: se omiten las pruebas de integración de auth');

const app = crearApp();
const CLAVE = 'Clave1234';

async function crearUsuario(usuario: string, rol: string, sucursalId: number, pin?: string): Promise<number> {
  const r = await db('roles').where('codigo', rol).first('id');
  const [id] = await db('usuarios').insert({
    usuario,
    nombre: usuario.toUpperCase(),
    password_hash: await hashClave(CLAVE),
    pin_hash: pin ? await hashClave(pin) : null,
    rol_id: r.id,
    debe_cambiar_password: false,
  });
  await db('usuario_sucursales').insert({ usuario_id: id, sucursal_id: sucursalId });
  return Number(id);
}

/** Inicia sesión y devuelve un agente con la cookie y el token CSRF. */
async function entrar(usuario: string, dispositivoToken?: string) {
  const agente = request.agent(app);
  const res = await agente.post('/api/auth/login').send({ usuario, password: CLAVE, dispositivoToken });
  expect(res.status).toBe(200);
  return { agente, csrf: res.body.csrfToken as string, sesion: res.body };
}

describe.skipIf(!conBd)('auth (integración)', () => {
  let sucursalId: number;
  let ids: Record<string, number>;

  beforeAll(async () => {
    await prepararBdPrueba();
    const [s] = await db('sucursales').insert({ nombre: 'Centro', cod_local: '0101' });
    sucursalId = Number(s);
    ids = {
      admin: await crearUsuario('admin', 'admin', sucursalId, '1111'),
      super: await crearUsuario('super', 'supervisor', sucursalId, '2222'),
      cajero: await crearUsuario('cajero', 'cajero', sucursalId, '3333'),
    };
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
  });

  it('rechaza credenciales incorrectas sin revelar si el usuario existe', async () => {
    const a = await request(app).post('/api/auth/login').send({ usuario: 'admin', password: 'mala' });
    const b = await request(app).post('/api/auth/login').send({ usuario: 'no-existe', password: 'mala' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.codigo).toBe(b.body.codigo);
    await db('usuarios').where('id', ids.admin).update({ intentos_fallidos: 0 });
  });

  it('inicia sesión con cookie httpOnly y devuelve permisos y sucursales', async () => {
    const res = await request(app).post('/api/auth/login').send({ usuario: 'ADMIN', password: CLAVE });
    expect(res.status).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/sv_sid=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(res.body.permisos).toContain('usuarios.editar');
    expect(res.body.sucursalActiva).toMatchObject({ codLocal: '0101' });
  });

  it('sin sesión las rutas protegidas responden 401', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/usuarios')).status).toBe(401);
  });

  it('exige el token CSRF en las escrituras', async () => {
    const { agente, csrf } = await entrar('admin');
    const sin = await agente.post('/api/usuarios/1/restablecer-pin');
    expect(sin.status).toBe(403);
    expect(sin.body.codigo).toBe('CSRF_INVALIDO');
    const con = await agente.post(`/api/usuarios/${ids.cajero}/restablecer-pin`).set('X-CSRF-Token', csrf);
    expect(con.status).toBe(204);
    await db('usuarios').where('id', ids.cajero).update({ pin_hash: await hashClave('3333') });
  });

  it('aplica permisos por rol', async () => {
    const { agente } = await entrar('cajero');
    const res = await agente.get('/api/usuarios');
    expect(res.status).toBe(403);
    expect(res.body.codigo).toBe('SIN_PERMISO');
  });

  it('bloquea el usuario tras 5 intentos fallidos', async () => {
    await crearUsuario('victima', 'cajero', sucursalId);
    const codigos: number[] = [];
    for (let i = 0; i < 5; i++) {
      codigos.push((await request(app).post('/api/auth/login').send({ usuario: 'victima', password: 'mala' })).status);
    }
    expect(codigos.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(codigos[4]).toBe(423);
    // Incluso con la contraseña correcta sigue bloqueado.
    expect((await request(app).post('/api/auth/login').send({ usuario: 'victima', password: CLAVE })).status).toBe(423);
  });

  it('crea usuarios con contraseña temporal que obliga a cambiarla', async () => {
    const { agente, csrf } = await entrar('admin');
    const res = await agente
      .post('/api/usuarios')
      .set('X-CSRF-Token', csrf)
      .send({ usuario: 'nuevo', nombre: 'Nuevo Cajero', rol: 'cajero', sucursalIds: [sucursalId] });
    expect(res.status).toBe(201);
    const login = await request(app).post('/api/auth/login').send({ usuario: 'nuevo', password: res.body.passwordTemporal });
    expect(login.status).toBe(200);
    expect(login.body.debeCambiarPassword).toBe(true);
  });

  it('no permite dejar el sistema sin administradores', async () => {
    const { agente, csrf } = await entrar('super');
    expect((await agente.get('/api/usuarios')).status).toBe(403); // el supervisor no administra usuarios
    const admin = await entrar('admin');
    const res = await admin.agente
      .put(`/api/usuarios/${ids.admin}`)
      .set('X-CSRF-Token', admin.csrf)
      .send({ nombre: 'ADMIN', rol: 'cajero', activo: true, sucursalIds: [sucursalId] });
    expect(res.status).toBe(409);
    void csrf;
  });

  describe('PIN en dispositivo de caja', () => {
    let dispositivoToken: string;

    beforeAll(async () => {
      const { agente, csrf } = await entrar('admin');
      const res = await agente.post('/api/dispositivos').set('X-CSRF-Token', csrf).send({ nombre: 'Caja 1', sucursalId });
      expect(res.status).toBe(201);
      dispositivoToken = res.body.dispositivoToken;
    });

    it('el PIN no funciona fuera de un dispositivo registrado', async () => {
      const { agente, csrf } = await entrar('super');
      const res = await agente.post('/api/auth/pin/cambiar-operador').set('X-CSRF-Token', csrf).send({ usuarioId: ids.cajero, pin: '3333' });
      expect(res.status).toBe(403);
      expect(res.body.codigo).toBe('DISPOSITIVO_NO_REGISTRADO');
    });

    it('cambiar de operador aplica los permisos del cajero, no los del supervisor', async () => {
      const { agente, csrf, sesion } = await entrar('super', dispositivoToken);
      expect(sesion.dispositivo).toMatchObject({ nombre: 'Caja 1' });
      expect(sesion.permisos).toContain('ventas.descuento');

      const res = await agente.post('/api/auth/pin/cambiar-operador').set('X-CSRF-Token', csrf).send({ usuarioId: ids.cajero, pin: '3333' });
      expect(res.status).toBe(200);
      expect(res.body.operador.usuario).toBe('cajero');
      expect(res.body.usuario.usuario).toBe('super');
      expect(res.body.permisos).not.toContain('ventas.descuento');
    });

    it('un PIN incorrecto informa los intentos restantes y bloquea al tercero', async () => {
      const { agente, csrf } = await entrar('cajero', dispositivoToken);
      const r1 = await agente.post('/api/auth/pin/cambiar-operador').set('X-CSRF-Token', csrf).send({ usuarioId: ids.super, pin: '0000' });
      expect(r1.status).toBe(401);
      expect(r1.body.detalle.intentosRestantes).toBe(2);
      await agente.post('/api/auth/pin/cambiar-operador').set('X-CSRF-Token', csrf).send({ usuarioId: ids.super, pin: '0000' });
      const r3 = await agente.post('/api/auth/pin/cambiar-operador').set('X-CSRF-Token', csrf).send({ usuarioId: ids.super, pin: '0000' });
      expect(r3.status).toBe(423);
      await db('usuarios').where('id', ids.super).update({ pin_intentos: 0, pin_bloqueado_hasta: null });
    });

    it('autorización de supervisor: un solo uso y solo con el permiso adecuado', async () => {
      const { agente, csrf } = await entrar('cajero', dispositivoToken);

      // Un cajero no puede autorizar descuentos.
      const negada = await agente.post('/api/auth/pin/autorizar').set('X-CSRF-Token', csrf).send({ usuarioId: ids.cajero, pin: '3333', accion: 'descuento' });
      expect(negada.status).toBe(403);

      const ok = await agente.post('/api/auth/pin/autorizar').set('X-CSRF-Token', csrf).send({ usuarioId: ids.super, pin: '2222', accion: 'descuento' });
      expect(ok.status).toBe(201);
      const token = ok.body.autorizacionToken as string;

      await expect(consumirAutorizacion(token, 'anular', ids.cajero)).rejects.toThrow(); // otra acción
      expect(await consumirAutorizacion(token, 'descuento', ids.cajero)).toBe(ids.super);
      await expect(consumirAutorizacion(token, 'descuento', ids.cajero)).rejects.toThrow(); // ya usada
    });
  });

  it('logout invalida la sesión', async () => {
    const { agente, csrf } = await entrar('admin');
    expect((await agente.post('/api/auth/logout').set('X-CSRF-Token', csrf)).status).toBe(204);
    expect((await agente.get('/api/auth/me')).status).toBe(401);
  });
});
