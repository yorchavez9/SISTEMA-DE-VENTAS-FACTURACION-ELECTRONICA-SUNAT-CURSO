import type { Knex } from 'knex';

// El espejo de series guarda también la sucursal de API-PRO a la que pertenece cada serie,
// para poder mostrar las series de sucursales de API-PRO que aún no están vinculadas.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('series', (t) => {
    t.bigInteger('api_sucursal_id').unsigned().after('sucursal_id');
    t.specificType('api_cod_local', 'CHAR(4)').after('api_sucursal_id');
    t.index(['api_sucursal_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('series', (t) => {
    t.dropIndex(['api_sucursal_id']);
    t.dropColumn('api_cod_local');
    t.dropColumn('api_sucursal_id');
  });
}
