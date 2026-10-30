import type { Knex } from 'knex';

// Compras (registro interno: no se emite comprobante electrónico propio) y traslados entre sucursales.
// docs/02-modelo-datos.md §4 y §5.

function tiempos(t: Knex.CreateTableBuilder, knex: Knex): void {
  t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
  t.specificType('updated_at', 'DATETIME(3)')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('compras', (t) => {
    t.bigIncrements('id');
    t.bigInteger('proveedor_id').unsigned().notNullable().references('proveedores.id');
    t.bigInteger('sucursal_id').unsigned().notNullable().references('sucursales.id');
    t.specificType('tipo_doc_compra', 'CHAR(2)').notNullable(); // 01 factura, 03 boleta, 12 ticket, 00 otro
    t.string('serie_numero', 20).notNullable();
    t.date('fecha').notNullable();
    t.specificType('moneda', 'CHAR(3)').notNullable();
    t.decimal('tipo_cambio', 10, 4).notNullable().defaultTo(1);
    t.boolean('precios_incluyen_igv').notNullable();
    t.decimal('tasa_igv', 5, 2).notNullable();
    t.decimal('subtotal', 14, 2).notNullable();
    t.decimal('igv', 14, 2).notNullable();
    t.decimal('total', 14, 2).notNullable();
    t.enu('estado', ['registrada', 'anulada']).notNullable().defaultTo('registrada');
    t.string('nota', 255);
    t.string('motivo_anulacion', 255);
    t.bigInteger('usuario_id').unsigned().notNullable().references('usuarios.id');
    t.bigInteger('anulada_por').unsigned().references('usuarios.id');
    t.specificType('anulada_en', 'DATETIME(3)');
    t.specificType('idempotency_key', 'CHAR(36)').notNullable().unique();
    tiempos(t, knex);
    // Evita registrar dos veces el mismo comprobante del proveedor.
    t.unique(['proveedor_id', 'tipo_doc_compra', 'serie_numero'], { indexName: 'uq_compra_documento' });
    t.index(['sucursal_id', 'fecha']);
  });
  await knex.raw(`
    ALTER TABLE compras
      ADD CONSTRAINT ck_compras_moneda CHECK (moneda IN ('PEN','USD')),
      ADD CONSTRAINT ck_compras_tipo CHECK (tipo_doc_compra IN ('01','03','12','00')),
      ADD CONSTRAINT ck_compras_importes CHECK (subtotal >= 0 AND igv >= 0 AND total >= 0 AND tipo_cambio > 0)
  `);

  await knex.schema.createTable('compra_items', (t) => {
    t.bigIncrements('id');
    t.bigInteger('compra_id').unsigned().notNullable().references('compras.id').onDelete('CASCADE');
    t.bigInteger('producto_id').unsigned().notNullable().references('productos.id');
    t.decimal('cantidad', 14, 3).notNullable();
    t.decimal('costo_unitario', 16, 6).notNullable(); // tal como figura en el comprobante, en la moneda de la compra
    t.decimal('costo_neto_pen', 16, 6).notNullable(); // costo que alimenta el kardex y el promedio
    t.decimal('total', 14, 2).notNullable();
  });
  await knex.raw('ALTER TABLE compra_items ADD CONSTRAINT ck_compra_items CHECK (cantidad > 0 AND costo_unitario >= 0)');

  await knex.schema.createTable('traslados', (t) => {
    t.bigIncrements('id');
    t.bigInteger('sucursal_origen_id').unsigned().notNullable().references('sucursales.id');
    t.bigInteger('sucursal_destino_id').unsigned().notNullable().references('sucursales.id');
    t.enu('estado', ['enviado', 'recibido', 'anulado']).notNullable().defaultTo('enviado');
    t.string('nota', 255);
    t.bigInteger('guia_id').unsigned(); // guía de remisión (fase 7e)
    t.bigInteger('enviado_por').unsigned().notNullable().references('usuarios.id');
    t.bigInteger('recibido_por').unsigned().references('usuarios.id');
    t.specificType('recibido_en', 'DATETIME(3)');
    t.specificType('idempotency_key', 'CHAR(36)').notNullable().unique();
    tiempos(t, knex);
    t.index(['sucursal_destino_id', 'estado']);
  });
  await knex.raw('ALTER TABLE traslados ADD CONSTRAINT ck_traslados_sucursales CHECK (sucursal_origen_id <> sucursal_destino_id)');

  await knex.schema.createTable('traslado_items', (t) => {
    t.bigIncrements('id');
    t.bigInteger('traslado_id').unsigned().notNullable().references('traslados.id').onDelete('CASCADE');
    t.bigInteger('producto_id').unsigned().notNullable().references('productos.id');
    t.decimal('cantidad', 14, 3).notNullable();
  });
  await knex.raw('ALTER TABLE traslado_items ADD CONSTRAINT ck_traslado_items CHECK (cantidad > 0)');
}

export async function down(knex: Knex): Promise<void> {
  for (const tabla of ['traslado_items', 'traslados', 'compra_items', 'compras']) await knex.schema.dropTableIfExists(tabla);
}
