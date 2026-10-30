import {
  aSoles, calcularVenta, convertirAUsd, descuentoPorPorcentaje, ErrorCalculo, type CalculoVenta, type ComprobanteResumenDto,
  type ItemCalculo, type Moneda, type VentaDto, type VentaInput,
} from '@sv/shared';
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { db, type Trx } from '../../database/db.js';
import { encolar } from '../../jobs/outbox.js';
import { aImporte, dec } from '../../shared/decimal.js';
import { ErrorApp, errores } from '../../shared/errors.js';
import { fechaLima } from '../../shared/fechas.js';
import { consumirAutorizacion } from '../auth/auth.service.js';
import { bloquearTurnoAbierto, registrarMovimiento } from '../caja/caja.service.js';
import { leerAjuste } from '../configuracion/configuracion.service.js';
import { mover } from '../inventario/inventario.service.js';
import { clientes } from '../terceros/terceros.service.js';

const LIMITE_BOLETA_SIN_DOC = 700; // S/ (regla SUNAT que también valida API-PRO)
const CLIENTES_VARIOS = { tipoDoc: '0', numDoc: '-', razonSocial: 'CLIENTES VARIOS', direccion: null as string | null, email: null as string | null };

export interface ContextoVenta {
  sucursalId: number;
  operadorId: number;
  permisos: Set<string>;
  idempotencyKey: string;
}

interface ProductoVenta {
  id: number;
  codigo: string;
  nombre: string;
  unidad: string;
  fraccionable: boolean;
  tip_afe_igv: '10' | '20' | '30';
  precio_venta: string;
  precio_venta_usd: string | null;
  activo: boolean;
}

/** Tipo de cambio de hoy (venta). Obligatorio para operar en dólares. */
async function tipoCambioHoy(conn: Knex = db): Promise<string> {
  const tc = await conn('tipos_cambio').where('fecha', fechaLima()).first('venta');
  if (!tc) throw new ErrorApp(409, 'TIPO_CAMBIO_NO_REGISTRADO', `Registra el tipo de cambio de hoy (${fechaLima()}) para operar en dólares`);
  return String(tc.venta);
}

async function cargarProductos(ids: number[]): Promise<Map<number, ProductoVenta>> {
  const filas = await db('productos as p')
    .join('unidades as u', 'u.id', 'p.unidad_id')
    .whereIn('p.id', ids)
    .select('p.id', 'p.codigo', 'p.nombre', 'u.codigo_sunat as unidad', 'u.fraccionable', 'p.tip_afe_igv', 'p.precio_venta', 'p.precio_venta_usd', 'p.activo');
  const mapa = new Map(filas.map((p: ProductoVenta & { id: number | string }) => [Number(p.id), { ...p, id: Number(p.id), fraccionable: Boolean(p.fraccionable), activo: Boolean(p.activo) }]));
  for (const id of ids) {
    const p = mapa.get(id);
    if (!p) throw errores.validacion({ items: `El producto ${id} no existe` });
    if (!p.activo) throw errores.validacion({ items: `${p.nombre} está desactivado` });
  }
  return mapa;
}

function precioEnMoneda(p: ProductoVenta, moneda: Moneda, tc: string | null): string {
  if (moneda === 'PEN') return p.precio_venta;
  return p.precio_venta_usd ?? convertirAUsd(p.precio_venta, tc!);
}

/** Cálculo oficial de la venta (también lo usa la vista previa del POS). */
export async function cotizar(datos: { moneda: Moneda; items: Array<{ productoId: number; cantidad: string }>; descuento?: { tipo: 'monto' | 'porcentaje'; valor: string } }) {
  const tc = datos.moneda === 'USD' ? await tipoCambioHoy() : null;
  const productos = await cargarProductos(datos.items.map((i) => i.productoId));
  const empresa = await db('empresa').first('tasa_igv');
  const tasaIgv = String(empresa?.tasa_igv ?? '18.00');

  const items: ItemCalculo[] = datos.items.map((i) => {
    const p = productos.get(i.productoId)!;
    if (!p.fraccionable && !dec(i.cantidad).isInteger()) throw errores.validacion({ items: `${p.nombre} se vende por unidades enteras (${p.unidad})` });
    return { productoId: p.id, nombre: p.nombre, precioUnitario: precioEnMoneda(p, datos.moneda, tc), cantidad: i.cantidad, tipAfeIgv: p.tip_afe_igv };
  });
  try {
    const bruto = calcularVenta(items, { tasaIgv });
    const descuento = !datos.descuento || dec(datos.descuento.valor).isZero() ? '0'
      : datos.descuento.tipo === 'porcentaje'
        ? (dec(datos.descuento.valor).gt(100) ? (() => { throw new ErrorCalculo('El porcentaje no puede superar 100', 'descuento'); })() : descuentoPorPorcentaje(bruto.subtotal, datos.descuento.valor))
        : datos.descuento.valor;
    const calculo = dec(descuento).isZero() ? bruto : calcularVenta(items, { tasaIgv, descuento });
    return { calculo, productos, tasaIgv, tipoCambio: tc ?? '1' };
  } catch (err) {
    if (err instanceof ErrorCalculo) throw errores.validacion({ [err.campo ?? 'items']: err.message });
    throw err;
  }
}

