import type { Knex } from 'knex';

// Proveedores para consultar DNI y RUC (json.pe y MIGO). El token se guarda cifrado con
// APP_ENC_KEY, igual que las credenciales de API-PRO; `orden` decide cuál se prueba primero.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('proveedores_documento', (t) => {
    t.string('codigo', 20).primary();
    t.boolean('activo').notNullable().defaultTo(false);
    t.tinyint('orden').unsigned().notNullable();
    t.specificType('token_enc', 'VARBINARY(1024)');
    t.specificType('updated_at', 'DATETIME(3)')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
  });
  await knex('proveedores_documento').insert([
    { codigo: 'jsonpe', orden: 1 },
    { codigo: 'migo', orden: 2 },
  ]);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('proveedores_documento');
}
