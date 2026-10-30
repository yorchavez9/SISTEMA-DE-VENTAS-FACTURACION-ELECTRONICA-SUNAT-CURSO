import type { Knex } from 'knex';

// Comunicaciones de baja (RA) de facturas y notas. Las boletas se anulan con un resumen de
// anulación (tabla resumenes, tipo 'anulacion'). Los efectos (stock, deuda) se aplican cuando SUNAT
// confirma; el dinero de una venta al contado queda como reembolso pendiente en la venta.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('bajas', (t) => {
    t.bigIncrements('id');
    t.date('fecha_generacion').notNullable(); // fecha de emisión de los documentos dados de baja
    t.bigInteger('api_id').unsigned().unique();
    t.string('identifier', 30);
    t.enu('estado', ['enviado', 'aceptado', 'rechazado', 'error']).notNullable().defaultTo('enviado');
    t.string('motivo', 255).notNullable();
    t.string('sunat_codigo', 20);
    t.text('sunat_descripcion');
    t.text('ultimo_error');
    t.boolean('simulado').notNullable().defaultTo(false);
    t.specificType('idempotency_key', 'CHAR(36)').notNullable().unique();
    t.bigInteger('creado_por').unsigned().notNullable().references('usuarios.id');
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.specificType('updated_at', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
  });
  await knex.schema.createTable('baja_documentos', (t) => {
    t.bigInteger('baja_id').unsigned().notNullable().references('bajas.id').onDelete('CASCADE');
    t.bigInteger('comprobante_id').unsigned().notNullable().references('comprobantes.id');
    t.string('motivo', 255).notNullable();
    t.primary(['baja_id', 'comprobante_id']);
    t.index(['comprobante_id']);
  });
  await knex.schema.alterTable('ventas', (t) => {
    t.decimal('reembolso_pendiente', 14, 2).notNullable().defaultTo(0).after('motivo_anulacion');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('ventas', (t) => t.dropColumn('reembolso_pendiente'));
  await knex.schema.dropTableIfExists('baja_documentos');
  await knex.schema.dropTableIfExists('bajas');
}