/** Convierte un pago a la moneda de la venta con el tipo de cambio del día. */
function aMonedaVenta(monto: string, monedaPago: Moneda, monedaVenta: Moneda, tc: string): string {
  if (monedaPago === monedaVenta) return aImporte(monto);
  return monedaVenta === 'PEN' ? aImporte(dec(monto).times(tc)) : aImporte(dec(monto).div(tc));
}

async function resolverCliente(trx: Trx, cliente: VentaInput['cliente']) {
  if (!cliente) return null;
  if ('id' in cliente) {
    const c = await trx('clientes').where('id', cliente.id).first();
    if (!c) throw errores.validacion({ cliente: 'Cliente inválido' });
    if (!c.activo) throw errores.validacion({ cliente: 'El cliente está desactivado' });
    return c;
  }
  // Alta en el momento; si el documento ya existe, se usa el registrado.
  const existente = await trx('clientes').where({ tipo_doc: cliente.nuevo.tipoDoc, num_doc: cliente.nuevo.numDoc }).first();
  if (existente) return existente;
  // Se crea dentro de la transacción de la venta: si la venta falla, el cliente tampoco queda.
  const dto = await clientes.crear(cliente.nuevo, trx);
  return trx('clientes').where('id', dto.id).first();
}

/**
 * Registra la venta completa en una sola transacción: venta e ítems, salida de stock, pagos y
 * movimientos de caja, cuenta por cobrar (crédito), comprobante pendiente y su trabajo de emisión.
 * Idempotente por `idempotencyKey` (la genera el POS por venta): un reintento devuelve la misma venta.
 */
