import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../../app.js';
import { db } from '../../database/db.js';
import { procesarLote } from '../../jobs/outbox.js';
import { hashClave } from '../../shared/claves.js';
import { fechaLima } from '../../shared/fechas.js';
import { hayBaseDatos, prepararBdPrueba } from '../../test/bd.js';
import { registrarManejadoresEmision } from '../facturacion/emision.service.js';
import { aCsv } from './reportes.service.js';

const conBd = await hayBaseDatos();
const app = crearApp();
const CLAVE = 'Clave1234';
const hoy = fechaLima();

// Modo simulación: los comprobantes se aceptan sin red, así se prueban los cálculos con datos reales.
describe.skipIf(!conBd)('dashboard y reportes', () => {
  const ids: Record<string, number> = {};
  let s: { agente: ReturnType<typeof request.agent>; csrf: string };
  const post = (ruta: string, cuerpo: object = {}) => s.agente.post(ruta).set('X-CSRF-Token', s.csrf).set('Idempotency-Key', randomUUID()).send(cuerpo);
  async function correrWorker() {
    for (let i = 0; i < 8; i++) {
      await db('outbox_trabajos').where('estado', 'pendiente').update({ ejecutar_en: db.raw('CURRENT_TIMESTAMP(3) - INTERVAL 1 SECOND') });
      if ((await procesarLote()) === 0) break;
    }
  }
  async function vender(unidades: number): Promise<{ ventaId: number; comprobanteId: number }> {
    const total = (unidades * 29.9).toFixed(2);
    const r = await post('/api/ventas', {
      cajaId: ids.caja, tipoComprobante: '03', serieId: ids.b101, moneda: 'PEN', cliente: { id: ids.cliente },
      items: [{ productoId: ids.martillo, cantidad: String(unidades) }], formaPago: 'contado', pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: total }],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await correrWorker();
    const c = await db('comprobantes').where('venta_id', r.body.venta.id).first('id', 'estado');
    expect(c.estado).toBe('aceptado');
    return { ventaId: r.body.venta.id, comprobanteId: Number(c.id) };
  }

  beforeAll(async () => {
    await prepararBdPrueba();
    registrarManejadoresEmision();
    ids.sucursal = Number((await db('sucursales').insert({ nombre: 'Centro', cod_local: '0002' }))[0]);
    ids.otra = Number((await db('sucursales').insert({ nombre: 'Zona Sur', cod_local: '0009' }))[0]);
    await db('empresa').insert({ ruc: '20161515648', razon_social: 'EMPRESA', tasa_igv: '18.00', modo_emision: 'simulacion' });
    const serie = (tipo: string, codigo: string, aplica: string | null, apiId: number) => db('series').insert({ api_serie_id: apiId, tipo_doc: tipo, serie: codigo, aplica_a: aplica, propia: true, sucursal_id: ids.sucursal, predeterminada: aplica !== null });
    ids.b101 = Number((await serie('03', 'B101', null, 1))[0]);
    await serie('07', 'BC11', 'B', 2);
    const unidad = (await db('unidades').where('codigo_sunat', 'NIU').first('id')).id;
    ids.martillo = Number((await db('productos').insert({ codigo: 'MART', nombre: 'Martillo', unidad_id: unidad, precio_venta: '29.90', costo_promedio: '15.000000', stock_minimo: '200' }))[0]);
    await db('stock').insert({ producto_id: ids.martillo, sucursal_id: ids.sucursal, cantidad: '100' });
    ids.cliente = Number((await db('clientes').insert({ tipo_doc: '1', num_doc: '12345678', razon_social: 'Juan Pérez' }))[0]);
    ids.efectivo = Number((await db('metodos_pago').where('codigo', 'EFECTIVO').first('id')).id);
    const rol = (await db('roles').where('codigo', 'admin').first('id')).id;
    ids.usuario = Number((await db('usuarios').insert({ usuario: 'admin', nombre: 'Ana Admin', password_hash: await hashClave(CLAVE), rol_id: rol, debe_cambiar_password: false }))[0]);
    const agente = request.agent(app);
    const login = await agente.post('/api/auth/login').send({ usuario: 'admin', password: CLAVE });
    s = { agente, csrf: login.body.csrfToken };
    ids.caja = Number((await db('cajas').insert({ sucursal_id: ids.sucursal, nombre: 'Caja 1' }))[0]);
    await post('/api/turnos/abrir', { cajaId: ids.caja, saldosIniciales: [{ moneda: 'PEN', monto: '100' }] });

    // Dos ventas (3 y 2 martillos), una devolución de 1 martillo y una venta anulada (no cuenta).
    const v1 = await vender(3);
    await vender(2);
    const saldo = await s.agente.get(`/api/comprobantes/${v1.comprobanteId}/saldo-nota`);
    const nc = await post('/api/notas-credito', {
      comprobanteAfectadoId: v1.comprobanteId, codMotivo: '07', desMotivo: 'Devuelve una unidad',
      items: [{ comprobanteItemId: saldo.body.lineas[0].id, cantidad: '1' }], devuelveStock: true, reintegro: { tipo: 'caja', cajaId: ids.caja, metodoPagoId: ids.efectivo },
    });
    expect(nc.status, JSON.stringify(nc.body)).toBe(201);
    const v3 = await vender(4);
    const an = await post('/api/anulaciones', { comprobanteIds: [v3.comprobanteId], motivo: 'Error en la venta' });
    expect(an.status, JSON.stringify(an.body)).toBe(201);
    expect((await db('ventas').where('id', v3.ventaId).first('estado')).estado).toBe('anulada');
    await correrWorker();
  }, 90_000);

  afterAll(async () => {
    await db.destroy();
  });

  it('dashboard: ventas netas de hoy (la NC resta, la anulada no cuenta)', async () => {
    const r = await s.agente.get('/api/dashboard');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.ventas).toMatchObject({ totalPen: '119.60', n: 2, ticketPromedio: '59.80', variacion: null, porMoneda: [{ moneda: 'PEN', total: '119.60' }] });
    expect(r.body.topProductos).toEqual([{ productoId: ids.martillo, nombre: 'Martillo', cantidad: '4.000', totalPen: '119.60' }]);
    expect(r.body.stockBajo).toEqual([expect.objectContaining({ codigo: 'MART', minimo: '200.000' })]);
    expect(r.body.serieDiaria).toHaveLength(14);
    expect(r.body.serieDiaria.at(-1)).toEqual({ fecha: hoy, totalPen: '119.60', n: 2 });
    // Efectivo: 89.70 + 59.80 + 119.60 (anulada, aún sin reembolso) − 29.90 (devolución)
    const efectivo = r.body.porMetodo.find((m: { metodo: string }) => m.metodo === 'Efectivo');
    expect(efectivo).toMatchObject({ moneda: 'PEN', total: '239.20' });
    expect(r.body.comprobantes.aceptadosHoy).toBeGreaterThanOrEqual(2);
  });

  it('ventas por día y por producto cuadran con el dashboard', async () => {
    const dia = await s.agente.get(`/api/reportes/ventas?agrupar=dia&desde=${hoy}&hasta=${hoy}`);
    expect(dia.status, JSON.stringify(dia.body)).toBe(200);
    expect(dia.body.filas).toEqual([{ dia: hoy, moneda: 'PEN', ventas: 2, bruto: '149.50', notas: '-29.90', neto: '119.60' }]);
    expect(dia.body.totales).toEqual([{ dia: 'Total', moneda: 'PEN', ventas: 2, bruto: '149.50', notas: '-29.90', neto: '119.60' }]);

    const prod = await s.agente.get(`/api/reportes/ventas?agrupar=producto&desde=${hoy}&hasta=${hoy}`);
    expect(prod.body.filas).toEqual([{ codigo: 'MART', producto: 'Martillo', moneda: 'PEN', vendido: '5.000', devuelto: '1.000', cantidad: '4.000', neto: '119.60' }]);

    const cliente = await s.agente.get(`/api/reportes/ventas?agrupar=cliente&desde=${hoy}&hasta=${hoy}`);
    expect(cliente.body.filas).toEqual([expect.objectContaining({ cliente: 'Juan Pérez', documento: '12345678', neto: '119.60' })]);
    const vendedor = await s.agente.get(`/api/reportes/ventas?agrupar=usuario&desde=${hoy}&hasta=${hoy}`);
    expect(vendedor.body.filas).toEqual([expect.objectContaining({ vendedor: 'Ana Admin', neto: '119.60' })]);
    const metodo = await s.agente.get(`/api/reportes/ventas?agrupar=metodo&desde=${hoy}&hasta=${hoy}`);
    expect(metodo.body.filas).toEqual([expect.objectContaining({ metodo: 'Efectivo', ventas: '269.10', devoluciones: '-29.90', neto: '239.20' })]);
  });

  it('comprobantes: la NC en negativo; inventario valorizado', async () => {
    const r = await s.agente.get(`/api/reportes/comprobantes?desde=${hoy}`);
    const nc = r.body.filas.find((f: { tipo: string }) => f.tipo.startsWith('Nota de crédito'));
    expect(nc).toMatchObject({ estado: 'aceptado', n: 1, total: '-29.90' });
    const inv = await s.agente.get('/api/reportes/inventario');
    // 100 − 3 − 2 + 1 (NC) − 4 + 4 (anulación) = 96 × 15
    expect(inv.body.filas).toEqual([{ sucursal: 'Centro', codigo: 'MART', producto: 'Martillo', unidad: 'NIU', stock: '96.000', costo: '15.00', valor: '1440.00' }]);
    expect(inv.body.totales).toEqual([{ sucursal: 'Total', valor: '1440.00', costo: '15.00' }]);
  });

  it('exporta CSV para Excel (UTF-8 con BOM)', async () => {
    const r = await s.agente.get(`/api/reportes/ventas?agrupar=producto&desde=${hoy}&formato=csv`).buffer(true).parse((res, cb) => {
      const partes: Buffer[] = [];
      res.on('data', (c: Buffer) => partes.push(c));
      res.on('end', () => cb(null, Buffer.concat(partes).toString('utf8')));
    });
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.headers['content-disposition']).toContain('reporte-ventas-producto');
    const texto = r.body as string;
    expect(texto.charCodeAt(0)).toBe(0xfeff);
    expect(texto).toContain('Código,Producto,Moneda,Vendido,Devuelto (NC),Cantidad neta,Importe neto');
    expect(texto).toContain('MART,Martillo,PEN,5.000,1.000,4.000,119.60');
  });

  it('valida el rango y la sucursal', async () => {
    expect((await s.agente.get('/api/reportes/ventas?desde=2026-02-01&hasta=2026-01-01')).status).toBe(422);
    // Un supervisor asignado solo a Centro no puede consultar otra sucursal (el admin ve todas).
    const rol = (await db('roles').where('codigo', 'supervisor').first('id')).id;
    const sup = Number((await db('usuarios').insert({ usuario: 'super', nombre: 'Supervisor', password_hash: await hashClave(CLAVE), rol_id: rol, debe_cambiar_password: false }))[0]);
    await db('usuario_sucursales').insert({ usuario_id: sup, sucursal_id: ids.sucursal });
    const agente = request.agent(app);
    await agente.post('/api/auth/login').send({ usuario: 'super', password: CLAVE });
    expect((await agente.get(`/api/reportes/ventas?sucursalId=${ids.otra}`)).status).toBe(403);
    expect((await agente.get(`/api/reportes/ventas?sucursalId=${ids.sucursal}`)).status).toBe(200);
  });

  it('auditoría e intentos de integración', async () => {
    const r = await s.agente.get('/api/auditoria?accion=comprobante.anular');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data[0]).toMatchObject({ accion: 'comprobante.anular', usuario: 'Ana Admin', sucursal: 'Centro' });
    const i = await s.agente.get('/api/integracion/intentos?soloErrores=true');
    expect(i.status).toBe(200);
    expect(i.body).toMatchObject({ page: 1, total: 0 });
  });
});

describe('aCsv', () => {
  it('neutraliza fórmulas en textos y deja los números negativos intactos', () => {
    const csv = aCsv({
      titulo: 'T',
      subtitulo: 'S',
      columnas: [{ clave: 'cliente', titulo: 'Cliente', tipo: 'texto' }, { clave: 'neto', titulo: 'Neto', tipo: 'importe' }],
      filas: [{ cliente: '=HYPERLINK("http://x")', neto: '-29.90' }, { cliente: 'Pérez, Juan', neto: '10.00' }],
      totales: [],
      notas: [],
    });
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")",-29.90`);
    expect(csv).toContain('"Pérez, Juan",10.00');
  });
});
