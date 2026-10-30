import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../../app.js';
import { db } from '../../database/db.js';
import { hashClave } from '../../shared/claves.js';
import { hayBaseDatos, prepararBdPrueba } from '../../test/bd.js';
import { registrarMovimiento } from './caja.service.js';

const conBd = await hayBaseDatos();
const app = crearApp();
const CLAVE = 'Clave1234';

describe.skipIf(!conBd)('caja y turnos (integración)', () => {
  let sucursalId: number;
  let cajaId: number;
  let efectivo: number;
  let yape: number;
  let cajeroId: number;
  const s: Record<string, { agente: ReturnType<typeof request.agent>; csrf: string }> = {};
  const post = (u: string, ruta: string, cuerpo: object, clave: string | null = randomUUID()) => {
    const r = s[u]!.agente.post(ruta).set('X-CSRF-Token', s[u]!.csrf);
    if (clave) r.set('Idempotency-Key', clave);
    return r.send(cuerpo);
  };

  beforeAll(async () => {
    await prepararBdPrueba();
    sucursalId = Number((await db('sucursales').insert({ nombre: 'Centro', cod_local: '0101' }))[0]);
    const otra = Number((await db('sucursales').insert({ nombre: 'Norte', cod_local: '0102' }))[0]);
    efectivo = Number((await db('metodos_pago').where('codigo', 'EFECTIVO').first('id')).id);
    yape = Number((await db('metodos_pago').where('codigo', 'YAPE').first('id')).id);
    for (const [usuario, rol, suc] of [['admin', 'admin', sucursalId], ['cajero', 'cajero', sucursalId], ['norte', 'cajero', otra]] as const) {
      const r = (await db('roles').where('codigo', rol).first('id')).id;
      const [id] = await db('usuarios').insert({ usuario, nombre: usuario, password_hash: await hashClave(CLAVE), rol_id: r, debe_cambiar_password: false });
      if (usuario === 'cajero') cajeroId = Number(id);
      await db('usuario_sucursales').insert({ usuario_id: id, sucursal_id: suc });
      const agente = request.agent(app);
      const login = await agente.post('/api/auth/login').send({ usuario, password: CLAVE });
      s[usuario] = { agente, csrf: login.body.csrfToken };
    }
    const caja = await post('admin', '/api/cajas', { nombre: 'Caja 1' }, null);
    expect(caja.status).toBe(201);
    cajaId = caja.body.id;
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
  });

  let turnoId: number;

  it('abre un turno con saldos iniciales por moneda; solo uno abierto por caja', async () => {
    const r = await post('cajero', '/api/turnos/abrir', { cajaId, saldosIniciales: [{ moneda: 'PEN', monto: '200' }, { moneda: 'USD', monto: '20' }] });
    expect(r.status).toBe(201);
    turnoId = r.body.turno.id;
    expect(r.body.efectivo).toEqual([
      expect.objectContaining({ moneda: 'PEN', inicial: '200.00', esperado: '200.00' }),
      expect.objectContaining({ moneda: 'USD', inicial: '20.00', esperado: '20.00' }),
    ]);
    const otro = await post('cajero', '/api/turnos/abrir', { cajaId, saldosIniciales: [] });
    expect(otro.status).toBe(409);
    expect(otro.body.codigo).toBe('TURNO_YA_ABIERTO');
    expect((await s.cajero!.agente.get('/api/cajas')).body[0].turnoAbierto.id).toBe(turnoId);
  });

  it('abrir con la misma clave devuelve el mismo turno', async () => {
    const caja2 = await post('admin', '/api/cajas', { nombre: 'Caja 2' }, null);
    const clave = randomUUID();
    const a = await post('cajero', '/api/turnos/abrir', { cajaId: caja2.body.id }, clave);
    const b = await post('cajero', '/api/turnos/abrir', { cajaId: caja2.body.id }, clave);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.turno.id).toBe(a.body.turno.id);
  });

  it('ingresos y egresos: el egreso de efectivo no puede superar lo disponible', async () => {
    expect((await post('cajero', `/api/turnos/${turnoId}/movimientos`, { tipo: 'ingreso', metodoPagoId: efectivo, moneda: 'PEN', monto: '50', concepto: 'Sencillo' })).status).toBe(201);
    const excesivo = await post('cajero', `/api/turnos/${turnoId}/movimientos`, { tipo: 'egreso', metodoPagoId: efectivo, moneda: 'PEN', monto: '300', concepto: 'Pago a proveedor' });
    expect(excesivo.status).toBe(409);
    expect(excesivo.body.codigo).toBe('EFECTIVO_INSUFICIENTE');
    const ok = await post('cajero', `/api/turnos/${turnoId}/movimientos`, { tipo: 'egreso', metodoPagoId: efectivo, moneda: 'PEN', monto: '30.50', concepto: 'Movilidad' });
    expect(ok.body.efectivo[0]).toMatchObject({ entradas: '50.00', salidas: '30.50', esperado: '219.50' });
  });

  it('el mismo movimiento manual reenviado no se duplica', async () => {
    const clave = randomUUID();
    await post('cajero', `/api/turnos/${turnoId}/movimientos`, { tipo: 'ingreso', metodoPagoId: yape, moneda: 'PEN', monto: '15', concepto: 'Ingreso Yape' }, clave);
    const r = await post('cajero', `/api/turnos/${turnoId}/movimientos`, { tipo: 'ingreso', metodoPagoId: yape, moneda: 'PEN', monto: '15', concepto: 'Ingreso Yape' }, clave);
    expect(r.status).toBe(200);
    expect(r.body.movimientos.filter((m: { concepto: string }) => m.concepto === 'Ingreso Yape')).toHaveLength(1);
    // Yape no cuenta como efectivo.
    expect(r.body.efectivo[0].esperado).toBe('219.50');
    expect(r.body.porMetodo).toContainEqual(expect.objectContaining({ metodo: 'Yape', moneda: 'PEN', total: '15.00' }));
  });

  it('un documento de origen no registra dos veces el mismo pago', async () => {
    const mov = () => db.transaction((trx) => registrarMovimiento(trx, { turnoId, tipo: 'venta', metodoPagoId: efectivo, moneda: 'PEN', monto: '10', concepto: 'Venta 1', origenTipo: 'venta', origenId: 1, usuarioId: cajeroId }));
    await mov();
    await expect(mov()).rejects.toMatchObject({ codigo: 'MOVIMIENTO_DUPLICADO' });
  });

  it('otra sucursal no ve ni opera el turno', async () => {
    expect((await s.norte!.agente.get(`/api/turnos/${turnoId}`)).status).toBe(403);
    expect((await post('norte', `/api/turnos/${turnoId}/movimientos`, { tipo: 'ingreso', metodoPagoId: efectivo, moneda: 'PEN', monto: '1', concepto: 'Intento' })).status).toBe(403);
  });

  it('cierre: exige el contado de cada moneda con efectivo, calcula diferencias y bloquea nuevos movimientos', async () => {
    const sinUsd = await post('cajero', `/api/turnos/${turnoId}/cerrar`, { contado: [{ moneda: 'PEN', monto: '229.50' }] }, null);
    expect(sinUsd.status).toBe(422);

    const r = await post('cajero', `/api/turnos/${turnoId}/cerrar`, { contado: [{ moneda: 'PEN', monto: '225.00' }, { moneda: 'USD', monto: '20' }], nota: 'Faltante por revisar' }, null);
    expect(r.status).toBe(200);
    expect(r.body.turno.estado).toBe('cerrado');
    // 200 + 50 − 30.50 + 10 (venta) = 229.50 esperado; contado 225 → −4.50
    expect(r.body.efectivo[0]).toMatchObject({ moneda: 'PEN', esperado: '229.50', contado: '225.00', diferencia: '-4.50' });
    expect(r.body.efectivo[1]).toMatchObject({ moneda: 'USD', esperado: '20.00', diferencia: '0.00' });

    const despues = await post('cajero', `/api/turnos/${turnoId}/movimientos`, { tipo: 'ingreso', metodoPagoId: efectivo, moneda: 'PEN', monto: '1', concepto: 'Tarde' });
    expect(despues.status).toBe(409);
    expect(despues.body.codigo).toBe('TURNO_NO_ABIERTO');
    // Con el turno cerrado se puede abrir uno nuevo.
    expect((await post('cajero', '/api/turnos/abrir', { cajaId })).status).toBe(201);
  });

  it('no se puede desactivar una caja con turno abierto', async () => {
    const r = await s.admin!.agente.put(`/api/cajas/${cajaId}`).set('X-CSRF-Token', s.admin!.csrf).send({ nombre: 'Caja 1', activo: false });
    expect(r.status).toBe(409);
  });
});