export async function registrar(datos: VentaInput, ctx: ContextoVenta): Promise<{ venta: VentaDto; repetida: boolean; vuelto: Array<{ moneda: Moneda; monto: string }> }> {
  const previa = await db('ventas').where('idempotency_key', ctx.idempotencyKey).first('id');
  if (previa) return { venta: await obtener(Number(previa.id)), repetida: true, vuelto: [] };

  // ---------- Validaciones previas (sin bloqueos) ----------
  const caja = await db('cajas as c')
    .leftJoin('turnos_caja as t', function () {
      this.on('t.caja_id', 'c.id').andOnVal('t.estado', 'abierto');
    })
    .where('c.id', datos.cajaId)
    .first('c.sucursal_id', 't.id as turno_id');
  if (!caja || Number(caja.sucursal_id) !== ctx.sucursalId) throw errores.validacion({ cajaId: 'La caja no pertenece a la sucursal activa' });
  if (!caja.turno_id) throw new ErrorApp(409, 'TURNO_NO_ABIERTO', 'Abre la caja para vender');
  const turnoId = Number(caja.turno_id);

  const serie = await db('series').where('id', datos.serieId).first();
  if (!serie || serie.tipo_doc !== datos.tipoComprobante || Number(serie.sucursal_id) !== ctx.sucursalId || !serie.activo) {
    throw errores.validacion({ serieId: 'La serie no corresponde a este comprobante o sucursal' });
  }
  if (!serie.propia) throw errores.validacion({ serieId: 'Solo se emite con series propias de este sistema (Configuración → Series)' });

  const sucursal = await db('sucursales').where('id', ctx.sucursalId).first('modo_boletas');
  const modoEnvio = datos.tipoComprobante === '03' ? (datos.modoBoleta ?? sucursal.modo_boletas) : 'individual';
  if (datos.tipoComprobante === '03' && datos.modoBoleta && datos.modoBoleta !== sucursal.modo_boletas && !ctx.permisos.has('boletas.elegir_modo')) {
    throw new ErrorApp(403, 'SIN_PERMISO', 'No puedes cambiar el modo de envío de la boleta');
  }

  const { calculo, productos, tasaIgv, tipoCambio } = await cotizar(datos);
  // Tipo de cambio del día (venta): se usa para precios en USD y para pagos en otra moneda.
  const usaOtraMoneda = datos.pagos.some((p) => p.moneda !== datos.moneda);
  const tc = datos.moneda === 'USD' ? tipoCambio : usaOtraMoneda ? await tipoCambioHoy() : '1';
  const totalSoles = aSoles(calculo.total, datos.moneda, tc);

  // Descuento: requiere permiso propio o la autorización de un supervisor por PIN.
  let descuentoAutorizadoPor: number | null = null;
  if (dec(calculo.descuento).gt(0)) {
    if (ctx.permisos.has('ventas.descuento')) descuentoAutorizadoPor = ctx.operadorId;
    else if (datos.descuento?.autorizacionToken) descuentoAutorizadoPor = await consumirAutorizacion(datos.descuento.autorizacionToken, 'descuento', ctx.operadorId);
    else throw new ErrorApp(403, 'REQUIERE_AUTORIZACION', 'El descuento requiere la autorización de un supervisor', undefined, { accion: 'descuento' });
  }

  // ---------- Pagos ----------
  const metodos = new Map(
    (await db('metodos_pago').where('activo', true).select('id', 'tipo', 'nombre', 'requiere_referencia')).map((m: { id: number | string; tipo: string; nombre: string; requiere_referencia: number }) => [Number(m.id), m]),
  );
  const pagos = datos.pagos.map((p) => {
    const m = metodos.get(p.metodoPagoId);
    if (!m) throw errores.validacion({ pagos: 'Medio de pago inválido' });
    if (m.requiere_referencia && !p.referencia) throw errores.validacion({ pagos: `${m.nombre}: indica el número de operación` });
    let vuelto: string | null = null;
    if (p.montoRecibido !== undefined) {
      if (m.tipo !== 'efectivo') throw errores.validacion({ pagos: 'El monto recibido solo aplica al efectivo' });
      if (dec(p.montoRecibido).lt(p.monto)) throw errores.validacion({ pagos: 'El efectivo recibido es menor que el monto' });
      vuelto = aImporte(dec(p.montoRecibido).minus(p.monto));
    }
    return { ...p, tipoMetodo: m.tipo, enMonedaVenta: aMonedaVenta(p.monto, p.moneda, datos.moneda, tc), vuelto };
  });
  const pagado = pagos.reduce((a, p) => a.plus(p.enMonedaVenta), dec(0));
  // Cada conversión de moneda puede redondear un céntimo.
  const tolerancia = dec(pagos.filter((p) => p.moneda !== datos.moneda).length).times('0.01');

  if (datos.formaPago === 'contado') {
    if (pagado.minus(calculo.total).abs().gt(tolerancia)) {
      throw new ErrorApp(422, 'VALIDACION', `Los pagos (${aImporte(pagado)}) no coinciden con el total (${calculo.total})`, { pagos: 'No cuadra con el total' });
    }
  } else if (pagado.gte(calculo.total)) {
    throw errores.validacion({ pagos: 'La cuota inicial debe ser menor que el total; si se paga todo, la venta es al contado' });
  }

  // ---------- Crédito ----------
  const hoy = fechaLima();
  if (datos.formaPago === 'credito') {
    if (!ctx.permisos.has('ventas.credito')) throw new ErrorApp(403, 'SIN_PERMISO', 'No tienes permiso para vender al crédito');
    if (!datos.cliente) throw errores.validacion({ cliente: 'La venta al crédito requiere un cliente identificado' });
    const sumaCuotas = datos.cuotas.reduce((a, c) => a.plus(c.monto), dec(0));
    if (!sumaCuotas.plus(pagado).minus(calculo.total).abs().lte(tolerancia)) {
      throw errores.validacion({ cuotas: `Cuotas (${aImporte(sumaCuotas)}) + inicial (${aImporte(pagado)}) deben sumar el total (${calculo.total})` });
    }
    let previa = hoy;
    for (const c of datos.cuotas) {
      if (c.fechaVencimiento <= previa) throw errores.validacion({ cuotas: 'Las fechas de las cuotas deben ser posteriores a hoy y estar en orden' });
      previa = c.fechaVencimiento;
    }
  }

  // ---------- Transacción ----------
  try {
    const resultado = await db.transaction(async (trx) => {
      await bloquearTurnoAbierto(trx, turnoId); // orden de bloqueo: turno → productos → stock

      const cliente = await resolverCliente(trx, datos.cliente);
      if (datos.tipoComprobante === '01') {
        if (!cliente || cliente.tipo_doc !== '6') throw errores.validacion({ cliente: 'La factura requiere un cliente con RUC' });
        if (!cliente.direccion) throw errores.validacion({ cliente: 'La factura requiere la dirección fiscal del cliente' });
      }
      if (!cliente && totalSoles.gt(LIMITE_BOLETA_SIN_DOC)) {
        throw errores.validacion({ cliente: `Para boletas mayores a S/ ${LIMITE_BOLETA_SIN_DOC} identifica al cliente (DNI, RUC o CE)` });
      }

      let creditoAutorizadoPor: number | null = null;
      if (datos.formaPago === 'credito') {
        creditoAutorizadoPor = await validarCredito(trx, cliente, datos, calculo, pagado, ctx);
      }

      const [ventaId] = await trx('ventas').insert({
        idempotency_key: ctx.idempotencyKey,
        sucursal_id: ctx.sucursalId,
        turno_id: turnoId,
        usuario_id: ctx.operadorId,
        cliente_id: cliente?.id ?? null,
        moneda: datos.moneda,
        tipo_cambio: tc,
        forma_pago: datos.formaPago,
        tipo_comprobante: datos.tipoComprobante,
        tasa_igv: tasaIgv,
        subtotal: calculo.subtotal,
        descuento: calculo.descuento,
        descuento_motivo: datos.descuento?.motivo && dec(calculo.descuento).gt(0) ? datos.descuento.motivo : null,
        descuento_autorizado_por: descuentoAutorizadoPor,
        op_gravada: calculo.opGravada,
        op_exonerada: calculo.opExonerada,
        op_inafecta: calculo.opInafecta,
        igv: calculo.igv,
        total: calculo.total,
      });
      const id = Number(ventaId);

      const itemIds: number[] = [];
      for (const l of calculo.lineas) {
        const p = productos.get(l.productoId)!;
        const [itemId] = await trx('venta_items').insert({
          venta_id: id,
          producto_id: p.id,
          codigo: p.codigo,
          descripcion: p.nombre,
          unidad: p.unidad,
          tip_afe_igv: l.tipAfeIgv,
          cantidad: l.cantidad,
          precio_lista: l.precioLista,
          precio_unitario: l.precioUnitario,
          descuento: l.descuento,
          valor_venta: l.valorVenta,
          igv: l.igv,
          total: l.total,
        });
        itemIds.push(Number(itemId));
      }

      await mover(trx, {
        sucursalId: ctx.sucursalId,
        usuarioId: ctx.operadorId,
        origenTipo: 'venta',
        origenId: id,
        lineas: datos.items.map((i) => ({ productoId: i.productoId, cantidad: `-${i.cantidad}`, tipo: 'venta' as const })),
      });

      // Pagos del mismo medio y moneda se agrupan (un movimiento de caja por medio y moneda).
      const agrupados = new Map<string, { metodoPagoId: number; moneda: Moneda; monto: ReturnType<typeof dec>; referencia?: string }>();
      for (const p of pagos) {
        await trx('pagos').insert({
          venta_id: id,
          metodo_pago_id: p.metodoPagoId,
          moneda: p.moneda,
          monto: aImporte(p.monto),
          monto_en_moneda_venta: p.enMonedaVenta,
          monto_recibido: p.montoRecibido ? aImporte(p.montoRecibido) : null,
          vuelto: p.vuelto,
          referencia: p.referencia ?? null,
        });
        const clave = `${p.metodoPagoId}|${p.moneda}`;
        const a = agrupados.get(clave) ?? { metodoPagoId: p.metodoPagoId, moneda: p.moneda, monto: dec(0), referencia: p.referencia };
        a.monto = a.monto.plus(p.monto);
        agrupados.set(clave, a);
      }
      for (const a of agrupados.values()) {
        await registrarMovimiento(trx, {
          turnoId,
          tipo: 'venta',
          metodoPagoId: a.metodoPagoId,
          moneda: a.moneda,
          monto: a.monto,
          concepto: `Venta ${id}${datos.formaPago === 'credito' ? ' (cuota inicial)' : ''}`,
          referencia: a.referencia,
          origenTipo: 'venta',
          origenId: id,
          usuarioId: ctx.operadorId,
        });
      }

      if (datos.formaPago === 'credito') {
        const saldo = aImporte(dec(calculo.total).minus(pagado).toDecimalPlaces(2));
        const [cxcId] = await trx('cuentas_por_cobrar').insert({
          venta_id: id,
          cliente_id: cliente!.id,
          moneda: datos.moneda,
          total: saldo,
          saldo,
          vence_ultima: datos.cuotas[datos.cuotas.length - 1]!.fechaVencimiento,
        });
        await trx('cuotas').insert(datos.cuotas.map((c, i) => ({ cxc_id: cxcId, numero: i + 1, monto: aImporte(c.monto), saldo: aImporte(c.monto), fecha_vencimiento: c.fechaVencimiento })));
      }

      // Comprobante pendiente + trabajo de emisión (outbox) en la misma transacción.
      const cli = cliente
        ? { tipoDoc: cliente.tipo_doc, numDoc: cliente.num_doc, razonSocial: cliente.razon_social, direccion: cliente.direccion, email: cliente.email }
        : CLIENTES_VARIOS;
      const [comprobanteId] = await trx('comprobantes').insert({
        sucursal_id: ctx.sucursalId,
        venta_id: id,
        tipo_doc: datos.tipoComprobante,
        serie_id: serie.id,
        serie: serie.serie,
        fecha_emision: hoy,
        moneda: datos.moneda,
        tipo_cambio: tc,
        forma_pago: datos.formaPago,
        cliente_tipo_doc: cli.tipoDoc,
        cliente_num_doc: cli.numDoc,
        cliente_razon_social: cli.razonSocial,
        cliente_direccion: cli.direccion,
        cliente_email: cli.email,
        op_gravada: calculo.opGravada,
        op_exonerada: calculo.opExonerada,
        op_inafecta: calculo.opInafecta,
        igv: calculo.igv,
        total: calculo.total,
        modo_envio: modoEnvio,
        estado: 'pendiente',
        idempotency_key: randomUUID(),
        emitido_por: ctx.operadorId,
      });
      await trx('comprobante_items').insert(
        calculo.lineas.map((l, i) => {
          const p = productos.get(l.productoId)!;
          return {
            comprobante_id: comprobanteId,
            venta_item_id: itemIds[i],
            producto_id: p.id,
            codigo: p.codigo,
            descripcion: p.nombre,
            unidad: p.unidad,
            tip_afe_igv: l.tipAfeIgv,
            cantidad: l.cantidad,
            precio_unitario: l.precioUnitario,
            valor_venta: l.valorVenta,
            igv: l.igv,
            total: l.total,
          };
        }),
      );
      if (datos.formaPago === 'credito') {
        await trx('comprobante_cuotas').insert(datos.cuotas.map((c, i) => ({ comprobante_id: comprobanteId, numero: i + 1, monto: aImporte(c.monto), fecha_pago: c.fechaVencimiento })));
      }
      await encolar(trx, 'emitir_comprobante', 'comprobante', Number(comprobanteId), { prioridad: 1 });

      return { id, creditoAutorizadoPor };
    });

    const vuelto = pagos.filter((p) => p.vuelto && dec(p.vuelto).gt(0)).map((p) => ({ moneda: p.moneda, monto: p.vuelto! }));
    return { venta: await obtener(resultado.id), repetida: false, vuelto };
  } catch (err) {
    // Dos envíos simultáneos de la misma venta: el segundo choca con la clave única y devuelve la primera.
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      const otra = await db('ventas').where('idempotency_key', ctx.idempotencyKey).first('id');
      if (otra) return { venta: await obtener(Number(otra.id)), repetida: true, vuelto: [] };
    }
    throw err;
  }
}

