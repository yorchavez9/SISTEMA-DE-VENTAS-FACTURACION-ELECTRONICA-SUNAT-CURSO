import type { AgrupacionVentas, AuditoriaDto, DashboardDto, FiltroAuditoria, FiltroIntentos, FiltroReporte, IntentoDto, Pagina, ReporteDto, TipoColumna } from '@sv/shared';
import { AGRUPACIONES_VENTAS } from '@sv/shared';
import type { Knex } from 'knex';
import { db } from '../../database/db.js';
import { aCantidad, aImporte, dec } from '../../shared/decimal.js';
import { fechaLima } from '../../shared/fechas.js';
import { contadores } from '../facturacion/comprobantes.service.js';

// Dashboard y reportes (fase 8). Las fechas se guardan en UTC; Lima es UTC−5 todo el año (sin horario
// de verano), así que el día local es DATE(fecha − 5 h) y los rangos se traducen a UTC.
// Ventas netas = ventas no anuladas − NC + ND vigentes; cada nota se atribuye a la venta que modifica.

const LIMA = 'INTERVAL 5 HOUR';
const NOTA_NO_VIGENTE = ['rechazado', 'error_validacion', 'anulado', 'anulado_interno'];

const sumarDias = (f: string, d: number) => {
  const x = new Date(`${f}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
};
/** [inicio, fin) en UTC para un rango de días de Lima. */
const enUtc = (desde: string, hasta: string): [string, string] => [`${desde} 05:00:00`, `${sumarDias(hasta, 1)} 05:00:00`];
/** Marcadores para un IN (...). Sin elementos (p. ej. aún no hay sucursales) queda IN (NULL): ninguna fila. */
const marcas = (n: number) => (n === 0 ? 'NULL' : Array.from({ length: n }, () => '?').join(','));

interface Ambito {
  sucursalIds: number[];
  desde: string;
  hasta: string;
  moneda?: 'PEN' | 'USD';
}

/** Ventas y notas a nivel de documento, con las dimensiones de los reportes. */
function documentosNetos(a: Ambito): { sql: string; bindings: unknown[] } {
  const s = marcas(a.sucursalIds.length);
  const [ini, fin] = enUtc(a.desde, a.hasta);
  const mon = a.moneda ? ' AND v.moneda = ?' : '';
  const monNota = a.moneda ? ' AND c.moneda = ?' : '';
  return {
    sql: `
      SELECT DATE(v.fecha - ${LIMA}) AS dia, v.sucursal_id, v.usuario_id, v.cliente_id, v.moneda,
             IF(v.moneda = 'PEN', 1, v.tipo_cambio) AS tc, v.total AS importe, 1 AS n, 0 AS nota
        FROM ventas v
       WHERE v.estado <> 'anulada' AND v.sucursal_id IN (${s}) AND v.fecha >= ? AND v.fecha < ?${mon}
      UNION ALL
      SELECT c.fecha_emision, c.sucursal_id, v.usuario_id, v.cliente_id, c.moneda,
             IF(c.moneda = 'PEN', 1, c.tipo_cambio), IF(c.tipo_doc = '07', -c.total, c.total), 0, 1
        FROM comprobantes c
        JOIN notas n ON n.comprobante_id = c.id
        JOIN comprobantes af ON af.id = n.comprobante_afectado_id
        LEFT JOIN ventas v ON v.id = af.venta_id
       WHERE c.tipo_doc IN ('07','08') AND c.estado NOT IN (${marcas(NOTA_NO_VIGENTE.length)})
         AND c.sucursal_id IN (${s}) AND c.fecha_emision BETWEEN ? AND ?${monNota}`,
    bindings: [
      ...a.sucursalIds, ini, fin, ...(a.moneda ? [a.moneda] : []),
      ...NOTA_NO_VIGENTE, ...a.sucursalIds, a.desde, a.hasta, ...(a.moneda ? [a.moneda] : []),
    ],
  };
}

/** Líneas de ventas y de notas (para el reporte por producto y el top del dashboard). */
function lineasNetas(a: Ambito): { sql: string; bindings: unknown[] } {
  const s = marcas(a.sucursalIds.length);
  const [ini, fin] = enUtc(a.desde, a.hasta);
  const mon = a.moneda ? ' AND v.moneda = ?' : '';
  const monNota = a.moneda ? ' AND c.moneda = ?' : '';
  return {
    sql: `
      SELECT vi.producto_id, vi.codigo, vi.descripcion, v.moneda, IF(v.moneda = 'PEN', 1, v.tipo_cambio) AS tc,
             vi.cantidad, vi.total AS importe
        FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id
       WHERE v.estado <> 'anulada' AND v.sucursal_id IN (${s}) AND v.fecha >= ? AND v.fecha < ?${mon}
      UNION ALL
      SELECT ci.producto_id, ci.codigo, ci.descripcion, c.moneda, IF(c.moneda = 'PEN', 1, c.tipo_cambio),
             IF(c.tipo_doc = '07', -ci.cantidad, 0), IF(c.tipo_doc = '07', -ci.total, ci.total)
        FROM comprobante_items ci JOIN comprobantes c ON c.id = ci.comprobante_id
       WHERE c.tipo_doc IN ('07','08') AND c.estado NOT IN (${marcas(NOTA_NO_VIGENTE.length)})
         AND c.sucursal_id IN (${s}) AND c.fecha_emision BETWEEN ? AND ?${monNota}`,
    bindings: [
      ...a.sucursalIds, ini, fin, ...(a.moneda ? [a.moneda] : []),
      ...NOTA_NO_VIGENTE, ...a.sucursalIds, a.desde, a.hasta, ...(a.moneda ? [a.moneda] : []),
    ],
  };
}

async function filas<T = Record<string, unknown>>(conn: Knex, sql: string, bindings: unknown[]): Promise<T[]> {
  const [r] = (await conn.raw(sql, bindings as Knex.RawBinding[])) as [T[]];
  return r;
}

// ---------- Dashboard ----------

export async function dashboard(sucursalIds: number[]): Promise<DashboardDto> {
  const hoy = fechaLima();
  const semanaPasada = sumarDias(hoy, -7);
  const total = async (dia: string) => {
    const d = documentosNetos({ sucursalIds, desde: dia, hasta: dia });
    const [r] = await filas<{ total: string | null; n: string | null }>(db, `SELECT SUM(importe * tc) AS total, SUM(n) AS n FROM (${d.sql}) x`, d.bindings);
    return { total: dec(r?.total), n: Number(r?.n ?? 0) };
  };
  const [hoyT, antes] = await Promise.all([total(hoy), total(semanaPasada)]);

  const dHoy = documentosNetos({ sucursalIds, desde: hoy, hasta: hoy });
  const d14 = documentosNetos({ sucursalIds, desde: sumarDias(hoy, -13), hasta: hoy });
  const l7 = lineasNetas({ sucursalIds, desde: sumarDias(hoy, -6), hasta: hoy });
  const [ini, fin] = enUtc(hoy, hoy);
  const s = marcas(sucursalIds.length);

  const [porMoneda, serie, top, porMetodo, stockBajo, cxc, cont, aceptados, guias, recientes, productos] = await Promise.all([
    filas<{ moneda: 'PEN' | 'USD'; total: string }>(db, `SELECT moneda, SUM(importe) AS total FROM (${dHoy.sql}) x GROUP BY moneda ORDER BY moneda DESC`, dHoy.bindings),
    filas<{ dia: string; total: string; n: string }>(db, `SELECT DATE_FORMAT(dia, '%Y-%m-%d') AS dia, SUM(importe * tc) AS total, SUM(n) AS n FROM (${d14.sql}) x GROUP BY dia ORDER BY dia`, d14.bindings),
    filas<{ producto_id: number; nombre: string; cantidad: string; total: string }>(
      db,
      `SELECT x.producto_id, MAX(x.descripcion) AS nombre, SUM(x.cantidad) AS cantidad, SUM(x.importe * x.tc) AS total
         FROM (${l7.sql}) x WHERE x.producto_id IS NOT NULL GROUP BY x.producto_id HAVING total > 0 ORDER BY total DESC LIMIT 5`,
      l7.bindings,
    ),
    filas<{ metodo: string; moneda: 'PEN' | 'USD'; total: string }>(
      db,
      `SELECT mp.nombre AS metodo, m.moneda, SUM(m.monto) AS total
         FROM movimientos_caja m JOIN turnos_caja t ON t.id = m.turno_id JOIN cajas cj ON cj.id = t.caja_id JOIN metodos_pago mp ON mp.id = m.metodo_pago_id
        WHERE m.tipo IN ('venta','cobro','devolucion') AND cj.sucursal_id IN (${s}) AND m.fecha >= ? AND m.fecha < ?
        GROUP BY mp.id, mp.nombre, m.moneda HAVING total <> 0 ORDER BY total DESC`,
      [...sucursalIds, ini, fin],
    ),
    db('stock as st')
      .join('productos as p', 'p.id', 'st.producto_id')
      .whereIn('st.sucursal_id', sucursalIds)
      .where('p.activo', true)
      .where('p.inventariable', true)
      .where('p.stock_minimo', '>', 0)
      .whereRaw('st.cantidad <= p.stock_minimo')
      .orderByRaw('st.cantidad / p.stock_minimo')
      .limit(8)
      .select('p.id', 'p.codigo', 'p.nombre', 'st.cantidad', 'p.stock_minimo'),
    filas<{ moneda: 'PEN' | 'USD'; saldo: string; cuotas: string }>(
      db,
      `SELECT x.moneda, SUM(q.saldo) AS saldo, COUNT(*) AS cuotas
         FROM cuotas q JOIN cuentas_por_cobrar x ON x.id = q.cxc_id JOIN ventas v ON v.id = x.venta_id
        WHERE q.estado IN ('pendiente','parcial') AND x.estado IN ('pendiente','parcial') AND q.fecha_vencimiento < ? AND v.sucursal_id IN (${s})
        GROUP BY x.moneda`,
      [hoy, ...sucursalIds],
    ),
    contadores(sucursalIds),
    db('comprobantes').whereIn('sucursal_id', sucursalIds).where({ fecha_emision: hoy, estado: 'aceptado' }).count({ n: '*' }),
    db('guias').whereIn('sucursal_id', sucursalIds).whereIn('estado', ['pendiente', 'enviando', 'por_verificar', 'en_proceso', 'rechazado', 'error_validacion', 'sin_respuesta_sunat']).count({ n: '*' }),
    db('ventas as v')
      .leftJoin('comprobantes as c', function () {
        this.on('c.venta_id', 'v.id').andOnIn('c.tipo_doc', ['01', '03']);
      })
      .whereIn('v.sucursal_id', sucursalIds)
      .orderBy('v.id', 'desc')
      .limit(8)
      .select('v.id', 'v.fecha', 'v.estado', 'v.total', 'v.moneda', 'c.tipo_doc', 'c.numero_completo', 'c.serie', 'c.estado as estado_cpe'),
    db('productos').where('activo', true).count({ n: '*' }),
  ]);

  // Serie de 14 días completa (los días sin ventas en cero).
  const serieDiaria = Array.from({ length: 14 }, (_, i) => {
    const f = sumarDias(hoy, i - 13);
    const r = serie.find((x) => x.dia === f);
    return { fecha: f, totalPen: aImporte(dec(r?.total)), n: Number(r?.n ?? 0) };
  });

  return {
    fecha: hoy,
    moneda: 'PEN',
    ventas: {
      totalPen: aImporte(hoyT.total),
      n: hoyT.n,
      ticketPromedio: hoyT.n ? aImporte(hoyT.total.div(hoyT.n)) : null,
      variacion: antes.total.gt(0) ? Number(hoyT.total.minus(antes.total).div(antes.total).times(100).toFixed(1)) : null,
      porMoneda: porMoneda.map((r) => ({ moneda: r.moneda, total: aImporte(r.total) })),
    },
    porMetodo: porMetodo.map((r) => ({ metodo: r.metodo, moneda: r.moneda, total: aImporte(r.total) })),
    comprobantes: { aceptadosHoy: Number((aceptados[0] as { n: number }).n), ...cont },
    stockBajo: stockBajo.map((r: Record<string, unknown>) => ({ productoId: Number(r.id), codigo: String(r.codigo), nombre: String(r.nombre), stock: aCantidad(r.cantidad as string), minimo: aCantidad(r.stock_minimo as string) })),
    topProductos: top.map((r) => ({ productoId: Number(r.producto_id), nombre: r.nombre, cantidad: aCantidad(r.cantidad), totalPen: aImporte(r.total) })),
    cxcVencida: cxc.map((r) => ({ moneda: r.moneda, saldo: aImporte(r.saldo), cuotas: Number(r.cuotas) })),
    serieDiaria,
    guiasPendientes: Number((guias[0] as { n: number }).n),
    recientes: recientes.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      fecha: new Date(r.fecha as string).toISOString(),
      comprobante: r.tipo_doc ? ((r.numero_completo as string | null) ?? `${r.serie}-…`) : null,
      tipoDoc: (r.tipo_doc as string | null) ?? null,
      estadoComprobante: (r.estado_cpe as string | null) ?? null,
      anulada: r.estado === 'anulada',
      total: aImporte(r.total as string),
      moneda: r.moneda as 'PEN' | 'USD',
    })),
    productos: Number((productos[0] as { n: number }).n),
  };
}

// ---------- Reportes ----------

type Columnas = ReporteDto['columnas'];
const col = (clave: string, titulo: string, tipo: TipoColumna = 'texto') => ({ clave, titulo, tipo });

/** Formatea importes y cantidades y calcula los totales por moneda de las columnas sumables. */
function armar(titulo: string, subtitulo: string, columnas: Columnas, crudas: Array<Record<string, unknown>>, notas: string[] = []): ReporteDto {
  const formatear = (tipo: TipoColumna, v: unknown) => {
    if (v == null) return null;
    if (tipo === 'importe') return aImporte(v as string);
    if (tipo === 'cantidad') return aCantidad(v as string);
    if (tipo === 'entero') return Number(v);
    if (tipo === 'porcentaje') return Number(v);
    return String(v);
  };
  const filasF = crudas.map((r) => Object.fromEntries(columnas.map((c) => [c.clave, formatear(c.tipo, r[c.clave])])));
  const sumables = columnas.filter((c) => c.tipo === 'importe' || c.tipo === 'entero');
  const conMoneda = columnas.some((c) => c.clave === 'moneda');
  const monedas = conMoneda ? [...new Set(filasF.map((f) => String(f.moneda)))].sort().reverse() : ['*'];
  const totales = sumables.length && filasF.length
    ? monedas.map((m) => {
        const grupo = filasF.filter((f) => m === '*' || f.moneda === m);
        const t: Record<string, string | number | null> = { [columnas[0]!.clave]: 'Total', ...(conMoneda ? { moneda: m } : {}) };
        for (const c of sumables) t[c.clave] = c.tipo === 'entero' ? grupo.reduce((a, f) => a + Number(f[c.clave] ?? 0), 0) : aImporte(grupo.reduce((a, f) => a.plus(dec(f[c.clave] as string)), dec(0)));
        return t;
      })
    : [];
  return { titulo, subtitulo, columnas, filas: filasF, totales, notas };
}

const NOTA_NETAS = 'Ventas netas: las notas de crédito restan y las de débito suman (se atribuyen a la venta que modifican). No incluye ventas anuladas.';

export async function reporteVentas(sucursalIds: number[], f: FiltroReporte & { desde: string; hasta: string }): Promise<ReporteDto> {
  const a: Ambito = { sucursalIds, desde: f.desde, hasta: f.hasta, moneda: f.moneda };
  const sub = `Del ${f.desde} al ${f.hasta}${f.moneda ? ` · ${f.moneda}` : ''}`;
  const titulo = `Ventas por ${AGRUPACIONES_VENTAS[f.agrupar].toLowerCase()}`;
  const comunes = [col('moneda', 'Moneda'), col('ventas', 'Ventas', 'entero'), col('bruto', 'Vendido', 'importe'), col('notas', 'Notas', 'importe'), col('neto', 'Neto', 'importe')];
  const agregados = `COUNT(CASE WHEN x.nota = 0 THEN 1 END) AS ventas, SUM(CASE WHEN x.nota = 0 THEN x.importe ELSE 0 END) AS bruto,
                     SUM(CASE WHEN x.nota = 1 THEN x.importe ELSE 0 END) AS notas, SUM(x.importe) AS neto`;
  const d = documentosNetos(a);

  const porDimension: Record<Exclude<AgrupacionVentas, 'producto' | 'metodo'>, { select: string; join: string; group: string; orden: string; columnas: Columnas }> = {
    dia: { select: "DATE_FORMAT(x.dia, '%Y-%m-%d') AS dia", join: '', group: 'x.dia, x.moneda', orden: 'x.dia, x.moneda DESC', columnas: [col('dia', 'Día', 'fecha')] },
    cliente: {
      select: "COALESCE(cl.razon_social, 'Clientes varios') AS cliente, COALESCE(cl.num_doc, '') AS documento",
      join: 'LEFT JOIN clientes cl ON cl.id = x.cliente_id',
      group: 'x.cliente_id, cl.razon_social, cl.num_doc, x.moneda',
      orden: 'neto DESC',
      columnas: [col('cliente', 'Cliente'), col('documento', 'Documento')],
    },
    usuario: { select: "COALESCE(u.nombre, 'Sin vendedor') AS vendedor", join: 'LEFT JOIN usuarios u ON u.id = x.usuario_id', group: 'x.usuario_id, u.nombre, x.moneda', orden: 'neto DESC', columnas: [col('vendedor', 'Vendedor')] },
    sucursal: { select: 's.nombre AS sucursal', join: 'JOIN sucursales s ON s.id = x.sucursal_id', group: 'x.sucursal_id, s.nombre, x.moneda', orden: 's.nombre, x.moneda DESC', columnas: [col('sucursal', 'Sucursal')] },
  };

  if (f.agrupar === 'producto') {
    const l = lineasNetas(a);
    const r = await filas(
      db,
      `SELECT COALESCE(p.codigo, MAX(x.codigo), '') AS codigo, COALESCE(p.nombre, MAX(x.descripcion)) AS producto, x.moneda,
              SUM(CASE WHEN x.cantidad > 0 THEN x.cantidad ELSE 0 END) AS vendido, SUM(CASE WHEN x.cantidad < 0 THEN -x.cantidad ELSE 0 END) AS devuelto,
              SUM(x.cantidad) AS cantidad, SUM(x.importe) AS neto
         FROM (${l.sql}) x LEFT JOIN productos p ON p.id = x.producto_id
        GROUP BY x.producto_id, p.codigo, p.nombre, IF(x.producto_id IS NULL, x.descripcion, NULL), x.moneda ORDER BY neto DESC`,
      l.bindings,
    );
    return armar(
      'Ventas por producto',
      sub,
      [col('codigo', 'Código'), col('producto', 'Producto'), col('moneda', 'Moneda'), col('vendido', 'Vendido', 'cantidad'), col('devuelto', 'Devuelto (NC)', 'cantidad'), col('cantidad', 'Cantidad neta', 'cantidad'), col('neto', 'Importe neto', 'importe')],
      r,
      [NOTA_NETAS, 'Las notas de débito sin producto (intereses, otros cargos) aparecen como una línea propia.'],
    );
  }
  if (f.agrupar === 'metodo') {
    const [ini, fin] = enUtc(f.desde, f.hasta);
    const r = await filas(
      db,
      `SELECT mp.nombre AS metodo, m.moneda,
              SUM(IF(m.tipo = 'venta', m.monto, 0)) AS ventas, SUM(IF(m.tipo = 'cobro', m.monto, 0)) AS cobros,
              SUM(IF(m.tipo = 'ingreso', m.monto, 0)) AS ingresos, SUM(IF(m.tipo = 'egreso', m.monto, 0)) AS egresos,
              SUM(IF(m.tipo IN ('devolucion','anulacion'), m.monto, 0)) AS devoluciones, SUM(m.monto) AS neto
         FROM movimientos_caja m JOIN turnos_caja t ON t.id = m.turno_id JOIN cajas cj ON cj.id = t.caja_id JOIN metodos_pago mp ON mp.id = m.metodo_pago_id
        WHERE cj.sucursal_id IN (${marcas(sucursalIds.length)}) AND m.fecha >= ? AND m.fecha < ?${f.moneda ? ' AND m.moneda = ?' : ''}
        GROUP BY mp.id, mp.nombre, m.moneda ORDER BY mp.nombre, m.moneda DESC`,
      [...sucursalIds, ini, fin, ...(f.moneda ? [f.moneda] : [])],
    );
    return armar(
      'Movimientos de caja por medio de pago',
      sub,
      [col('metodo', 'Medio'), col('moneda', 'Moneda'), col('ventas', 'Ventas', 'importe'), col('cobros', 'Cobros', 'importe'), col('ingresos', 'Ingresos', 'importe'), col('egresos', 'Egresos', 'importe'), col('devoluciones', 'Devoluciones', 'importe'), col('neto', 'Neto', 'importe')],
      r,
      ['Dinero que pasó por caja: los egresos y las devoluciones son negativos. Las ventas al crédito figuran en "Cobros" cuando se cobran.'],
    );
  }
  const dim = porDimension[f.agrupar];
  const r = await filas(db, `SELECT ${dim.select}, x.moneda, ${agregados} FROM (${d.sql}) x ${dim.join} GROUP BY ${dim.group} ORDER BY ${dim.orden}`, d.bindings);
  return armar(titulo, sub, [...dim.columnas, ...comunes], r, [NOTA_NETAS]);
}

const NOMBRE_TIPO: Record<string, string> = { '01': 'Factura', '03': 'Boleta', '07': 'Nota de crédito', '08': 'Nota de débito' };

export async function reporteComprobantes(sucursalIds: number[], f: { desde: string; hasta: string }): Promise<ReporteDto> {
  const r = await db('comprobantes')
    .whereIn('sucursal_id', sucursalIds)
    .whereBetween('fecha_emision', [f.desde, f.hasta])
    .groupBy('tipo_doc', 'estado', 'moneda', 'simulado')
    .orderBy(['tipo_doc', 'estado'])
    .select('tipo_doc', 'estado', 'moneda', 'simulado')
    .count({ n: '*' })
    .select(db.raw("SUM(IF(tipo_doc = '07', -total, total)) AS total"));
  return armar(
    'Comprobantes por tipo y estado',
    `Emitidos del ${f.desde} al ${f.hasta}`,
    [col('tipo', 'Tipo'), col('estado', 'Estado'), col('moneda', 'Moneda'), col('n', 'Cantidad', 'entero'), col('total', 'Importe', 'importe')],
    r.map((x: Record<string, unknown>) => ({ ...x, tipo: `${NOMBRE_TIPO[x.tipo_doc as string] ?? x.tipo_doc}${x.simulado ? ' (simulado)' : ''}` })),
    ['Las notas de crédito figuran en negativo. Los totales suman todos los estados: filtra los aceptados para cuadrar con SUNAT.'],
  );
}

export async function reporteInventario(sucursalIds: number[]): Promise<ReporteDto> {
  const r = await db('stock as st')
    .join('productos as p', 'p.id', 'st.producto_id')
    .join('sucursales as s', 's.id', 'st.sucursal_id')
    .join('unidades as u', 'u.id', 'p.unidad_id')
    .whereIn('st.sucursal_id', sucursalIds)
    .where('p.inventariable', true)
    .where('st.cantidad', '<>', 0)
    .orderBy(['s.nombre', 'p.nombre'])
    .select('s.nombre as sucursal', 'p.codigo', 'p.nombre as producto', 'u.codigo_sunat as unidad', 'st.cantidad as stock', 'p.costo_promedio as costo', db.raw('ROUND(st.cantidad * p.costo_promedio, 2) AS valor'));
  return armar(
    'Inventario valorizado',
    `Al ${fechaLima()} · costo promedio en soles`,
    [col('sucursal', 'Sucursal'), col('codigo', 'Código'), col('producto', 'Producto'), col('unidad', 'Unidad'), col('stock', 'Stock', 'cantidad'), col('costo', 'Costo promedio', 'importe'), col('valor', 'Valor', 'importe')],
    r,
  );
}

export async function reporteCompras(sucursalIds: number[], f: { desde: string; hasta: string }): Promise<ReporteDto> {
  const r = await db('compras as c')
    .join('proveedores as p', 'p.id', 'c.proveedor_id')
    .whereIn('c.sucursal_id', sucursalIds)
    .where('c.estado', 'registrada')
    .whereBetween('c.fecha', [f.desde, f.hasta])
    .groupBy('p.id', 'p.razon_social', 'p.num_doc', 'c.moneda')
    .orderBy('total', 'desc')
    .select('p.razon_social as proveedor', 'p.num_doc as documento', 'c.moneda')
    .count({ n: '*' })
    .sum({ subtotal: 'c.subtotal', igv: 'c.igv', total: 'c.total' });
  return armar(
    'Compras por proveedor',
    `Del ${f.desde} al ${f.hasta} · sin anuladas`,
    [col('proveedor', 'Proveedor'), col('documento', 'Documento'), col('moneda', 'Moneda'), col('n', 'Compras', 'entero'), col('subtotal', 'Subtotal', 'importe'), col('igv', 'IGV', 'importe'), col('total', 'Total', 'importe')],
    r,
  );
}

export async function reporteCaja(sucursalIds: number[], f: { desde: string; hasta: string }): Promise<ReporteDto> {
  const [ini, fin] = enUtc(f.desde, f.hasta);
  const r = await db('turnos_caja as t')
    .join('cajas as c', 'c.id', 't.caja_id')
    .join('sucursales as s', 's.id', 'c.sucursal_id')
    .join('turno_saldos as ts', 'ts.turno_id', 't.id')
    .join('usuarios as ua', 'ua.id', 't.usuario_apertura_id')
    .leftJoin('usuarios as uc', 'uc.id', 't.usuario_cierre_id')
    .whereIn('c.sucursal_id', sucursalIds)
    .where('t.estado', 'cerrado')
    .where('t.cerrado_en', '>=', ini)
    .where('t.cerrado_en', '<', fin)
    .orderBy([{ column: 't.cerrado_en', order: 'desc' }, { column: 'ts.moneda', order: 'desc' }])
    .select(
      't.id as turno',
      db.raw(`CONCAT(s.nombre, ' · ', c.nombre) AS caja`),
      db.raw(`DATE_FORMAT(t.abierto_en - ${LIMA}, '%Y-%m-%d %H:%i') AS apertura`),
      db.raw(`DATE_FORMAT(t.cerrado_en - ${LIMA}, '%Y-%m-%d %H:%i') AS cierre`),
      'ua.nombre as abrio',
      'uc.nombre as cerro',
      'ts.moneda',
      'ts.monto_inicial as inicial',
      'ts.esperado',
      'ts.contado',
      'ts.diferencia',
    );
  return armar(
    'Cierres de caja',
    `Turnos cerrados del ${f.desde} al ${f.hasta}`,
    [col('turno', 'Turno', 'entero'), col('caja', 'Caja'), col('apertura', 'Apertura'), col('cierre', 'Cierre'), col('abrio', 'Abrió'), col('cerro', 'Cerró'), col('moneda', 'Moneda'), col('inicial', 'Inicial', 'importe'), col('esperado', 'Esperado', 'importe'), col('contado', 'Contado', 'importe'), col('diferencia', 'Diferencia', 'importe')],
    r,
    ['Efectivo por moneda. Diferencia = contado − esperado (negativo = faltante).'],
  );
}

export async function reporteCxc(sucursalIds: number[]): Promise<ReporteDto> {
  const hoy = fechaLima();
  const r = await filas(
    db,
    `SELECT cl.razon_social AS cliente, cl.num_doc AS documento, x.moneda, SUM(q.saldo) AS saldo,
            SUM(IF(q.fecha_vencimiento >= ?, q.saldo, 0)) AS por_vencer,
            SUM(IF(DATEDIFF(?, q.fecha_vencimiento) BETWEEN 1 AND 30, q.saldo, 0)) AS d30,
            SUM(IF(DATEDIFF(?, q.fecha_vencimiento) BETWEEN 31 AND 60, q.saldo, 0)) AS d60,
            SUM(IF(DATEDIFF(?, q.fecha_vencimiento) BETWEEN 61 AND 90, q.saldo, 0)) AS d90,
            SUM(IF(DATEDIFF(?, q.fecha_vencimiento) > 90, q.saldo, 0)) AS mas90
       FROM cuotas q JOIN cuentas_por_cobrar x ON x.id = q.cxc_id JOIN clientes cl ON cl.id = x.cliente_id JOIN ventas v ON v.id = x.venta_id
      WHERE q.estado IN ('pendiente','parcial') AND x.estado IN ('pendiente','parcial') AND v.sucursal_id IN (${marcas(sucursalIds.length)})
      GROUP BY cl.id, cl.razon_social, cl.num_doc, x.moneda ORDER BY saldo DESC`,
    [hoy, hoy, hoy, hoy, hoy, ...sucursalIds],
  );
  return armar(
    'Cuentas por cobrar por antigüedad',
    `Al ${hoy} · días de atraso por cuota`,
    [col('cliente', 'Cliente'), col('documento', 'Documento'), col('moneda', 'Moneda'), col('saldo', 'Saldo', 'importe'), col('por_vencer', 'Por vencer', 'importe'), col('d30', '1–30 días', 'importe'), col('d60', '31–60', 'importe'), col('d90', '61–90', 'importe'), col('mas90', 'Más de 90', 'importe')],
    r,
  );
}

/** CSV para Excel: UTF-8 con BOM, coma como separador y punto decimal. */
export function aCsv(r: ReporteDto): string {
  const celda = (v: unknown, texto = true) => {
    let t = v == null ? '' : String(v);
    // Inyección de fórmulas: un texto que empieza con = + - @ (p. ej. el nombre de un cliente) se
    // ejecutaría al abrirlo en Excel; se antepone un apóstrofo. Los números quedan como están.
    if (texto && /^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const linea = (f: Record<string, unknown>) => r.columnas.map((c) => celda(f[c.clave], c.tipo === 'texto' || c.tipo === 'fecha')).join(',');
  return `﻿${[r.titulo, r.subtitulo].map((x) => celda(x)).join('\r\n')}\r\n\r\n${r.columnas.map((c) => celda(c.titulo)).join(',')}\r\n${[...r.filas, ...r.totales].map(linea).join('\r\n')}\r\n`;
}

// ---------- Auditoría ----------

const json = (v: unknown) => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return v; } })() : v);

export async function auditoria(f: FiltroAuditoria): Promise<Pagina<AuditoriaDto>> {
  const filtrar = (q: Knex.QueryBuilder) => {
    if (f.desde) q.where('a.creado_en', '>=', enUtc(f.desde, f.desde)[0]);
    if (f.hasta) q.where('a.creado_en', '<', enUtc(f.hasta, f.hasta)[1]);
    if (f.accion) q.where('a.accion', 'like', `${f.accion.replace(/[\\%_]/g, '')}%`);
    if (f.entidad) q.where('a.entidad', f.entidad);
    if (f.entidadId) q.where('a.entidad_id', f.entidadId);
    if (f.usuarioId) q.where((w) => w.where('a.usuario_id', f.usuarioId!).orWhere('a.operador_id', f.usuarioId!));
  };
  const [{ total }] = (await db('auditoria as a').modify(filtrar).count({ total: '*' })) as [{ total: number }];
  const r = await db('auditoria as a')
    .leftJoin('usuarios as u', 'u.id', 'a.usuario_id')
    .leftJoin('usuarios as o', 'o.id', 'a.operador_id')
    .leftJoin('sucursales as s', 's.id', 'a.sucursal_id')
    .modify(filtrar)
    .orderBy('a.id', 'desc')
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize)
    .select('a.*', 'u.nombre as usuario', 'o.nombre as operador', 's.nombre as sucursal');
  return {
    data: r.map((x: Record<string, unknown>) => ({
      id: Number(x.id),
      fecha: new Date(x.creado_en as string).toISOString(),
      usuario: (x.usuario as string | null) ?? null,
      operador: x.operador_id && x.operador_id !== x.usuario_id ? ((x.operador as string | null) ?? null) : null,
      sucursal: (x.sucursal as string | null) ?? null,
      accion: String(x.accion),
      entidad: String(x.entidad),
      entidadId: (x.entidad_id as string | null) ?? null,
      antes: json(x.antes) ?? null,
      despues: json(x.despues) ?? null,
      ip: (x.ip as string | null) ?? null,
    })),
    page: f.page,
    pageSize: f.pageSize,
    total: Number(total),
  };
}

export async function intentos(f: FiltroIntentos): Promise<Pagina<IntentoDto>> {
  const filtrar = (q: Knex.QueryBuilder) => {
    if (f.entidadTipo) q.where('entidad_tipo', f.entidadTipo);
    if (f.entidadId) q.where('entidad_id', f.entidadId);
    if (f.soloErrores) q.where((w) => w.whereNull('http_status').orWhere('http_status', '>=', 400));
  };
  const [{ total }] = (await db('integracion_intentos').modify(filtrar).count({ total: '*' })) as [{ total: number }];
  const r = await db('integracion_intentos').modify(filtrar).orderBy('id', 'desc').limit(f.pageSize).offset((f.page - 1) * f.pageSize).select('id', 'creado_en', 'operacion', 'metodo', 'ruta', 'entidad_tipo', 'entidad_id', 'http_status', 'duracion_ms', 'error');
  return {
    data: r.map((x: Record<string, unknown>) => ({
      id: Number(x.id),
      fecha: new Date(x.creado_en as string).toISOString(),
      operacion: String(x.operacion),
      metodo: String(x.metodo),
      ruta: String(x.ruta),
      entidadTipo: (x.entidad_tipo as string | null) ?? null,
      entidadId: x.entidad_id == null ? null : Number(x.entidad_id),
      httpStatus: x.http_status == null ? null : Number(x.http_status),
      duracionMs: x.duracion_ms == null ? null : Number(x.duracion_ms),
      error: (x.error as string | null) ?? null,
    })),
    page: f.page,
    pageSize: f.pageSize,
    total: Number(total),
  };
}
