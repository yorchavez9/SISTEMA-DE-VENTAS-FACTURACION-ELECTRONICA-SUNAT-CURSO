import type { Knex } from 'knex';

// Caché local de PDF, XML y CDR descargados de API-PRO (evita gastar el límite de 30 solicitudes/min).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('archivos_cpe', (t) => {
    t.bigIncrements('id');
    t.string('entidad_tipo', 30).notNullable();
    t.bigInteger('entidad_id').unsigned().notNullable();
    t.enu('tipo', ['pdf_a4', 'pdf_a5', 'pdf_t80', 'pdf_t58', 'xml', 'cdr']).notNullable();
    t.string('ruta', 255).notNullable();
    t.string('content_type', 60).notNullable();
    t.specificType('sha256', 'CHAR(64)').notNullable();
    t.integer('bytes').unsigned().notNullable();
    t.specificType('creado_en', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.unique(['entidad_tipo', 'entidad_id', 'tipo']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('archivos_cpe');
}