/** Límite de crédito y cuotas vencidas (según configuración). Devuelve quién autorizó si hizo falta. */
async function validarCredito(
  trx: Trx,
  cliente: { id: number; limite_credito: string | null; moneda_credito: string | null } | null,
  datos: VentaInput,
  calculo: CalculoVenta,
  pagado: ReturnType<typeof dec>,
  ctx: ContextoVenta,
): Promise<number | null> {
  if (!cliente) return null;
  const problemas: string[] = [];

  if (await leerAjuste('credito.bloquear_vencidos', true)) {
    const vencidas = await trx('cuotas as q')
      .join('cuentas_por_cobrar as c', 'c.id', 'q.cxc_id')
      .where('c.cliente_id', cliente.id)
      .whereIn('q.estado', ['pendiente', 'parcial'])
      .andWhere('q.fecha_vencimiento', '<', fechaLima())
      .count({ n: '*' });
    if (Number((vencidas[0] as { n: number }).n) > 0) problemas.push('El cliente tiene cuotas vencidas');
  }
  if ((await leerAjuste('credito.limite_por_cliente', false)) && cliente.limite_credito != null) {
    if (cliente.moneda_credito !== datos.moneda) {
      problemas.push(`El límite de crédito del cliente está en ${cliente.moneda_credito}`);
    } else {
      const [{ saldo }] = (await trx('cuentas_por_cobrar').where({ cliente_id: cliente.id, moneda: datos.moneda }).whereIn('estado', ['pendiente', 'parcial']).sum({ saldo: 'saldo' })) as [{ saldo: string | null }];
      const nuevo = dec(saldo).plus(calculo.total).minus(pagado);
      if (nuevo.gt(cliente.limite_credito)) problemas.push(`Excede el límite de crédito (${cliente.limite_credito}; quedaría en ${aImporte(nuevo)})`);
    }
  }
  if (!problemas.length) return null;
  if (!datos.autorizacionCredito) {
    throw new ErrorApp(403, 'REQUIERE_AUTORIZACION', `${problemas.join('. ')}. Requiere autorización de un supervisor.`, undefined, { accion: 'credito_excedido', problemas });
  }
  return consumirAutorizacion(datos.autorizacionCredito, 'credito_excedido', ctx.operadorId);
}

