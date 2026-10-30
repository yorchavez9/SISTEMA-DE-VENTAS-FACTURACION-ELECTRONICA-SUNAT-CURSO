import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../database/db.js';
import { hashClave } from '../../shared/claves.js';
import { hayBaseDatos, prepararBdPrueba } from '../../test/bd.js';
import { dashboard, reporteVentas } from './reportes.service.js';

// Prueba de rendimiento de la fase 8 (100 000 ventas en 90 días). Es lenta: solo corre con
//   npm run test:rendimiento   (o PERF=1 npx vitest run …)
const N = 100_000;
const activa = (Boolean(process.env.PERF) || import.meta.env.MODE === 'rendimiento') && (await hayBaseDatos());

describe.skipIf(!activa)(`reportes con ${N} ventas`, () => {
  let sucursal: number;

  beforeAll(async () => {
    await prepararBdPrueba();
    sucursal = Number((await db('sucursales').insert({ nombre: 'Centro', cod_local: '0002' }))[0]);
    const rol = (await db('roles').where('codigo', 'admin').first('id')).id;
    const usuario = Number((await db('usuarios').insert({ usuario: 'admin', nombre: 'Admin', password_hash: await hashClave('Clave1234'), rol_id: rol }))[0]);
    const caja = Number((await db('cajas').insert({ sucursal_id: sucursal, nombre: 'Caja 1' }))[0]);
    const turno = Number((await db('turnos_caja').insert({ caja_id: caja, usuario_apertura_id: usuario, idempotency_key: '00000000-0000-0000-0000-000000000001' }))[0]);
    const unidad = (await db('unidades').where('codigo_sunat', 'NIU').first('id')).id;
    for (let p = 1; p <= 50; p++) await db('productos').insert({ codigo: `P${p}`, nombre: `Producto ${p}`, unidad_id: unidad, precio_venta: '10' });
    const efectivo = (await db('metodos_pago').where('codigo', 'EFECTIVO').first('id')).id;

    await db.raw('SET SESSION cte_max_recursion_depth = ?', [N + 10]);
    await db.raw(
      `INSERT INTO ventas (idempotency_key, sucursal_id, turno_id, usuario_id, fecha, moneda, forma_pago, tipo_comprobante, tasa_igv, subtotal, op_gravada, op_exonerada, op_inafecta, igv, total)
       WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       SELECT UUID(), ?, ?, ?, NOW(3) - INTERVAL (i % 90) DAY - INTERVAL (i % 600) MINUTE, IF(i % 10 = 0, 'USD', 'PEN'), 'contado', '03', 18, 10, 8.47, 0, 0, 1.53, 10 FROM n`,
      [N, sucursal, turno, usuario],
    );
    await db.raw(`INSERT INTO venta_items (venta_id, producto_id, codigo, descripcion, unidad, tip_afe_igv, cantidad, precio_lista, precio_unitario, valor_venta, igv, total)
                  SELECT v.id, 1 + v.id % 50, CONCAT('P', 1 + v.id % 50), 'Producto', 'NIU', '10', 1, 10, 10, 8.47, 1.53, 10 FROM ventas v`);
    await db.raw(`INSERT INTO movimientos_caja (turno_id, tipo, metodo_pago_id, moneda, monto, concepto, origen_tipo, origen_id, usuario_id, fecha)
                  SELECT v.turno_id, 'venta', ?, v.moneda, v.total, 'Venta', 'venta', v.id, v.usuario_id, v.fecha FROM ventas v`, [efectivo]);
    await db.raw('ANALYZE TABLE ventas, venta_items, movimientos_caja');
  }, 600_000);

  afterAll(async () => {
    await db.destroy();
  });

  const medir = async (fn: () => Promise<unknown>) => {
    const t = performance.now();
    await fn();
    return performance.now() - t;
  };

  it('dashboard en menos de 1,5 s', async () => {
    const ms = await medir(() => dashboard([sucursal]));
    console.info(`dashboard: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1500);
  });

  it('ventas de 90 días por día y por producto en menos de 3 s cada uno', async () => {
    const hoy = new Date().toISOString().slice(0, 10);
    const desde = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    for (const agrupar of ['dia', 'producto', 'metodo'] as const) {
      const ms = await medir(() => reporteVentas([sucursal], { desde, hasta: hoy, agrupar, formato: 'json' }));
      console.info(`ventas por ${agrupar}: ${ms.toFixed(0)} ms`);
      expect(ms).toBeLessThan(3000);
    }
  });
});
