import type { Knex } from 'knex';

// Imagen opcional del producto. Se guarda el nombre del archivo (en apps/api/storage/productos),
// que incluye un hash del contenido: la URL cambia con cada imagen nueva y se puede cachear.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('productos', (t) => {
    t.string('imagen', 100).after('peso_kg');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('productos', (t) => t.dropColumn('imagen'));
}