// ---------- Consultas ----------

export async function resumenComprobantes(ventaIds: number[], conn: Knex = db): Promise<Map<number, ComprobanteResumenDto[]>> {
  const mapa = new Map<number, ComprobanteResumenDto[]>();
  if (!ventaIds.length) return mapa;
  const filas = await conn('comprobantes').whereIn('venta_id', ventaIds).orderBy('id');
  for (const c of filas as Array<Record<string, unknown>>) {
    const lista = mapa.get(Number(c.venta_id)) ?? [];
    lista.push({
      id: Number(c.id),
      tipoDoc: c.tipo_doc as ComprobanteResumenDto['tipoDoc'],
      serie: String(c.serie),
      correlativo: c.correlativo == null ? null : Number(c.correlativo),
      numeroCompleto: (c.numero_completo as string | null) ?? null,
      estado: c.estado as ComprobanteResumenDto['estado'],
      modoEnvio: c.modo_envio as 'individual' | 'resumen',
      total: String(c.total),
      moneda: c.moneda as Moneda,
      sunatDescripcion: (c.sunat_descripcion as string | null) ?? null,
    });
    mapa.set(Number(c.venta_id), lista);
  }
  return mapa;
}

export async function obtener(id: number, conn: Knex = db): Promise<VentaDto> {
  const v = await conn('ventas as v')
    .join('sucursales as s', 's.id', 'v.sucursal_id')
    .join('usuarios as u', 'u.id', 'v.usuario_id')
    .leftJoin('clientes as c', 'c.id', 'v.cliente_id')
    .where('v.id', id)
    .first('v.*', 's.nombre as sucursal_nombre', 'u.nombre as cajero', 'c.tipo_doc', 'c.num_doc', 'c.razon_social', 'c.direccion');
  if (!v) throw errores.noEncontrado('Venta');
  const [items, pagos, cuotas, comprobantes] = await Promise.all([
    conn('venta_items').where('venta_id', id).orderBy('id'),
    conn('pagos as p').join('metodos_pago as m', 'm.id', 'p.metodo_pago_id').where('p.venta_id', id).orderBy('p.id').select('p.*', 'm.nombre as metodo'),
    conn('cuotas as q').join('cuentas_por_cobrar as c', 'c.id', 'q.cxc_id').where('c.venta_id', id).orderBy('q.numero').select('q.*'),
    resumenComprobantes([id], conn),
  ]);
  return {
    id: Number(v.id),
    fecha: new Date(v.fecha).toISOString(),
    sucursal: { id: Number(v.sucursal_id), nombre: v.sucursal_nombre },
    cajero: v.cajero,
    cliente: v.cliente_id
      ? { id: Number(v.cliente_id), tipoDoc: v.tipo_doc, numDoc: v.num_doc, razonSocial: v.razon_social, direccion: v.direccion ?? null }
      : { id: null, ...CLIENTES_VARIOS },
    moneda: v.moneda,
    tipoCambio: String(v.tipo_cambio),
    formaPago: v.forma_pago,
    tipoComprobante: v.tipo_comprobante,
    subtotal: v.subtotal,
    descuento: v.descuento,
    descuentoMotivo: v.descuento_motivo ?? null,
    opGravada: v.op_gravada,
    opExonerada: v.op_exonerada,
    opInafecta: v.op_inafecta,
    igv: v.igv,
    tasaIgv: v.tasa_igv,
    total: v.total,
    estado: v.estado,
    items: (items as Array<Record<string, string>>).map((i) => ({
      productoId: Number(i.producto_id),
      codigo: i.codigo!,
      descripcion: i.descripcion!,
      unidad: i.unidad!,
      cantidad: i.cantidad!,
      precioLista: i.precio_lista!,
      precioUnitario: i.precio_unitario!,
      descuento: i.descuento!,
      total: i.total!,
    })),
    pagos: (pagos as Array<Record<string, string | null>>).map((p) => ({
      metodo: p.metodo!,
      moneda: p.moneda as Moneda,
      monto: p.monto!,
      montoRecibido: p.monto_recibido ?? null,
      vuelto: p.vuelto ?? null,
      referencia: p.referencia ?? null,
    })),
    cuotas: (cuotas as Array<Record<string, string>>).map((q) => ({ numero: Number(q.numero), monto: q.monto!, saldo: q.saldo!, fechaVencimiento: q.fecha_vencimiento!, estado: q.estado! })),
    comprobantes: comprobantes.get(id) ?? [],
  };
}

