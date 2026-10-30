import type { Knex } from 'knex';

// Índices para el dashboard y los reportes (fase 8): movimientos de caja por fecha, turnos
// cerrados por fecha de cierre y notas por tipo y fecha de emisión.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('movimientos_caja', (t) => t.index(['fecha'], 'ix_movimientos_caja_fecha'));
  await knex.schema.alterTable('turnos_caja', (t) => t.index(['estado', 'cerrado_en'], 'ix_turnos_cierre'));
  await knex.schema.alterTable('comprobantes', (t) => t.index(['tipo_doc', 'fecha_emision'], 'ix_comprobantes_tipo_fecha'));
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('comprobantes', (t) => t.dropIndex(['tipo_doc', 'fecha_emision'], 'ix_comprobantes_tipo_fecha'));
  await knex.schema.alterTable('turnos_caja', (t) => t.dropIndex(['estado', 'cerrado_en'], 'ix_turnos_cierre'));
  await knex.schema.alterTable('movimientos_caja', (t) => t.dropIndex(['fecha'], 'ix_movimientos_caja_fecha'));
}
