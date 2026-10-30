import type { Knex } from 'knex';

// Resumen diario de boletas (RC). El RC de API-PRO es por empresa y fecha: toma todas las boletas
// "pendiente" del RUC en esa fecha, por eso antes de enviarlo se comprueba que todas sean de este
// sistema (docs/00-plan-implementacion.md §0.10-b).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('resumenes', (t) => {
    t.bigIncrements('id');
    t.enu('tipo', ['envio', 'anulacion']).notNullable();
    t.date('fecha_resumen').notNullable();
    t.bigInteger('api_id').unsigned().unique();
    t.string('identifier', 30);
    t.enu('estado', ['verificando', 'bloqueado', 'enviado', 'aceptado', 'rechazado', 'error']).notNullable().defaultTo('verificando');
    t.boolean('incidente').notNullable().defaultTo(false); // el RC incluyó boletas ajenas (carrera)
    t.json('bloqueo_detalle');
    t.json('documentos_api');
    t.string('sunat_codigo', 20);
    t.text('sunat_descripcion');
    t.text('ultimo_error');
    t.boolean('simulado').notNullable().defaultTo(false);
    t.specificType('idempotency_key', 'CHAR(36)').notNullable().unique();
    t.bigInteger('creado_por').unsigned().references('usuarios.id'); // NULL = envío automático
    t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.specificType('updated_at', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
    t.index(['fecha_resumen', 'tipo']);
  });
  // Un solo resumen de envío en curso por fecha (impide dos envíos simultáneos).
  await knex.raw(`
    ALTER TABLE resumenes
      ADD COLUMN activo_clave VARCHAR(30) AS (IF(estado IN ('verificando','enviado'), CONCAT(tipo, ':', fecha_resumen), NULL)) VIRTUAL,
      ADD UNIQUE KEY uq_resumen_activo (activo_clave)
  `);

  await knex.schema.createTable('resumen_documentos', (t) => {
    t.bigInteger('resumen_id').unsigned().notNullable().references('resumenes.id').onDelete('CASCADE');
    t.bigInteger('comprobante_id').unsigned().notNullable().references('comprobantes.id');
    t.string('motivo', 255);
    t.primary(['resumen_id', 'comprobante_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('resumen_documentos');
  await knex.schema.dropTableIfExists('resumenes');
}
