import type { Knex } from 'knex';

// Autorizaciones de supervisor por PIN: token de un solo uso, válido 2 minutos
// (docs/03-api-interna.md §2, POST /auth/pin/autorizar).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('autorizaciones', (t) => {
    t.bigIncrements('id');
    t.specificType('token_hash', 'CHAR(64)').notNullable().unique();
    t.bigInteger('autorizado_por').unsigned().notNullable().references('usuarios.id');
    t.bigInteger('solicitado_por').unsigned().notNullable().references('usuarios.id');
    t.bigInteger('dispositivo_id').unsigned().references('dispositivos.id');
    t.string('accion', 40).notNullable();
    t.specificType('expira_en', 'DATETIME(3)').notNullable();
    t.specificType('usado_en', 'DATETIME(3)');
    t.specificType('creado_en', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.index(['expira_en']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('autorizaciones');
}
