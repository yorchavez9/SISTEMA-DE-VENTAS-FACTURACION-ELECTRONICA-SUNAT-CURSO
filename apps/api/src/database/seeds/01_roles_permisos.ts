import type { Knex } from 'knex';

// Roles y permisos fijos del MVP (docs/03-api-interna.md §14).
// Idempotente: se puede ejecutar varias veces.

const PERMISOS: Array<[codigo: string, grupo: string, descripcion: string]> = [
  ['dashboard.ver', 'Dashboard', 'Ver el inicio y sus indicadores'],
  ['ventas.crear', 'Ventas', 'Registrar ventas en el POS'],
  ['ventas.ver', 'Ventas', 'Ver el historial de ventas'],
  ['ventas.credito', 'Ventas', 'Vender al crédito'],
  ['ventas.descuento', 'Ventas', 'Aplicar descuentos'],
  ['ventas.anular', 'Ventas', 'Anular ventas internamente'],
  ['boletas.elegir_modo', 'Ventas', 'Elegir envío individual o por resumen en el cobro'],
  ['caja.ver', 'Caja', 'Ver cajas y turnos'],
  ['caja.abrir', 'Caja', 'Abrir turno de caja'],
  ['caja.cerrar', 'Caja', 'Cerrar turno de caja'],
  ['caja.movimientos', 'Caja', 'Registrar ingresos y egresos de caja'],
  ['cxc.ver', 'Cuentas por cobrar', 'Ver la cartera de clientes'],
  ['cxc.cobrar', 'Cuentas por cobrar', 'Registrar cobros'],
  ['cxc.anular', 'Cuentas por cobrar', 'Anular cobros'],
  ['comprobantes.ver', 'Comprobantes', 'Ver comprobantes y descargar archivos'],
  ['comprobantes.emitir', 'Comprobantes', 'Reintentar y consultar emisiones'],
  ['comprobantes.corregir', 'Comprobantes', 'Corregir comprobantes rechazados'],
  ['comprobantes.anular', 'Comprobantes', 'Anular comprobantes (baja o resumen)'],
  ['notas.crear', 'Comprobantes', 'Emitir notas de crédito y débito'],
  ['resumenes.ver', 'Resumen diario', 'Ver resúmenes diarios'],
  ['resumenes.enviar', 'Resumen diario', 'Enviar resúmenes diarios'],
  ['guias.ver', 'Guías', 'Ver guías de remisión'],
  ['guias.crear', 'Guías', 'Emitir guías de remisión'],
  ['guias.maestros', 'Guías', 'Administrar transportistas, vehículos y conductores'],
  ['productos.ver', 'Catálogo', 'Ver productos'],
  ['productos.editar', 'Catálogo', 'Crear y editar productos y categorías'],
  ['clientes.ver', 'Catálogo', 'Ver clientes'],
  ['clientes.editar', 'Catálogo', 'Crear y editar clientes'],
  ['proveedores.ver', 'Catálogo', 'Ver proveedores'],
  ['proveedores.editar', 'Catálogo', 'Crear y editar proveedores'],
  ['inventario.ver', 'Inventario', 'Ver stock y kardex'],
  ['inventario.ajustar', 'Inventario', 'Ajustar inventario'],
  ['inventario.trasladar', 'Inventario', 'Trasladar entre sucursales'],
  ['compras.ver', 'Compras', 'Ver compras'],
  ['compras.crear', 'Compras', 'Registrar compras'],
  ['compras.anular', 'Compras', 'Anular compras'],
  ['reportes.ver', 'Reportes', 'Ver y exportar reportes'],
  ['usuarios.ver', 'Administración', 'Ver usuarios y roles'],
  ['usuarios.editar', 'Administración', 'Crear y editar usuarios'],
  ['config.ver', 'Administración', 'Ver la configuración'],
  ['config.editar', 'Administración', 'Editar la configuración y la conexión con la API'],
  ['sucursales.editar', 'Administración', 'Crear y editar sucursales'],
  ['series.ver', 'Administración', 'Ver series'],
  ['series.administrar', 'Administración', 'Crear y modificar series en API-PRO'],
  ['tipocambio.editar', 'Administración', 'Registrar el tipo de cambio'],
  ['auditoria.ver', 'Administración', 'Ver auditoría e intentos de integración'],
];

const ROLES: Record<string, { nombre: string; permisos: string[] | '*' }> = {
  admin: { nombre: 'Administrador', permisos: '*' },
  supervisor: {
    nombre: 'Supervisor',
    permisos: PERMISOS.map(([c]) => c).filter(
      (c) =>
        !c.startsWith('usuarios.') &&
        !c.startsWith('config.') &&
        !['sucursales.editar', 'series.administrar', 'auditoria.ver'].includes(c),
    ),
  },
  cajero: {
    nombre: 'Cajero',
    permisos: [
      'dashboard.ver', 'ventas.crear', 'ventas.ver',
      'caja.ver', 'caja.abrir', 'caja.cerrar', 'caja.movimientos',
      'cxc.ver', 'cxc.cobrar', 'comprobantes.ver', 'comprobantes.emitir',
      'productos.ver', 'clientes.ver', 'clientes.editar', 'proveedores.ver', 'inventario.ver',
    ],
  },
  almacen: {
    nombre: 'Almacén',
    permisos: [
      'dashboard.ver', 'guias.ver', 'guias.crear', 'guias.maestros',
      'productos.ver', 'productos.editar', 'clientes.ver', 'proveedores.ver', 'proveedores.editar',
      'inventario.ver', 'inventario.ajustar', 'inventario.trasladar', 'compras.ver', 'compras.crear',
    ],
  },
};

export async function seed(knex: Knex): Promise<void> {
  await knex('permisos')
    .insert(PERMISOS.map(([codigo, grupo, descripcion]) => ({ codigo, grupo, descripcion })))
    .onConflict('codigo')
    .merge(['grupo', 'descripcion']);

  await knex('roles')
    .insert(Object.entries(ROLES).map(([codigo, r]) => ({ codigo, nombre: r.nombre, sistema: true })))
    .onConflict('codigo')
    .merge(['nombre']);

  const permisos = await knex('permisos').select('id', 'codigo');
  const idPermiso = new Map(permisos.map((p: { id: number; codigo: string }) => [p.codigo, p.id]));
  const roles = await knex('roles').select('id', 'codigo');

  for (const rol of roles as Array<{ id: number; codigo: string }>) {
    const def = ROLES[rol.codigo];
    if (!def) continue;
    const codigos = def.permisos === '*' ? [...idPermiso.keys()] : def.permisos;
    await knex('rol_permisos').where({ rol_id: rol.id }).delete();
    await knex('rol_permisos').insert(
      codigos.map((c) => {
        const permisoId = idPermiso.get(c);
        if (!permisoId) throw new Error(`Permiso desconocido en el rol ${rol.codigo}: ${c}`);
        return { rol_id: rol.id, permiso_id: permisoId };
      }),
    );
  }
}
