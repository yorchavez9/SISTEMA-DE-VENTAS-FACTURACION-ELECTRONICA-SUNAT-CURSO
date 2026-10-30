import type { Knex } from 'knex';

// Clientes y proveedores (docs/02-modelo-datos.md §5).

function tiempos(t: Knex.CreateTableBuilder, knex: Knex): void {
  t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
  t.specificType('updated_at', 'DATETIME(3)')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('clientes', (t) => {
    t.bigIncrements('id');
    t.specificType('tipo_doc', 'CHAR(1)').notNullable(); // Catálogo 06
    t.string('num_doc', 15).notNullable();
    t.string('razon_social', 255).notNullable();
    t.string('direccion', 255);
    t.specificType('ubigeo', 'CHAR(6)');
    t.string('email', 160);
    t.string('telefono', 30);
    t.decimal('limite_credito', 14, 2);
    t.specificType('moneda_credito', 'CHAR(3)');
    t.boolean('activo').notNullable().defaultTo(true);
    tiempos(t, knex);
    t.unique(['tipo_doc', 'num_doc']);
    t.index(['razon_social']);
  });
  await knex.raw(`
    ALTER TABLE clientes
      ADD CONSTRAINT ck_clientes_tipo CHECK (tipo_doc IN ('1','4','6','7','A')),
      ADD CONSTRAINT ck_clientes_credito CHECK (limite_credito IS NULL OR (limite_credito >= 0 AND moneda_credito IN ('PEN','USD')))
  `);

  await knex.schema.createTable('proveedores', (t) => {
    t.bigIncrements('id');
    t.specificType('tipo_doc', 'CHAR(1)').notNullable();
    t.string('num_doc', 15).notNullable();
    t.string('razon_social', 255).notNullable();
    t.string('direccion', 255);
    t.string('contacto', 120);
    t.string('email', 160);
    t.string('telefono', 30);
    t.boolean('activo').notNullable().defaultTo(true);
    tiempos(t, knex);
    t.unique(['tipo_doc', 'num_doc']);
    t.index(['razon_social']);
  });
  await knex.raw("ALTER TABLE proveedores ADD CONSTRAINT ck_proveedores_tipo CHECK (tipo_doc IN ('1','4','6','7','A'))");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('proveedores');
  await knex.schema.dropTableIfExists('clientes');
}
