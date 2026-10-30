import type { Knex } from 'knex';

// Notas de crédito (07) y débito (08). La nota es un comprobante más (tabla comprobantes); aquí se
// guarda su relación con el comprobante afectado y sus efectos (stock, caja, cuenta por cobrar).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('notas', (t) => {
    t.bigIncrements('id');
    t.bigInteger('comprobante_id').unsigned().notNullable().unique().references('comprobantes.id');
    t.bigInteger('comprobante_afectado_id').unsigned().notNullable().references('comprobantes.id');
    t.specificType('tipo', 'CHAR(2)').notNullable(); // 07 | 08
    t.specificType('cod_motivo', 'CHAR(2)').notNullable();
    t.string('des_motivo', 250).notNullable();
    t.boolean('devuelve_stock').notNullable().defaultTo(false);
    t.enu('reintegro', ['caja', 'cxc', 'ninguno']).notNullable().defaultTo('ninguno');
    t.specificType('idempotency_key', 'CHAR(36)').notNullable().unique();
    t.bigInteger('usuario_id').unsigned().notNullable().references('usuarios.id');
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.index(['comprobante_afectado_id']);
  });
  await knex.raw("ALTER TABLE notas ADD CONSTRAINT ck_notas_tipo CHECK (tipo IN ('07','08'))");
  // Las líneas de la NC por ítem apuntan a la línea original (para no acreditar dos veces lo mismo).
  await knex.schema.alterTable('comprobante_items', (t) => {
    t.bigInteger('comprobante_item_origen_id').unsigned().references('comprobante_items.id').after('venta_item_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('comprobante_items', (t) => {
    t.dropForeign(['comprobante_item_origen_id']);
    t.dropColumn('comprobante_item_origen_id');
  });
  await knex.schema.dropTableIfExists('notas');
}
