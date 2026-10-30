import type { Knex } from 'knex';

// Guía de remisión remitente (09), plan §0.6. La guía no mueve stock: lo mueve la venta o el
// traslado que la origina. Transportista, vehículo y conductores se guardan como instantánea en la
// guía (los datos maestros pueden cambiar después). Ubigeos: caché local del catálogo de API-PRO.

function tiempos(t: Knex.CreateTableBuilder, knex: Knex): void {
  t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
  t.specificType('updated_at', 'DATETIME(3)')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('transportistas', (t) => {
    t.bigIncrements('id');
    t.specificType('ruc', 'CHAR(11)').notNullable().unique();
    t.string('razon_social', 255).notNullable();
    t.string('nro_mtc', 20);
    t.boolean('activo').notNullable().defaultTo(true);
    tiempos(t, knex);
  });

  await knex.schema.createTable('vehiculos', (t) => {
    t.bigIncrements('id');
    t.string('placa', 8).notNullable().unique();
    t.string('nro_circulacion', 15);
    t.string('descripcion', 120);
    t.boolean('activo').notNullable().defaultTo(true);
    tiempos(t, knex);
  });

  await knex.schema.createTable('conductores', (t) => {
    t.bigIncrements('id');
    t.string('tipo_doc', 1).notNullable();
    t.string('num_doc', 15).notNullable();
    t.string('nombres', 100).notNullable();
    t.string('apellidos', 100).notNullable();
    t.string('licencia', 20).notNullable();
    t.boolean('activo').notNullable().defaultTo(true);
    tiempos(t, knex);
    t.unique(['tipo_doc', 'num_doc']);
  });

  await knex.schema.createTable('ubigeos', (t) => {
    t.string('codigo', 6).primary(); // 2 dígitos región, 4 provincia, 6 distrito
    t.enu('nivel', ['region', 'provincia', 'distrito']).notNullable();
    t.string('nombre', 120).notNullable();
    t.string('padre', 4);
    t.index(['nivel', 'padre']);
  });

  await knex.schema.createTable('guias', (t) => {
    t.bigIncrements('id');
    t.bigInteger('sucursal_id').unsigned().notNullable().references('sucursales.id');
    t.bigInteger('serie_id').unsigned().notNullable().references('series.id');
    t.specificType('serie', 'CHAR(4)').notNullable();
    t.integer('correlativo').unsigned();
    t.string('numero_completo', 20);
    t.date('fecha_emision').notNullable();
    t.enu('origen_tipo', ['venta', 'traslado', 'manual']).notNullable();
    t.bigInteger('comprobante_id').unsigned().references('comprobantes.id'); // comprobante de la venta de origen
    t.bigInteger('traslado_id').unsigned().references('traslados.id');
    t.string('destinatario_tipo_doc', 1).notNullable();
    t.string('destinatario_num_doc', 15).notNullable();
    t.string('destinatario_razon_social', 255).notNullable();
    t.specificType('cod_traslado', 'CHAR(2)').notNullable();
    t.specificType('mod_traslado', 'CHAR(2)').notNullable();
    t.boolean('vehiculo_m1l').notNullable().defaultTo(false);
    t.date('fecha_traslado').notNullable();
    t.date('fecha_entrega_transportista');
    t.decimal('peso_total', 12, 3).notNullable();
    t.string('und_peso_total', 3).notNullable().defaultTo('KGM');
    t.integer('num_bultos').unsigned();
    t.specificType('partida_ubigeo', 'CHAR(6)').notNullable();
    t.string('partida_direccion', 500).notNullable();
    t.specificType('partida_cod_local', 'CHAR(4)');
    t.specificType('llegada_ubigeo', 'CHAR(6)').notNullable();
    t.string('llegada_direccion', 500).notNullable();
    t.specificType('llegada_cod_local', 'CHAR(4)');
    t.json('transportista'); // {ruc, razon_social, nro_mtc}
    t.json('vehiculo'); // {placa, nro_circulacion, secundarios:[{placa}]}
    t.json('conductores'); // [{tipo, tipo_doc, num_doc, nombres, apellidos, licencia}]
    t.json('docs_relacionados'); // [{tipo_codigo, numero}]
    t.string('observacion', 500);
    t.enu('estado', ['pendiente', 'enviando', 'por_verificar', 'en_proceso', 'aceptado', 'rechazado', 'error_validacion', 'sin_respuesta_sunat']).notNullable().defaultTo('pendiente');
    t.bigInteger('api_id').unsigned().unique();
    t.string('ticket', 60);
    t.string('sunat_codigo', 20);
    t.text('sunat_descripcion');
    t.text('ultimo_error');
    t.integer('intentos').unsigned().notNullable().defaultTo(0);
    t.boolean('simulado').notNullable().defaultTo(false);
    t.specificType('idempotency_key', 'CHAR(36)').notNullable().unique();
    t.bigInteger('creado_por').unsigned().notNullable().references('usuarios.id');
    tiempos(t, knex);
    t.unique(['serie', 'correlativo', 'simulado'], { indexName: 'uq_guias_numero' });
    t.index(['sucursal_id', 'fecha_emision']);
    t.index(['estado']);
  });
  await knex.raw(`
    ALTER TABLE guias
      ADD CONSTRAINT ck_guias_mod CHECK (mod_traslado IN ('01','02')),
      ADD CONSTRAINT ck_guias_peso CHECK (peso_total > 0)
  `);

  await knex.schema.createTable('guia_items', (t) => {
    t.bigIncrements('id');
    t.bigInteger('guia_id').unsigned().notNullable().references('guias.id').onDelete('CASCADE');
    t.bigInteger('producto_id').unsigned().references('productos.id');
    t.string('codigo', 50);
    t.string('descripcion', 500).notNullable();
    t.string('unidad', 5).notNullable();
    t.decimal('cantidad', 14, 3).notNullable();
  });
  await knex.raw('ALTER TABLE guia_items ADD CONSTRAINT ck_guia_items CHECK (cantidad > 0)');

  await knex.schema.alterTable('traslados', (t) => {
    t.foreign('guia_id').references('guias.id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('traslados', (t) => t.dropForeign(['guia_id']));
  for (const tabla of ['guia_items', 'guias', 'ubigeos', 'conductores', 'vehiculos', 'transportistas']) await knex.schema.dropTableIfExists(tabla);
}
