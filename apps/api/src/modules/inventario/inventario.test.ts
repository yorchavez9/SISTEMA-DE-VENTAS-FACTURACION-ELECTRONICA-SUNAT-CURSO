import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../../app.js';
import { db } from '../../database/db.js';
import { hashClave } from '../../shared/claves.js';
import { ErrorApp } from '../../shared/errors.js';
import { hayBaseDatos, prepararBdPrueba } from '../../test/bd.js';
import { mover } from './inventario.service.js';

const conBd = await hayBaseDatos();
const app = crearApp();
const CLAVE = 'Clave1234';

describe.skipIf(!conBd)('catálogo e inventario (integración)', () => {
  let sucursalId: number;
  let otraSucursal: number;
  let unidadNiu: number;
  let unidadKgm: number;
  let admin: { agente: ReturnType<typeof request.agent>; csrf: string };

  const post = (ruta: string, cuerpo: object, clave?: string) => {
    const r = admin.agente.post(ruta).set('X-CSRF-Token', admin.csrf);
    if (clave) r.set('Idempotency-Key', clave);
    return r.send(cuerpo);
  };
  const stock = async (productoId: number, suc = sucursalId) =>
    (await db('stock').where({ producto_id: productoId, sucursal_id: suc }).first('cantidad'))?.cantidad ?? '0.000';

  async function crearProducto(extra: object = {}): Promise<number> {
    const res = await post('/api/productos', {
      codigo: `P${Math.random().toString(36).slice(2, 8)}`,
      nombre: 'Martillo 16oz',
      unidadId: unidadNiu,
      tipo: 'bien',
      inventariable: true,
      tipAfeIgv: '10',
      precioVenta: '29.50',
      stockMinimo: '2',
      ...extra,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id;
  }

  beforeAll(async () => {
    await prepararBdPrueba();
    const [s1] = await db('sucursales').insert({ nombre: 'Centro', cod_local: '0101' });
    const [s2] = await db('sucursales').insert({ nombre: 'Norte', cod_local: '0102' });
    sucursalId = Number(s1);
    otraSucursal = Number(s2);
    unidadNiu = Number((await db('unidades').where('codigo_sunat', 'NIU').first('id')).id);
    unidadKgm = Number((await db('unidades').where('codigo_sunat', 'KGM').first('id')).id);
    const rol = (await db('roles').where('codigo', 'admin').first('id')).id;
    await db('usuarios').insert({ usuario: 'admin', nombre: 'Admin', password_hash: await hashClave(CLAVE), rol_id: rol, debe_cambiar_password: false });
    const agente = request.agent(app);
    const login = await agente.post('/api/auth/login').send({ usuario: 'admin', password: CLAVE });
    admin = { agente, csrf: login.body.csrfToken };
    // La sucursal activa del admin es la primera por nombre: Centro.
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
  });

  it('crea un producto con stock inicial en la sucursal activa y lo registra en el kardex', async () => {
    const id = await crearProducto({ stockInicial: '10' });
    expect(await stock(id)).toBe('10.000');
    const kardex = await admin.agente.get(`/api/inventario/kardex/${id}`);
    expect(kardex.body).toEqual([expect.objectContaining({ tipo: 'stock_inicial', cantidad: '10.000', stockResultante: '10.000' })]);
  });

  it('imagen opcional: se valida por contenido, se reemplaza, se sirve con sesión y se quita', async () => {
    const id = await crearProducto();
    expect((await admin.agente.get(`/api/productos/${id}`)).body.imagenUrl).toBeNull();
    const subir = (datos: Buffer, tipo: string) => admin.agente.put(`/api/productos/${id}/imagen`).set('X-CSRF-Token', admin.csrf).set('Content-Type', tipo).send(datos);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('datos-png')]);
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('datos-jpg')]);

    // Un archivo que dice ser imagen pero no lo es (p. ej. HTML) se rechaza.
    const falso = await subir(Buffer.from('<script>alert(1)</script>'), 'image/png');
    expect(falso.status).toBe(422);
    expect(falso.body.campos.imagen).toMatch(/JPG, PNG o WebP/);

    const r1 = await subir(png, 'image/png');
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.imagenUrl).toMatch(new RegExp(`^/api/productos/${id}/imagen\\?v=[0-9a-f]{12}$`));
    const img = await admin.agente.get(r1.body.imagenUrl).buffer(true);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['cache-control']).toContain('immutable');
    expect((await admin.agente.get(`/api/productos/${id}`)).body.imagenUrl).toBe(r1.body.imagenUrl);

    // Al reemplazarla cambia la URL (otra versión) y el archivo anterior se borra.
    const r2 = await subir(jpg, 'image/jpeg');
    expect(r2.body.imagenUrl).not.toBe(r1.body.imagenUrl);
    expect((await admin.agente.get(r2.body.imagenUrl)).headers['content-type']).toBe('image/jpeg');
    expect((await request(app).get(r2.body.imagenUrl)).status).toBe(401); // sin sesión

    expect((await subir(Buffer.alloc(2 * 1024 * 1024 + 10, 1), 'image/jpeg')).status).toBe(413);

    const q = await admin.agente.delete(`/api/productos/${id}/imagen`).set('X-CSRF-Token', admin.csrf);
    expect(q.status).toBe(204);
    expect((await admin.agente.get(`/api/productos/${id}`)).body.imagenUrl).toBeNull();
    expect((await admin.agente.get(`/api/productos/${id}/imagen`)).status).toBe(404);
  });

  it('valida duplicados y reglas: código, código de barras y servicios sin inventario', async () => {
    await crearProducto({ codigo: 'DUP1', codigoBarras: '7750000000001' });
    const dupCodigo = await post('/api/productos', { codigo: 'dup1', nombre: 'Otro producto', unidadId: unidadNiu, tipo: 'bien', inventariable: true, tipAfeIgv: '10', precioVenta: '1' });
    expect(dupCodigo.status, JSON.stringify(dupCodigo.body)).toBe(422);
    expect(dupCodigo.body.campos.codigo).toBeTruthy();

    const servicio = await post('/api/productos', { codigo: 'SRV1', nombre: 'Instalación', unidadId: unidadNiu, tipo: 'servicio', inventariable: true, tipAfeIgv: '10', precioVenta: '50' });
    expect(servicio.status).toBe(422);
    expect(servicio.body.campos.inventariable).toBeTruthy();
  });

  it('un ajuste no puede dejar stock negativo e informa todos los faltantes', async () => {
    const a = await crearProducto({ stockInicial: '3' });
    const b = await crearProducto({ stockInicial: '1' });
    const res = await post('/api/inventario/ajustes', { motivo: 'Merma', items: [{ productoId: a, cantidad: '-5' }, { productoId: b, cantidad: '-2' }] }, randomUUID());
    expect(res.status).toBe(409);
    expect(res.body.codigo).toBe('STOCK_INSUFICIENTE');
    expect(res.body.detalle.faltantes).toHaveLength(2);
    // Nada se aplicó: la transacción se revirtió completa.
    expect(await stock(a)).toBe('3.000');
    expect(await stock(b)).toBe('1.000');
  });

  it('el mismo ajuste reenviado (misma Idempotency-Key) no mueve el stock dos veces', async () => {
    const p = await crearProducto({ stockInicial: '5' });
    const clave = randomUUID();
    const r1 = await post('/api/inventario/ajustes', { motivo: 'Conteo', items: [{ productoId: p, cantidad: '-2' }] }, clave);
    const r2 = await post('/api/inventario/ajustes', { motivo: 'Conteo', items: [{ productoId: p, cantidad: '-2' }] }, clave);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(r2.headers['idempotent-replay']).toBe('true');
    expect(r2.body.id).toBe(r1.body.id);
    expect(await stock(p)).toBe('3.000');
    expect((await post('/api/inventario/ajustes', { motivo: 'Sin clave', items: [{ productoId: p, cantidad: '1' }] })).status).toBe(400); // sin clave
  });

  it('concurrencia: dos salidas simultáneas por la última unidad → solo una se aplica', async () => {
    const p = await crearProducto({ stockInicial: '1' });
    const salida = (origenId: number) =>
      db.transaction((trx) => mover(trx, { sucursalId, usuarioId: null, origenTipo: 'prueba', origenId, lineas: [{ productoId: p, cantidad: '-1', tipo: 'venta' }] }));
    const resultados = await Promise.allSettled([salida(1), salida(2)]);
    const ok = resultados.filter((r) => r.status === 'fulfilled');
    const fallidos = resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(fallidos).toHaveLength(1);
    expect((fallidos[0]!.reason as ErrorApp).codigo).toBe('STOCK_INSUFICIENTE');
    expect(await stock(p)).toBe('0.000');
  });

  it('el mismo documento de origen no puede mover dos veces el mismo producto', async () => {
    const p = await crearProducto({ stockInicial: '5' });
    const mov = () => db.transaction((trx) => mover(trx, { sucursalId, usuarioId: null, origenTipo: 'venta', origenId: 999, lineas: [{ productoId: p, cantidad: '-1', tipo: 'venta' }] }));
    await mov();
    await expect(mov()).rejects.toMatchObject({ codigo: 'MOVIMIENTO_DUPLICADO' });
    expect(await stock(p)).toBe('4.000');
  });

  it('la base de datos rechaza stock negativo aunque se salte el servicio', async () => {
    const p = await crearProducto({ stockInicial: '1' });
    await expect(db('stock').where({ producto_id: p, sucursal_id: sucursalId }).update({ cantidad: '-1' })).rejects.toThrow(/ck_stock_no_negativo/);
  });

  it('el stock es independiente por sucursal', async () => {
    const p = await crearProducto({ stockInicial: '7' });
    await expect(
      db.transaction((trx) => mover(trx, { sucursalId: otraSucursal, usuarioId: null, origenTipo: 'prueba', origenId: 50, lineas: [{ productoId: p, cantidad: '-1', tipo: 'venta' }] })),
    ).rejects.toMatchObject({ codigo: 'STOCK_INSUFICIENTE' });
    expect(await stock(p)).toBe('7.000');
  });

  it('los servicios no mueven stock', async () => {
    const res = await post('/api/productos', { codigo: 'SRV2', nombre: 'Instalación', unidadId: unidadNiu, tipo: 'servicio', inventariable: false, tipAfeIgv: '10', precioVenta: '50' });
    expect(res.status).toBe(201);
    const r = await db.transaction((trx) => mover(trx, { sucursalId, usuarioId: null, origenTipo: 'prueba', origenId: 60, lineas: [{ productoId: res.body.id, cantidad: '-3', tipo: 'venta' }] }));
    expect(r[0]!.aplicado).toBe(false);
    expect(await db('movimientos_stock').where('producto_id', res.body.id).first()).toBeUndefined();
  });

  it('las entradas con costo recalculan el costo promedio ponderado', async () => {
    const p = await crearProducto();
    const entrada = (origenId: number, cantidad: string, costo: string) =>
      db.transaction((trx) => mover(trx, { sucursalId, usuarioId: null, origenTipo: 'compra', origenId, lineas: [{ productoId: p, cantidad, tipo: 'compra', costoUnitario: costo }] }));
    await entrada(1, '10', '20');
    await entrada(2, '10', '30');
    expect((await db('productos').where('id', p).first('costo_promedio')).costo_promedio).toBe('25.000000');
  });

  it('cantidades fraccionables con 3 decimales sin errores de redondeo', async () => {
    const p = await crearProducto({ unidadId: unidadKgm, stockInicial: '0.3' });
    await db.transaction((trx) => mover(trx, { sucursalId, usuarioId: null, origenTipo: 'prueba', origenId: 70, lineas: [{ productoId: p, cantidad: '-0.1', tipo: 'venta' }] }));
    await db.transaction((trx) => mover(trx, { sucursalId, usuarioId: null, origenTipo: 'prueba', origenId: 71, lineas: [{ productoId: p, cantidad: '-0.2', tipo: 'venta' }] }));
    expect(await stock(p)).toBe('0.000'); // 0.3 - 0.1 - 0.2 exacto (en float daría -2.7e-17)
  });

  it('un producto con mínimo 0 nunca figura como stock bajo, aunque esté agotado', async () => {
    const p = await crearProducto({ stockMinimo: '0' });
    const res = await admin.agente.get('/api/productos/' + p);
    expect(res.body).toMatchObject({ stock: '0.000', stockBajo: false });
  });

  it('lista con filtro de stock bajo y búsqueda por código de barras', async () => {
    const p = await crearProducto({ codigoBarras: '7751234567890', stockInicial: '1', stockMinimo: '5' });
    const bajo = await admin.agente.get('/api/productos?stockBajo=true&pageSize=100');
    expect(bajo.body.data.some((x: { id: number }) => x.id === p)).toBe(true);
    const pos = await admin.agente.get('/api/productos/buscar-pos?q=7751234567890');
    expect(pos.body[0]).toMatchObject({ id: p, stock: '1.000', stockBajo: true });
  });
});
