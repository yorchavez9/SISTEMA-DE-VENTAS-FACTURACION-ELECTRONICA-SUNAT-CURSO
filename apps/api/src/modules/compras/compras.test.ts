import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../../app.js';
import { db } from '../../database/db.js';
import { hashClave } from '../../shared/claves.js';
import { fechaLima } from '../../shared/fechas.js';
import { hayBaseDatos, prepararBdPrueba } from '../../test/bd.js';

const conBd = await hayBaseDatos();
const app = crearApp();
const CLAVE = 'Clave1234';

describe.skipIf(!conBd)('compras y traslados (integración)', () => {
  let centro: number;
  let norte: number;
  let proveedorId: number;
  let productoId: number;
  const s: Record<string, { agente: ReturnType<typeof request.agent>; csrf: string }> = {};

  const post = (u: string, ruta: string, cuerpo: object, clave: string | null = randomUUID()) => {
    const r = s[u]!.agente.post(ruta).set('X-CSRF-Token', s[u]!.csrf);
    if (clave) r.set('Idempotency-Key', clave);
    return r.send(cuerpo);
  };
  const stock = async (suc: number, p = productoId) => (await db('stock').where({ producto_id: p, sucursal_id: suc }).first('cantidad'))?.cantidad ?? '0.000';
  const compra = (extra: object = {}) => ({
    proveedorId,
    tipoDocCompra: '01',
    serieNumero: `F001-${Math.floor(Math.random() * 1e8)}`,
    fecha: fechaLima(),
    moneda: 'PEN',
    preciosIncluyenIgv: true,
    items: [{ productoId, cantidad: '10', costoUnitario: '11.80' }],
    ...extra,
  });

  beforeAll(async () => {
    await prepararBdPrueba();
    centro = Number((await db('sucursales').insert({ nombre: 'Centro', cod_local: '0101' }))[0]);
    norte = Number((await db('sucursales').insert({ nombre: 'Norte', cod_local: '0102' }))[0]);
    proveedorId = Number((await db('proveedores').insert({ tipo_doc: '6', num_doc: '20161515648', razon_social: 'Proveedor SAC' }))[0]);
    const unidad = (await db('unidades').where('codigo_sunat', 'NIU').first('id')).id;
    productoId = Number((await db('productos').insert({ codigo: 'P1', nombre: 'Taladro', unidad_id: unidad, precio_venta: '250' }))[0]);

    // almacen_c trabaja en Centro y almacen_n en Norte; el admin ve ambas.
    for (const [usuario, rol, sucursales] of [['admin', 'admin', []], ['almacen_c', 'almacen', [centro]], ['almacen_n', 'almacen', [norte]]] as const) {
      const r = (await db('roles').where('codigo', rol).first('id')).id;
      const [id] = await db('usuarios').insert({ usuario, nombre: usuario, password_hash: await hashClave(CLAVE), rol_id: r, debe_cambiar_password: false });
      for (const suc of sucursales) await db('usuario_sucursales').insert({ usuario_id: id, sucursal_id: suc });
      const agente = request.agent(app);
      const login = await agente.post('/api/auth/login').send({ usuario, password: CLAVE });
      s[usuario] = { agente, csrf: login.body.csrfToken };
    }
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
  });

  it('registra la compra, suma el stock y fija el costo promedio sin IGV', async () => {
    const res = await post('almacen_c', '/api/compras', compra());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ subtotal: '100.00', igv: '18.00', total: '118.00', estado: 'registrada', sucursal: { id: centro } });
    expect(await stock(centro)).toBe('10.000');
    expect((await db('productos').where('id', productoId).first('costo_promedio')).costo_promedio).toBe('10.000000');
  });

  it('el mismo envío (misma clave) no duplica la compra ni el stock', async () => {
    const clave = randomUUID();
    const cuerpo = compra();
    const r1 = await post('almacen_c', '/api/compras', cuerpo, clave);
    const r2 = await post('almacen_c', '/api/compras', cuerpo, clave);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(r2.headers['idempotent-replay']).toBe('true');
    expect(r2.body.id).toBe(r1.body.id);
    expect(await stock(centro)).toBe('20.000');
  });

  it('no permite registrar dos veces el mismo comprobante del proveedor', async () => {
    const cuerpo = compra({ serieNumero: 'F001-555' });
    expect((await post('almacen_c', '/api/compras', cuerpo)).status).toBe(201);
    const dup = await post('almacen_c', '/api/compras', cuerpo); // otra clave, mismo documento
    expect(dup.status).toBe(409);
    expect(dup.body.codigo).toBe('DUPLICADO');
    expect(await stock(centro)).toBe('30.000');
  });

  it('valida fecha futura, tipo de cambio en USD y clave de idempotencia', async () => {
    expect((await post('almacen_c', '/api/compras', compra({ fecha: '2999-01-01' }))).status).toBe(422);
    const usd = await post('almacen_c', '/api/compras', compra({ moneda: 'USD' }));
    expect(usd.status).toBe(422);
    expect(usd.body.campos.tipoCambio).toBeTruthy();
    expect((await post('almacen_c', '/api/compras', compra(), null)).status).toBe(400);
  });

  it('compra en USD: el costo promedio se pondera en soles', async () => {
    // 30 u a S/ 10 + 10 u a US$ 3 sin IGV × 4 = S/ 12 → (300 + 120) / 40 = 10.5
    const res = await post('almacen_c', '/api/compras', compra({ moneda: 'USD', tipoCambio: '4', preciosIncluyenIgv: false, items: [{ productoId, cantidad: '10', costoUnitario: '3' }] }));
    expect(res.status).toBe(201);
    expect((await db('productos').where('id', productoId).first('costo_promedio')).costo_promedio).toBe('10.500000');
  });

  it('anular una compra revierte su entrada; no se puede anular dos veces', async () => {
    const c = await post('almacen_c', '/api/compras', compra({ items: [{ productoId, cantidad: '5', costoUnitario: '11.80' }] }));
    const antes = await stock(centro);
    // El almacenero no tiene compras.anular.
    expect((await post('almacen_c', `/api/compras/${c.body.id}/anular`, { motivo: 'Error de digitación' })).status).toBe(403);
    const anul = await post('admin', `/api/compras/${c.body.id}/anular`, { motivo: 'Error de digitación' });
    expect(anul.status).toBe(200);
    expect(anul.body.estado).toBe('anulada');
    expect(Number(await stock(centro))).toBe(Number(antes) - 5);
    expect((await post('admin', `/api/compras/${c.body.id}/anular`, { motivo: 'Otra vez' })).status).toBe(409);
  });

  it('no se anula una compra cuya mercadería ya salió (stock insuficiente)', async () => {
    const otro = Number((await db('productos').insert({ codigo: 'P2', nombre: 'Broca', unidad_id: (await db('unidades').where('codigo_sunat', 'NIU').first('id')).id, precio_venta: '5' }))[0]);
    const c = await post('almacen_c', '/api/compras', compra({ items: [{ productoId: otro, cantidad: '4', costoUnitario: '2' }] }));
    await post('almacen_c', '/api/inventario/ajustes', { motivo: 'Salida por merma', items: [{ productoId: otro, cantidad: '-3' }] });
    const anul = await post('admin', `/api/compras/${c.body.id}/anular`, { motivo: 'Proveedor equivocado' });
    expect(anul.status).toBe(409);
    expect(anul.body.codigo).toBe('STOCK_INSUFICIENTE');
    expect(await stock(centro, otro)).toBe('1.000');
  });

  it('traslado: sale del origen al enviar y entra al destino al recibir', async () => {
    const enCentro = Number(await stock(centro));
    const t = await post('almacen_c', '/api/inventario/traslados', { sucursalDestinoId: norte, items: [{ productoId, cantidad: '4' }] });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect(Number(await stock(centro))).toBe(enCentro - 4);
    expect(await stock(norte)).toBe('0.000'); // en tránsito

    // Solo el destino recibe.
    expect((await post('almacen_c', `/api/inventario/traslados/${t.body.id}/recibir`, {}, null)).status).toBe(403);
    const rec = await post('almacen_n', `/api/inventario/traslados/${t.body.id}/recibir`, {}, null);
    expect(rec.status).toBe(200);
    expect(rec.body).toMatchObject({ estado: 'recibido', recibidoPor: 'almacen_n' });
    expect(await stock(norte)).toBe('4.000');
    expect((await post('almacen_n', `/api/inventario/traslados/${t.body.id}/recibir`, {}, null)).status).toBe(409);
  });

  it('traslado: no permite enviar más de lo disponible ni a la misma sucursal; anular devuelve al origen', async () => {
    const sinStock = await post('almacen_c', '/api/inventario/traslados', { sucursalDestinoId: norte, items: [{ productoId, cantidad: '9999' }] });
    expect(sinStock.status).toBe(409);
    expect((await post('almacen_c', '/api/inventario/traslados', { sucursalDestinoId: centro, items: [{ productoId, cantidad: '1' }] })).status).toBe(422);

    const antes = await stock(centro);
    const t = await post('almacen_c', '/api/inventario/traslados', { sucursalDestinoId: norte, items: [{ productoId, cantidad: '2' }] });
    const anul = await post('almacen_c', `/api/inventario/traslados/${t.body.id}/anular`, {}, null);
    expect(anul.body.estado).toBe('anulado');
    expect(await stock(centro)).toBe(antes);
  });

  it('el kardex refleja toda la historia y cuadra con el stock', async () => {
    const kardex = await s.admin!.agente.get(`/api/inventario/kardex/${productoId}?sucursalId=${centro}`);
    const ultimo = kardex.body[0];
    expect(ultimo.stockResultante).toBe(await stock(centro));
    const suma = kardex.body.reduce((a: number, m: { cantidad: string }) => a + Number(m.cantidad), 0);
    expect(suma.toFixed(3)).toBe(await stock(centro));
    expect(new Set(kardex.body.map((m: { tipo: string }) => m.tipo))).toEqual(new Set(['compra', 'anulacion_compra', 'traslado_salida', 'anulacion_traslado']));
  });
});