export async function listar(sucursalIds: number[], f: { page: number; pageSize: number; desde?: string; hasta?: string; formaPago?: string; estado?: string }) {
  const filtrar = (q: Knex.QueryBuilder) => {
    q.whereIn('v.sucursal_id', sucursalIds);
    if (f.desde) q.where('v.fecha', '>=', `${f.desde} 05:00:00`); // 00:00 en Lima
    if (f.hasta) q.where('v.fecha', '<', db.raw('DATE_ADD(?, INTERVAL 29 HOUR)', [f.hasta]));
    if (f.formaPago) q.where('v.forma_pago', f.formaPago);
    if (f.estado) q.where('v.estado', f.estado);
  };
  const [{ total }] = (await db('ventas as v').modify(filtrar).count({ total: '*' })) as [{ total: number }];
  const filas = await db('ventas as v')
    .join('usuarios as u', 'u.id', 'v.usuario_id')
    .leftJoin('clientes as c', 'c.id', 'v.cliente_id')
    .modify(filtrar)
    .orderBy('v.id', 'desc')
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize)
    .select('v.id', 'v.fecha', 'v.moneda', 'v.total', 'v.forma_pago', 'v.estado', 'v.tipo_comprobante', 'u.nombre as cajero', 'c.razon_social as cliente');
  const comprobantes = await resumenComprobantes(filas.map((f: { id: number | string }) => Number(f.id)));
  return {
    data: filas.map((v: Record<string, unknown>) => ({
      id: Number(v.id),
      fecha: new Date(v.fecha as string).toISOString(),
      moneda: v.moneda,
      total: v.total,
      formaPago: v.forma_pago,
      estado: v.estado,
      cajero: v.cajero,
      cliente: (v.cliente as string | null) ?? CLIENTES_VARIOS.razonSocial,
      comprobante: comprobantes.get(Number(v.id))?.find((c) => c.tipoDoc === v.tipo_comprobante) ?? null,
    })),
    page: f.page,
    pageSize: f.pageSize,
    total: Number(total),
  };
}

