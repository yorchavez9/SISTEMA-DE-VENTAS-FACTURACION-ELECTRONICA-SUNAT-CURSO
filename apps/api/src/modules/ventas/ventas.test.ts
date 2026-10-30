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

/** Fecha AAAA-MM-DD a `dias` de hoy (Lima). */
const dentroDe = (dias: number) => {
  const d = new Date(`${fechaLima()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

describe.skipIf(!conBd)('ventas (integración)', () => {
  const ids: Record<string, number> = {};
  const s: Record<string, { agente: ReturnType<typeof request.agent>; csrf: string }> = {};
  let dispositivoToken = '';

  const post = (u: string, ruta: string, cuerpo: object, clave: string | null = randomUUID()) => {
    const r = s[u]!.agente.post(ruta).set('X-CSRF-Token', s[u]!.csrf);
    if (clave) r.set('Idempotency-Key', clave);
    return r.send(cuerpo);
  };
  const stock = async (p: number) => (await db('stock').where({ producto_id: p, sucursal_id: ids.sucursal }).first('cantidad'))?.cantidad;
  const cuenta = async (tabla: string) => Number(((await db(tabla).count({ n: '*' })) as [{ n: number }])[0].n);
  /** Venta mínima al contado en efectivo: boleta, 1 martillo, clientes varios. */
  const venta = (extra: Record<string, unknown> = {}) => ({
    cajaId: ids.caja,
    tipoComprobante: '03',
    serieId: ids.b101,
    moneda: 'PEN',
    cliente: null,
    items: [{ productoId: ids.martillo, cantidad: '1' }],
    formaPago: 'contado',
    pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '29.90' }],
    ...extra,
  });

  beforeAll(async () => {
    await prepararBdPrueba();
    ids.sucursal = Number((await db('sucursales').insert({ nombre: 'Centro', cod_local: '0101', api_sucursal_id: 14 }))[0]);
    await db('empresa').insert({ ruc: '20161515648', razon_social: 'COMPANY CMA SAC', tasa_igv: '18.00' });
    const serie = async (tipo: string, codigo: string, propia: boolean, apiId: number) =>
      Number((await db('series').insert({ api_serie_id: apiId, tipo_doc: tipo, serie: codigo, propia, sucursal_id: ids.sucursal, api_sucursal_id: 14 }))[0]);
    ids.b101 = await serie('03', 'B101', true, 1);
    ids.f101 = await serie('01', 'F101', true, 2);
    ids.b001 = await serie('03', 'B001', false, 3);
    const unidad = async (c: string) => Number((await db('unidades').where('codigo_sunat', c).first('id')).id);
    const producto = async (codigo: string, nombre: string, unidadCod: string, precio: string, stockInicial: string | null, extra: object = {}) => {
      const [id] = await db('productos').insert({ codigo, nombre, unidad_id: await unidad(unidadCod), precio_venta: precio, inventariable: stockInicial !== null, ...extra });
      if (stockInicial !== null) await db('stock').insert({ producto_id: id, sucursal_id: ids.sucursal, cantidad: stockInicial });
      return Number(id);
    };
    ids.martillo = await producto('MART', 'Martillo', 'NIU', '29.90', '50');
    ids.cable = await producto('CABLE', 'Cable', 'MTR', '2.50', '100');
    ids.servicio = await producto('INST', 'Instalación', 'ZZ', '50.00', null, { tipo: 'servicio' });
    ids.caro = await producto('TALADRO', 'Taladro', 'NIU', '750.00', '10', { precio_venta_usd: '200.00' });
    ids.efectivo = Number((await db('metodos_pago').where('codigo', 'EFECTIVO').first('id')).id);
    ids.yape = Number((await db('metodos_pago').where('codigo', 'YAPE').first('id')).id);
    ids.clienteRuc = Number((await db('clientes').insert({ tipo_doc: '6', num_doc: '20100070970', razon_social: 'ACME SAC', direccion: 'AV. X 123' }))[0]);
    ids.clienteDni = Number((await db('clientes').insert({ tipo_doc: '1', num_doc: '12345678', razon_social: 'Juan Pérez' }))[0]);

    for (const [usuario, rol] of [['cajero', 'cajero'], ['super', 'supervisor']] as const) {
      const r = (await db('roles').where('codigo', rol).first('id')).id;
      const [id] = await db('usuarios').insert({ usuario, nombre: usuario, password_hash: await hashClave(CLAVE), pin_hash: await hashClave('2222'), rol_id: r, debe_cambiar_password: false });
      ids[usuario] = Number(id);
      await db('usuario_sucursales').insert({ usuario_id: id, sucursal_id: ids.sucursal });
    }
    // Dispositivo de caja para la autorización por PIN.
    const { sha256 } = await import('../../shared/crypto.js');
    dispositivoToken = randomUUID();
    await db('dispositivos').insert({ sucursal_id: ids.sucursal, nombre: 'Caja 1', token_hash: sha256(dispositivoToken) });
    for (const usuario of ['cajero', 'super']) {
      const agente = request.agent(app);
      const login = await agente.post('/api/auth/login').send({ usuario, password: CLAVE, dispositivoToken });
      s[usuario] = { agente, csrf: login.body.csrfToken };
    }
    ids.caja = Number((await db('cajas').insert({ sucursal_id: ids.sucursal, nombre: 'Caja 1' }))[0]);
    const turno = await post('cajero', '/api/turnos/abrir', { cajaId: ids.caja, saldosIniciales: [{ moneda: 'PEN', monto: '200' }] });
    ids.turno = turno.body.turno.id;
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
  });

  it('venta al contado: registra todo en una transacción y deja el comprobante pendiente en cola', async () => {
    const antes = await stock(ids.martillo);
    const r = await post('cajero', '/api/ventas', venta({ items: [{ productoId: ids.martillo, cantidad: '2' }], pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '59.80', montoRecibido: '100' }] }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const v = r.body.venta;
    expect(v).toMatchObject({ total: '59.80', opGravada: '50.68', igv: '9.12', formaPago: 'contado', estado: 'confirmada', cliente: { razonSocial: 'CLIENTES VARIOS' } });
    expect(r.body.vuelto).toEqual([{ moneda: 'PEN', monto: '40.20' }]);
    expect(Number(await stock(ids.martillo))).toBe(Number(antes) - 2);
    expect(v.comprobantes).toEqual([expect.objectContaining({ tipoDoc: '03', serie: 'B101', estado: 'pendiente', modoEnvio: 'individual', correlativo: null })]);
    expect(await db('outbox_trabajos').where({ tipo: 'emitir_comprobante', entidad_id: v.comprobantes[0].id, estado: 'pendiente' }).first()).toBeTruthy();
    const mov = await db('movimientos_caja').where({ origen_tipo: 'venta', origen_id: v.id }).first();
    expect(mov).toMatchObject({ monto: '59.80', moneda: 'PEN', tipo: 'venta' }); // neto, sin el vuelto
  });

  it('cotizar devuelve exactamente lo mismo que se registra', async () => {
    const cuerpo = { moneda: 'PEN', items: [{ productoId: ids.martillo, cantidad: '3' }, { productoId: ids.cable, cantidad: '10.5' }], descuento: { tipo: 'monto', valor: '10' } };
    const c = await post('super', '/api/ventas/cotizar', cuerpo, null);
    expect(c.body).toMatchObject({ subtotal: '115.95', descuento: '10.00', total: '105.95' });
    const r = await post('super', '/api/ventas', venta({ items: cuerpo.items, descuento: { ...cuerpo.descuento, motivo: 'Cliente frecuente' }, pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '105.95' }] }));
    expect(r.body.venta).toMatchObject({ total: c.body.total, igv: c.body.igv, opGravada: c.body.opGravada });
  });

  it('idempotencia: reenviar la misma venta (también en paralelo) no duplica stock, caja ni comprobante', async () => {
    const clave = randomUUID();
    const [antesVentas, antesComp, antesMov, antesStock] = [await cuenta('ventas'), await cuenta('comprobantes'), await cuenta('movimientos_caja'), await stock(ids.martillo)];
    const resultados = await Promise.all([post('cajero', '/api/ventas', venta(), clave), post('cajero', '/api/ventas', venta(), clave), post('cajero', '/api/ventas', venta(), clave)]);
    const idsVenta = new Set(resultados.map((r) => r.body.venta.id));
    expect(idsVenta.size).toBe(1);
    expect(resultados.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await cuenta('ventas')).toBe(antesVentas + 1);
    expect(await cuenta('comprobantes')).toBe(antesComp + 1);
    expect(await cuenta('movimientos_caja')).toBe(antesMov + 1);
    expect(Number(await stock(ids.martillo))).toBe(Number(antesStock) - 1);
  });

  it('sin stock suficiente no se registra nada', async () => {
    const [antesVentas, antesMov] = [await cuenta('ventas'), await cuenta('movimientos_caja')];
    const r = await post('cajero', '/api/ventas', venta({ cliente: { id: ids.clienteDni }, items: [{ productoId: ids.martillo, cantidad: '9999' }], pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '298970.10' }] }));
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('STOCK_INSUFICIENTE');
    expect(await cuenta('ventas')).toBe(antesVentas);
    expect(await cuenta('movimientos_caja')).toBe(antesMov);
  });

  it('reglas de serie y unidades', async () => {
    expect((await post('cajero', '/api/ventas', venta({ serieId: ids.b001 }))).status).toBe(422); // serie externa
    expect((await post('cajero', '/api/ventas', venta({ serieId: ids.f101 }))).status).toBe(422); // serie de factura en boleta
    const decimal = await post('cajero', '/api/ventas', venta({ items: [{ productoId: ids.martillo, cantidad: '1.5' }], pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '44.85' }] }));
    expect(decimal.status).toBe(422);
    expect(decimal.body.campos.items).toMatch(/unidades enteras/);
    const metros = await post('cajero', '/api/ventas', venta({ items: [{ productoId: ids.cable, cantidad: '1.5' }], pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '3.75' }] }));
    expect(metros.status).toBe(201);
  });

  it('los servicios se venden sin mover stock', async () => {
    const r = await post('cajero', '/api/ventas', venta({ items: [{ productoId: ids.servicio, cantidad: '1' }], pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '50.00' }] }));
    expect(r.status).toBe(201);
    expect(await db('movimientos_stock').where({ origen_tipo: 'venta', origen_id: r.body.venta.id }).first()).toBeUndefined();
  });

  it('factura: exige cliente con RUC y dirección', async () => {
    const base = { tipoComprobante: '01', serieId: ids.f101 };
    expect((await post('cajero', '/api/ventas', venta({ ...base, cliente: null }))).status).toBe(422);
    expect((await post('cajero', '/api/ventas', venta({ ...base, cliente: { id: ids.clienteDni } }))).status).toBe(422);
    const sinDir = await post('cajero', '/api/ventas', venta({ ...base, cliente: { nuevo: { tipoDoc: '6', numDoc: '20161515648', razonSocial: 'SIN DIRECCIÓN SAC' } } }));
    expect(sinDir.status).toBe(422);
    expect(sinDir.body.campos.cliente).toMatch(/dirección/);
    // La venta falló: el cliente nuevo tampoco se guardó (misma transacción).
    expect(await db('clientes').where('num_doc', '20161515648').first()).toBeUndefined();
    const ok = await post('cajero', '/api/ventas', venta({ ...base, cliente: { id: ids.clienteRuc } }));
    expect(ok.status).toBe(201);
    expect(ok.body.venta.comprobantes[0]).toMatchObject({ tipoDoc: '01', serie: 'F101' });
  });

  it('boleta mayor a S/ 700 exige identificar al cliente', async () => {
    const cara = { items: [{ productoId: ids.caro, cantidad: '1' }], pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '750.00' }] };
    const r = await post('cajero', '/api/ventas', venta(cara));
    expect(r.status).toBe(422);
    expect(r.body.campos.cliente).toMatch(/700/);
    expect((await post('cajero', '/api/ventas', venta({ ...cara, cliente: { id: ids.clienteDni } }))).status).toBe(201);
  });

  it('descuento: el cajero necesita la autorización de un supervisor por PIN (un solo uso)', async () => {
    const conDescuento = venta({ descuento: { tipo: 'monto', valor: '4.90', motivo: 'Producto con detalle' }, pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '25.00' }] });
    const sin = await post('cajero', '/api/ventas', conDescuento);
    expect(sin.status).toBe(403);
    expect(sin.body).toMatchObject({ codigo: 'REQUIERE_AUTORIZACION', detalle: { accion: 'descuento' } });

    const aut = await post('cajero', '/api/auth/pin/autorizar', { usuarioId: ids.super, pin: '2222', accion: 'descuento' }, null);
    expect(aut.status).toBe(201);
    const cuerpo = { ...conDescuento, descuento: { ...(conDescuento.descuento as object), autorizacionToken: aut.body.autorizacionToken } };
    const ok = await post('cajero', '/api/ventas', cuerpo);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.venta).toMatchObject({ descuento: '4.90', total: '25.00' });
    expect((await db('ventas').where('id', ok.body.venta.id).first('descuento_autorizado_por')).descuento_autorizado_por).toBe(ids.super);
    // El mismo token no sirve dos veces.
    expect((await post('cajero', '/api/ventas', cuerpo)).status).toBe(403);
  });

  it('pagos mixtos: deben cuadrar con el total y Yape exige número de operación', async () => {
    const items = [{ productoId: ids.martillo, cantidad: '2' }];
    expect((await post('cajero', '/api/ventas', venta({ items, pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '30' }, { metodoPagoId: ids.yape, moneda: 'PEN', monto: '29.80' }] }))).status).toBe(422);
    expect((await post('cajero', '/api/ventas', venta({ items, pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '30' }, { metodoPagoId: ids.yape, moneda: 'PEN', monto: '20', referencia: '123' }] }))).status).toBe(422);
    const ok = await post('cajero', '/api/ventas', venta({ items, pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '30' }, { metodoPagoId: ids.yape, moneda: 'PEN', monto: '29.80', referencia: '0012345' }] }));
    expect(ok.status).toBe(201);
    expect(ok.body.venta.pagos.map((p: { metodo: string }) => p.metodo)).toEqual(['Efectivo', 'Yape']);
  });

  it('venta en dólares: exige el tipo de cambio del día y usa el precio en USD', async () => {
    const usd = venta({ moneda: 'USD', cliente: { id: ids.clienteDni }, items: [{ productoId: ids.caro, cantidad: '1' }], pagos: [{ metodoPagoId: ids.efectivo, moneda: 'USD', monto: '200.00' }] });
    const sinTc = await post('cajero', '/api/ventas', usd);
    expect(sinTc.status).toBe(409);
    expect(sinTc.body.codigo).toBe('TIPO_CAMBIO_NO_REGISTRADO');

    await db('tipos_cambio').insert({ fecha: fechaLima(), compra: '3.7400', venta: '3.7500' });
    const ok = await post('cajero', '/api/ventas', usd);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.venta).toMatchObject({ moneda: 'USD', total: '200.00', tipoCambio: '3.7500' });

    // Sin precio USD propio: se convierte (29.90 / 3.75 = 7.97). Se paga en soles: 7.97 × 3.75 = 29.89.
    const mixta = await post('cajero', '/api/ventas', venta({ moneda: 'USD', pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '29.89' }] }));
    expect(mixta.status, JSON.stringify(mixta.body)).toBe(201);
    expect(mixta.body.venta.total).toBe('7.97');
  });

  it('crédito: permisos, cuotas que cuadran, cuenta por cobrar y cuotas del comprobante', async () => {
    const credito = (extra: object = {}) =>
      venta({
        cliente: { id: ids.clienteDni },
        items: [{ productoId: ids.martillo, cantidad: '4' }],
        formaPago: 'credito',
        pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '19.60' }],
        cuotas: [{ monto: '50.00', fechaVencimiento: dentroDe(30) }, { monto: '50.00', fechaVencimiento: dentroDe(60) }],
        ...extra,
      });
    expect((await post('cajero', '/api/ventas', credito())).status).toBe(403); // sin ventas.credito
    expect((await post('super', '/api/ventas', credito({ cuotas: [{ monto: '40.00', fechaVencimiento: dentroDe(30) }] }))).status).toBe(422);
    expect((await post('super', '/api/ventas', credito({ cliente: null }))).status).toBe(422);
    expect((await post('super', '/api/ventas', credito({ cuotas: [{ monto: '100.00', fechaVencimiento: fechaLima() }] }))).status).toBe(422);

    const ok = await post('super', '/api/ventas', credito());
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const v = ok.body.venta;
    expect(v).toMatchObject({ formaPago: 'credito', total: '119.60' });
    expect(v.cuotas).toEqual([expect.objectContaining({ numero: 1, monto: '50.00', saldo: '50.00' }), expect.objectContaining({ numero: 2 })]);
    expect(await db('cuentas_por_cobrar').where('venta_id', v.id).first()).toMatchObject({ total: '100.00', saldo: '100.00', estado: 'pendiente' });
    expect(await db('comprobante_cuotas').where('comprobante_id', v.comprobantes[0].id).count({ n: '*' })).toEqual([{ n: 2 }]);
  });

  it('crédito: un cliente con cuotas vencidas requiere autorización', async () => {
    const cxc = await db('cuentas_por_cobrar').where('cliente_id', ids.clienteDni).first('id');
    await db('cuotas').where('cxc_id', cxc.id).where('numero', 1).update({ fecha_vencimiento: dentroDe(-5) });
    const r = await post('super', '/api/ventas', venta({ cliente: { id: ids.clienteDni }, formaPago: 'credito', pagos: [], cuotas: [{ monto: '29.90', fechaVencimiento: dentroDe(15) }] }));
    expect(r.status).toBe(403);
    expect(r.body.detalle).toMatchObject({ accion: 'credito_excedido' });
  });

  it('modo de la boleta: el supervisor puede elegir resumen; el cajero no puede cambiarlo', async () => {
    expect((await post('cajero', '/api/ventas', venta({ modoBoleta: 'resumen' }))).status).toBe(403);
    const r = await post('super', '/api/ventas', venta({ modoBoleta: 'resumen' }));
    expect(r.status).toBe(201);
    expect(r.body.venta.comprobantes[0].modoEnvio).toBe('resumen');
  });

  it('anulación interna: revierte stock y caja; no aplica si el comprobante ya llegó a API-PRO', async () => {
    const r = await post('cajero', '/api/ventas', venta({ items: [{ productoId: ids.martillo, cantidad: '3' }], pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '89.70' }] }));
    const v = r.body.venta;
    const antes = Number(await stock(ids.martillo));

    expect((await post('cajero', `/api/ventas/${v.id}/anular-interna`, { motivo: 'Cliente desistió', cajaId: ids.caja }, null)).status).toBe(403);
    const ok = await post('super', `/api/ventas/${v.id}/anular-interna`, { motivo: 'Cliente desistió', cajaId: ids.caja }, null);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.estado).toBe('anulada');
    expect(ok.body.comprobantes[0].estado).toBe('anulado_interno');
    expect(Number(await stock(ids.martillo))).toBe(antes + 3);
    expect(await db('movimientos_caja').where({ origen_tipo: 'venta', origen_id: v.id, tipo: 'anulacion' }).first()).toMatchObject({ monto: '-89.70' });
    expect(await db('outbox_trabajos').where({ entidad_tipo: 'comprobante', entidad_id: v.comprobantes[0].id }).first()).toMatchObject({ estado: 'fallido' });
    expect((await post('super', `/api/ventas/${v.id}/anular-interna`, { motivo: 'Otra vez', cajaId: ids.caja }, null)).status).toBe(409);

    // Con el comprobante ya creado en API-PRO, la anulación interna se bloquea.
    const r2 = await post('cajero', '/api/ventas', venta());
    await db('comprobantes').where('id', r2.body.venta.comprobantes[0].id).update({ api_id: 999, estado: 'en_proceso' });
    const bloqueada = await post('super', `/api/ventas/${r2.body.venta.id}/anular-interna`, { motivo: 'No procede', cajaId: ids.caja }, null);
    expect(bloqueada.status).toBe(409);
    expect(bloqueada.body.codigo).toBe('COMPROBANTE_ENVIADO');
  });

  it('carga del POS: 40 ventas simultáneas sobre 15 unidades → 15 ventas, stock 0, sin errores 5xx', async () => {
    const unidad = (await db('unidades').where('codigo_sunat', 'NIU').first('id')).id;
    const [producto] = await db('productos').insert({ codigo: 'CARGA', nombre: 'Producto de carga', unidad_id: unidad, precio_venta: '10.00' });
    await db('stock').insert({ producto_id: producto, sucursal_id: ids.sucursal, cantidad: '15' });
    const [antesVentas, antesComp, antesMov] = [await cuenta('ventas'), await cuenta('comprobantes'), await cuenta('movimientos_caja')];
    const cuerpo = venta({ items: [{ productoId: producto, cantidad: '1' }], pagos: [{ metodoPagoId: ids.efectivo, moneda: 'PEN', monto: '10.00' }] });

    const inicio = performance.now();
    const r = await Promise.all(Array.from({ length: 40 }, () => post('cajero', '/api/ventas', cuerpo)));
    const ms = performance.now() - inicio;

    const estados = r.map((x) => x.status);
    expect(estados.filter((e) => e >= 500), JSON.stringify(r.find((x) => x.status >= 500)?.body)).toHaveLength(0);
    expect(estados.filter((e) => e === 201)).toHaveLength(15);
    expect(r.filter((x) => x.status !== 201).every((x) => x.status === 409 && x.body.codigo === 'STOCK_INSUFICIENTE')).toBe(true);
    expect(Number(await stock(Number(producto)))).toBe(0);
    expect(await cuenta('ventas')).toBe(antesVentas + 15);
    expect(await cuenta('comprobantes')).toBe(antesComp + 15);
    expect(await cuenta('movimientos_caja')).toBe(antesMov + 15);
    // 40 solicitudes en paralelo contra un solo MySQL local: margen amplio, solo detecta bloqueos.
    expect(ms).toBeLessThan(15_000);
  });

  it('con el turno cerrado no se puede vender', async () => {
    const resumen = await s.cajero!.agente.get(`/api/turnos/${ids.turno}`);
    const contado = resumen.body.efectivo.filter((e: { esperado: string }) => Number(e.esperado) > 0).map((e: { moneda: string; esperado: string }) => ({ moneda: e.moneda, monto: e.esperado }));
    expect((await post('cajero', `/api/turnos/${ids.turno}/cerrar`, { contado }, null)).status).toBe(200);
    const r = await post('cajero', '/api/ventas', venta());
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('TURNO_NO_ABIERTO');
  });
});
