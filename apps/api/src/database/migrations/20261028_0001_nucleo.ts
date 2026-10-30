import type { Knex } from 'knex';

// Núcleo: empresa, sucursales, series (espejo de API-PRO), tipos de cambio,
// configuración, seguridad, auditoría, outbox e historial de integración.
// Referencia: docs/02-modelo-datos.md §2, §3, §8 (outbox/intentos) y §10.

function tiempos(t: Knex.CreateTableBuilder, knex: Knex): void {
  t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
  t.specificType('updated_at', 'DATETIME(3)')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('empresa', (t) => {
    t.bigIncrements('id');
    t.specificType('ruc', 'CHAR(11)').notNullable().unique();
    t.string('razon_social', 255).notNullable();
    t.string('nombre_comercial', 255);
    t.string('direccion_fiscal', 255);
    t.decimal('tasa_igv', 5, 2).notNullable().defaultTo(18);
    t.string('tax_regime', 20);
    t.string('apipro_base_url', 255);
    t.specificType('apipro_key_enc', 'VARBINARY(512)');
    t.specificType('apipro_secret_enc', 'VARBINARY(512)');
    t.enu('apipro_entorno', ['beta', 'production']);
    t.enu('modo_emision', ['simulacion', 'real']).notNullable().defaultTo('simulacion');
    t.specificType('conexion_verificada_en', 'DATETIME(3)');
    tiempos(t, knex);
  });

  await knex.schema.createTable('sucursales', (t) => {
    t.bigIncrements('id');
    t.string('nombre', 120).notNullable();
    t.specificType('cod_local', 'CHAR(4)').notNullable().unique();
    t.bigInteger('api_sucursal_id').unsigned().unique();
    t.string('direccion', 255);
    t.specificType('ubigeo', 'CHAR(6)');
    t.string('telefono', 30);
    t.enu('modo_boletas', ['individual', 'resumen']).notNullable().defaultTo('individual');
    t.time('hora_resumen').notNullable().defaultTo('23:00:00');
    t.boolean('activo').notNullable().defaultTo(true);
    tiempos(t, knex);
  });

  await knex.schema.createTable('series', (t) => {
    t.bigIncrements('id');
    t.bigInteger('api_serie_id').unsigned().notNullable().unique();
    t.bigInteger('sucursal_id').unsigned().references('sucursales.id');
    t.specificType('tipo_doc', 'CHAR(2)').notNullable();
    t.specificType('serie', 'CHAR(4)').notNullable();
    t.enu('aplica_a', ['F', 'B']);
    t.boolean('propia').notNullable().defaultTo(false);
    t.integer('ultimo_correlativo').unsigned().notNullable().defaultTo(0);
    t.boolean('activo').notNullable().defaultTo(true);
    t.boolean('predeterminada').notNullable().defaultTo(false);
    t.specificType('sincronizado_en', 'DATETIME(3)');
    tiempos(t, knex);
    t.unique(['tipo_doc', 'serie']);
  });
  // Una sola serie predeterminada por (sucursal, tipo, aplica_a).
  await knex.raw(`
    ALTER TABLE series
      ADD COLUMN predeterminada_clave VARCHAR(40)
        AS (IF(predeterminada = 1, CONCAT(sucursal_id, '-', tipo_doc, '-', IFNULL(aplica_a, '-')), NULL)) VIRTUAL,
      ADD UNIQUE KEY uq_series_predeterminada (predeterminada_clave),
      ADD CONSTRAINT ck_series_tipo CHECK (tipo_doc IN ('01','03','07','08','09'))
  `);

  await knex.schema.createTable('tipos_cambio', (t) => {
    t.bigIncrements('id');
    t.date('fecha').notNullable().unique();
    t.decimal('compra', 10, 4).notNullable();
    t.decimal('venta', 10, 4).notNullable();
    t.enu('fuente', ['manual']).notNullable().defaultTo('manual');
    t.bigInteger('usuario_id').unsigned();
    tiempos(t, knex);
  });
  await knex.raw('ALTER TABLE tipos_cambio ADD CONSTRAINT ck_tc_positivo CHECK (compra > 0 AND venta > 0)');

  await knex.schema.createTable('configuracion', (t) => {
    t.string('clave', 80).primary();
    t.json('valor').notNullable();
    tiempos(t, knex);
  });

  await knex.schema.createTable('roles', (t) => {
    t.bigIncrements('id');
    t.string('codigo', 40).notNullable().unique();
    t.string('nombre', 80).notNullable();
    t.boolean('sistema').notNullable().defaultTo(true);
    tiempos(t, knex);
  });

  await knex.schema.createTable('permisos', (t) => {
    t.bigIncrements('id');
    t.string('codigo', 60).notNullable().unique();
    t.string('descripcion', 160).notNullable();
    t.string('grupo', 40).notNullable();
  });

  await knex.schema.createTable('rol_permisos', (t) => {
    t.bigInteger('rol_id').unsigned().notNullable().references('roles.id').onDelete('CASCADE');
    t.bigInteger('permiso_id').unsigned().notNullable().references('permisos.id').onDelete('CASCADE');
    t.primary(['rol_id', 'permiso_id']);
  });

  await knex.schema.createTable('usuarios', (t) => {
    t.bigIncrements('id');
    t.string('usuario', 40).notNullable().unique();
    t.string('nombre', 120).notNullable();
    t.string('email', 160);
    t.string('password_hash', 255).notNullable();
    t.string('pin_hash', 255);
    t.bigInteger('rol_id').unsigned().notNullable().references('roles.id');
    t.boolean('activo').notNullable().defaultTo(true);
    t.integer('intentos_fallidos').unsigned().notNullable().defaultTo(0);
    t.specificType('bloqueado_hasta', 'DATETIME(3)');
    t.integer('pin_intentos').unsigned().notNullable().defaultTo(0);
    t.specificType('pin_bloqueado_hasta', 'DATETIME(3)');
    t.boolean('debe_cambiar_password').notNullable().defaultTo(true);
    tiempos(t, knex);
  });

  await knex.schema.createTable('usuario_sucursales', (t) => {
    t.bigInteger('usuario_id').unsigned().notNullable().references('usuarios.id').onDelete('CASCADE');
    t.bigInteger('sucursal_id').unsigned().notNullable().references('sucursales.id');
    t.primary(['usuario_id', 'sucursal_id']);
  });

  await knex.schema.createTable('dispositivos', (t) => {
    t.bigIncrements('id');
    t.bigInteger('sucursal_id').unsigned().notNullable().references('sucursales.id');
    t.string('nombre', 80).notNullable();
    t.specificType('token_hash', 'CHAR(64)').notNullable().unique();
    t.boolean('activo').notNullable().defaultTo(true);
    t.specificType('ultimo_uso', 'DATETIME(3)');
    tiempos(t, knex);
  });

  await knex.schema.createTable('sesiones', (t) => {
    t.specificType('id', 'CHAR(64)').primary(); // hash SHA-256 del id de la cookie
    t.bigInteger('usuario_id').unsigned().notNullable().references('usuarios.id').onDelete('CASCADE');
    t.bigInteger('operador_id').unsigned().references('usuarios.id');
    t.bigInteger('dispositivo_id').unsigned().references('dispositivos.id');
    t.bigInteger('sucursal_id').unsigned().references('sucursales.id');
    t.specificType('csrf_token', 'CHAR(64)').notNullable();
    t.specificType('expira_en', 'DATETIME(3)').notNullable();
    t.specificType('ultimo_uso', 'DATETIME(3)').notNullable();
    t.string('ip', 45);
    t.string('user_agent', 255);
    tiempos(t, knex);
    t.index(['usuario_id']);
    t.index(['expira_en']);
  });

  await knex.schema.createTable('auditoria', (t) => {
    t.bigIncrements('id');
    t.bigInteger('usuario_id').unsigned(); // sin FK: el registro debe perdurar
    t.bigInteger('operador_id').unsigned();
    t.bigInteger('sucursal_id').unsigned();
    t.string('accion', 80).notNullable();
    t.string('entidad', 60).notNullable();
    t.string('entidad_id', 40);
    t.json('antes');
    t.json('despues');
    t.string('ip', 45);
    t.string('request_id', 40);
    t.specificType('creado_en', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.index(['entidad', 'entidad_id']);
    t.index(['creado_en']);
  });

  await knex.schema.createTable('outbox_trabajos', (t) => {
    t.bigIncrements('id');
    t.string('tipo', 40).notNullable();
    t.string('entidad_tipo', 30).notNullable();
    t.bigInteger('entidad_id').unsigned().notNullable();
    t.enu('estado', ['pendiente', 'en_proceso', 'hecho', 'fallido', 'pausado']).notNullable().defaultTo('pendiente');
    t.tinyint('prioridad').notNullable().defaultTo(5);
    t.integer('intentos').unsigned().notNullable().defaultTo(0);
    t.specificType('ejecutar_en', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.specificType('bloqueado_hasta', 'DATETIME(3)');
    t.text('ultimo_error');
    tiempos(t, knex);
    t.index(['estado', 'ejecutar_en']);
  });
  // Impide dos trabajos activos iguales para la misma entidad.
  await knex.raw(`
    ALTER TABLE outbox_trabajos
      ADD COLUMN activo_clave VARCHAR(120)
        AS (IF(estado IN ('pendiente','en_proceso','pausado'), CONCAT(tipo, ':', entidad_tipo, ':', entidad_id), NULL)) VIRTUAL,
      ADD UNIQUE KEY uq_outbox_activo (activo_clave)
  `);

  await knex.schema.createTable('integracion_intentos', (t) => {
    t.bigIncrements('id');
    t.string('entidad_tipo', 30);
    t.bigInteger('entidad_id').unsigned();
    t.string('operacion', 40).notNullable();
    t.string('metodo', 8).notNullable();
    t.string('ruta', 255).notNullable();
    t.specificType('idempotency_key', 'CHAR(36)');
    t.json('request_json');
    t.smallint('http_status');
    t.json('response_json');
    t.integer('duracion_ms').unsigned();
    t.text('error');
    t.specificType('creado_en', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.index(['entidad_tipo', 'entidad_id']);
    t.index(['creado_en']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const tabla of [
    'integracion_intentos',
    'outbox_trabajos',
    'auditoria',
    'sesiones',
    'dispositivos',
    'usuario_sucursales',
    'usuarios',
    'rol_permisos',
    'permisos',
    'roles',
    'configuracion',
    'tipos_cambio',
    'series',
    'sucursales',
    'empresa',
  ]) {
    await knex.schema.dropTableIfExists(tabla);
  }
}