// ---------- Anulación interna ----------

/**
 * Anula una venta cuyo comprobante nunca llegó a SUNAT (no se creó en API-PRO o API-PRO lo rechazó por
 * validación). Revierte stock, devuelve el dinero desde la caja indicada y anula la cuenta por cobrar.
 * Si el comprobante ya existe en API-PRO, hay que usar nota de crédito o comunicación de baja.
 */
export async function anularInterna(
  id: number,
  datos: { motivo: string; cajaId: number; autorizacionToken?: string },
  ctx: { sucursalId: number; operadorId: number; permisos: Set<string> },
): Promise<VentaDto> {
  let autorizadoPor = ctx.operadorId;
  if (!ctx.permisos.has('ventas.anular')) {
    if (!datos.autorizacionToken) throw new ErrorApp(403, 'REQUIERE_AUTORIZACION', 'La anulación requiere la autorización de un supervisor', undefined, { accion: 'anular' });
    autorizadoPor = await consumirAutorizacion(datos.autorizacionToken, 'anular', ctx.operadorId);
  }
  const caja = await db('cajas as c')
    .join('turnos_caja as t', function () {
      this.on('t.caja_id', 'c.id').andOnVal('t.estado', 'abierto');
    })
    .where('c.id', datos.cajaId)
    .first('c.sucursal_id', 't.id as turno_id');
  if (!caja || Number(caja.sucursal_id) !== ctx.sucursalId) throw new ErrorApp(409, 'TURNO_NO_ABIERTO', 'Abre la caja de esta sucursal para devolver el dinero');

  await db.transaction(async (trx) => {
    await bloquearTurnoAbierto(trx, Number(caja.turno_id));
    const v = await trx('ventas').where('id', id).forUpdate().first();
    if (!v) throw errores.noEncontrado('Venta');
    if (Number(v.sucursal_id) !== ctx.sucursalId) throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'La venta es de otra sucursal');
    if (v.estado !== 'confirmada') throw new ErrorApp(409, 'ESTADO_NO_PERMITE', 'La venta ya está anulada o en proceso de anulación');

    // Paso atómico: solo se anula si ningún comprobante llegó a API-PRO. El worker toma los
    // comprobantes con un UPDATE condicional sobre 'pendiente', así que no hay carrera.
    const comprobantes = await trx('comprobantes').where('venta_id', id).forUpdate().select('id', 'estado', 'api_id');
    const enviado = comprobantes.find((c: { estado: string; api_id: number | null }) => c.api_id != null || !['pendiente', 'error_validacion'].includes(c.estado));
    if (enviado) {
      throw new ErrorApp(409, 'COMPROBANTE_ENVIADO', 'El comprobante ya se envió a SUNAT: anúlalo con nota de crédito o comunicación de baja', undefined, { comprobanteId: Number(enviado.id) });
    }
    const cxc = await trx('cuentas_por_cobrar').where('venta_id', id).forUpdate().first();
    if (cxc && dec(cxc.saldo).lt(cxc.total)) throw new ErrorApp(409, 'ESTADO_NO_PERMITE', 'La venta tiene cobros registrados: anula primero los cobros');

    await trx('comprobantes').whereIn('id', comprobantes.map((c: { id: number }) => c.id)).update({ estado: 'anulado_interno' });
    await trx('outbox_trabajos').where({ entidad_tipo: 'comprobante' }).whereIn('entidad_id', comprobantes.map((c: { id: number }) => c.id)).whereIn('estado', ['pendiente', 'pausado']).update({ estado: 'fallido', ultimo_error: 'Venta anulada internamente' });

    const items = await trx('venta_items').where('venta_id', id).select('producto_id', 'cantidad');
    const porProducto = new Map<number, ReturnType<typeof dec>>();
    for (const i of items as Array<{ producto_id: number | string; cantidad: string }>) {
      porProducto.set(Number(i.producto_id), (porProducto.get(Number(i.producto_id)) ?? dec(0)).plus(i.cantidad));
    }
    await mover(trx, {
      sucursalId: Number(v.sucursal_id),
      usuarioId: ctx.operadorId,
      origenTipo: 'venta',
      origenId: id,
      nota: `Anulación: ${datos.motivo}`,
      lineas: [...porProducto].map(([productoId, cantidad]) => ({ productoId, cantidad, tipo: 'anulacion' as const })),
    });

    const pagos = await trx('pagos').where('venta_id', id).select('metodo_pago_id', 'moneda').sum({ monto: 'monto' }).groupBy('metodo_pago_id', 'moneda');
    for (const p of pagos as Array<{ metodo_pago_id: number; moneda: Moneda; monto: string }>) {
      await registrarMovimiento(trx, {
        turnoId: Number(caja.turno_id),
        tipo: 'anulacion',
        metodoPagoId: Number(p.metodo_pago_id),
        moneda: p.moneda,
        monto: dec(p.monto).negated(),
        concepto: `Devolución por anulación de la venta ${id}`,
        origenTipo: 'venta',
        origenId: id,
        usuarioId: ctx.operadorId,
      });
    }
    if (cxc) {
      await trx('cuentas_por_cobrar').where('id', cxc.id).update({ estado: 'anulada', saldo: 0 });
      await trx('cuotas').where('cxc_id', cxc.id).update({ estado: 'anulada', saldo: 0 });
    }
    await trx('ventas').where('id', id).update({ estado: 'anulada', motivo_anulacion: datos.motivo, anulada_por: autorizadoPor });
  });
  return obtener(id);
}
