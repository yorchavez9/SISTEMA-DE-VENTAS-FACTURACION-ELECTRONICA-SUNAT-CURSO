import type { Knex } from 'knex';

// Catálogo e inventario (docs/02-modelo-datos.md §4).
// stock tiene CHECK (cantidad >= 0): segunda barrera contra el stock negativo (ADR-18).

function tiempos(t: Knex.CreateTableBuilder, knex: Knex): void {
  t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
  t.specificType('updated_at', 'DATETIME(3)')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('categorias', (t) => {
    t.bigIncrements('id');
    t.string('nombre', 80).notNullable().unique();
    t.boolean('activo').notNullable().defaultTo(true);
    tiempos(t, knex);
  });

  await knex.schema.createTable('unidades', (t) => {
    t.bigIncrements('id');
    t.string('codigo_sunat', 3).notNullable().unique(); // Catálogo 03 (lista aceptada por API-PRO)
    t.string('nombre', 60).notNullable();
    t.boolean('fraccionable').notNullable().defaultTo(false);
    t.boolean('activo').notNullable().defaultTo(true);
  });

  await knex.schema.createTable('productos', (t) => {
    t.bigIncrements('id');
    t.string('codigo', 30).notNullable().unique();
    t.string('codigo_barras', 50).unique();
    t.string('nombre', 200).notNullable();
    t.string('descripcion', 500);
    t.bigInteger('categoria_id').unsigned().references('categorias.id');
    t.bigInteger('unidad_id').unsigned().notNullable().references('unidades.id');
    t.enu('tipo', ['bien', 'servicio']).notNullable().defaultTo('bien');
    t.boolean('inventariable').notNullable().defaultTo(true);
    t.specificType('tip_afe_igv', 'CHAR(2)').notNullable().defaultTo('10');
    t.specificType('cod_producto_sunat', 'CHAR(8)');
    t.decimal('precio_venta', 16, 6).notNullable(); // PEN; con IGV si la afectación es 10
    t.decimal('precio_venta_usd', 16, 6);
    t.decimal('costo_promedio', 16, 6).notNullable().defaultTo(0);
    t.decimal('stock_minimo', 14, 3).notNullable().defaultTo(0);
    t.decimal('peso_kg', 10, 3);
    t.boolean('activo').notNullable().defaultTo(true);
    tiempos(t, knex);
    t.index(['categoria_id']);
    t.index(['nombre']);
  });
  await knex.raw(`
    ALTER TABLE productos
      ADD CONSTRAINT ck_productos_precio CHECK (precio_venta >= 0 AND (precio_venta_usd IS NULL OR precio_venta_usd >= 0) AND costo_promedio >= 0),
      ADD CONSTRAINT ck_productos_minimo CHECK (stock_minimo >= 0),
      ADD CONSTRAINT ck_productos_afectacion CHECK (tip_afe_igv IN ('10','20','30')),
      ADD CONSTRAINT ck_productos_servicio CHECK (tipo = 'bien' OR inventariable = 0),
      ADD FULLTEXT INDEX ft_productos (nombre, descripcion)
  `);

  await knex.schema.createTable('stock', (t) => {
    t.bigInteger('producto_id').unsigned().notNullable().references('productos.id');
    t.bigInteger('sucursal_id').unsigned().notNullable().references('sucursales.id');
    t.decimal('cantidad', 14, 3).notNullable().defaultTo(0);
    t.specificType('updated_at', 'DATETIME(3)')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
    t.primary(['producto_id', 'sucursal_id']);
  });
  await knex.raw('ALTER TABLE stock ADD CONSTRAINT ck_stock_no_negativo CHECK (cantidad >= 0)');

  await knex.schema.createTable('movimientos_stock', (t) => {
    t.bigIncrements('id');
    t.bigInteger('producto_id').unsigned().notNullable().references('productos.id');
    t.bigInteger('sucursal_id').unsigned().notNullable().references('sucursales.id');
    t.enu('tipo', [
      'stock_inicial', 'compra', 'venta', 'devolucion_nc', 'anulacion', 'ajuste_entrada', 'ajuste_salida',
      'traslado_salida', 'traslado_entrada', 'anulacion_compra', 'anulacion_traslado',
    ]).notNullable();
    t.decimal('cantidad', 14, 3).notNullable(); // con signo
    t.decimal('costo_unitario', 16, 6);
    t.decimal('stock_resultante', 14, 3).notNullable();
    t.string('origen_tipo', 30).notNullable();
    t.bigInteger('origen_id').unsigned().notNullable();
    t.bigInteger('usuario_id').unsigned();
    t.string('nota', 255);
    t.specificType('fecha', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    // Un mismo origen nunca mueve dos veces el mismo producto con el mismo tipo.
    t.unique(['origen_tipo', 'origen_id', 'producto_id', 'tipo'], { indexName: 'uq_movimiento_origen' });
    t.index(['producto_id', 'sucursal_id', 'fecha']);
  });

  await knex.schema.createTable('ajustes_inventario', (t) => {
    t.bigIncrements('id');
    t.bigInteger('sucursal_id').unsigned().notNullable().references('sucursales.id');
    t.bigInteger('usuario_id').unsigned().notNullable().references('usuarios.id');
    t.enu('tipo', ['ajuste', 'stock_inicial']).notNullable().defaultTo('ajuste');
    t.string('motivo', 255).notNullable();
    t.specificType('idempotency_key', 'CHAR(36)').notNullable().unique();
    t.specificType('fecha', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
  });

  await knex.schema.createTable('ajuste_items', (t) => {
    t.bigIncrements('id');
    t.bigInteger('ajuste_id').unsigned().notNullable().references('ajustes_inventario.id').onDelete('CASCADE');
    t.bigInteger('producto_id').unsigned().notNullable().references('productos.id');
    t.decimal('cantidad', 14, 3).notNullable(); // con signo
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const tabla of ['ajuste_items', 'ajustes_inventario', 'movimientos_stock', 'stock', 'productos', 'unidades', 'categorias']) {
    await knex.schema.dropTableIfExists(tabla);
  }
}
