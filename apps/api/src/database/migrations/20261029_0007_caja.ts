import type { Knex } from 'knex';

// Caja y turnos (docs/02-modelo-datos.md §6). Saldos separados por moneda (PEN y USD).

function tiempos(t: Knex.CreateTableBuilder, knex: Knex): void {
  t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
  t.specificType('updated_at', 'DATETIME(3)')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('metodos_pago', (t) => {
    t.bigIncrements('id');
    t.string('codigo', 20).notNullable().unique();
    t.string('nombre', 60).notNullable();
    t.enu('tipo', ['efectivo', 'tarjeta', 'billetera', 'transferencia', 'otro']).notNullable();
    t.boolean('requiere_referencia').notNullable().defaultTo(false);
    t.boolean('activo').notNullable().defaultTo(true);
    t.smallint('orden').notNullable().defaultTo(0);
  });

  await knex.schema.createTable('cajas', (t) => {
    t.bigIncrements('id');
    t.bigInteger('sucursal_id').unsigned().notNullable().references('sucursales.id');
    t.string('nombre', 60).notNullable();
    t.boolean('activo').notNullable().defaultTo(true);
    tiempos(t, knex);
    t.unique(['sucursal_id', 'nombre']);
  });

  await knex.schema.createTable('turnos_caja', (t) => {
    t.bigIncrements('id');
    t.bigInteger('caja_id').unsigned().notNullable().references('cajas.id');
    t.bigInteger('usuario_apertura_id').unsigned().notNullable().references('usuarios.id');
    t.specificType('abierto_en', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.bigInteger('usuario_cierre_id').unsigned().references('usuarios.id');
    t.specificType('cerrado_en', 'DATETIME(3)');
    t.enu('estado', ['abierto', 'cerrado']).notNullable().defaultTo('abierto');
    t.string('nota_cierre', 255);
    t.specificType('idempotency_key', 'CHAR(36)').notNullable().unique();
    tiempos(t, knex);
  });
  // Un solo turno abierto por caja.
  await knex.raw(`
    ALTER TABLE turnos_caja
      ADD COLUMN abierto_flag TINYINT AS (IF(estado = 'abierto', 1, NULL)) VIRTUAL,
      ADD UNIQUE KEY uq_turno_abierto (caja_id, abierto_flag)
  `);

  await knex.schema.createTable('turno_saldos', (t) => {
    t.bigInteger('turno_id').unsigned().notNullable().references('turnos_caja.id').onDelete('CASCADE');
    t.specificType('moneda', 'CHAR(3)').notNullable();
    t.decimal('monto_inicial', 14, 2).notNullable().defaultTo(0);
    t.decimal('esperado', 14, 2); // efectivo esperado al cerrar
    t.decimal('contado', 14, 2);
    t.decimal('diferencia', 14, 2);
    t.primary(['turno_id', 'moneda']);
  });
  await knex.raw("ALTER TABLE turno_saldos ADD CONSTRAINT ck_turno_saldos CHECK (moneda IN ('PEN','USD') AND monto_inicial >= 0 AND (contado IS NULL OR contado >= 0))");

  await knex.schema.createTable('movimientos_caja', (t) => {
    t.bigIncrements('id');
    t.bigInteger('turno_id').unsigned().notNullable().references('turnos_caja.id');
    t.enu('tipo', ['venta', 'cobro', 'ingreso', 'egreso', 'devolucion', 'anulacion']).notNullable();
    t.bigInteger('metodo_pago_id').unsigned().notNullable().references('metodos_pago.id');
    t.specificType('moneda', 'CHAR(3)').notNullable();
    t.decimal('monto', 14, 2).notNullable(); // con signo: + entra, − sale
    t.string('concepto', 255).notNullable();
    t.string('referencia', 60);
    t.string('origen_tipo', 30).notNullable();
    t.bigInteger('origen_id').unsigned();
    t.specificType('idempotency_key', 'CHAR(36)').unique(); // movimientos manuales
    t.bigInteger('usuario_id').unsigned().notNullable().references('usuarios.id');
    t.specificType('fecha', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.index(['turno_id']);
    // Un documento de origen no registra dos veces el mismo pago (NULL en origen_id = movimiento manual).
    t.unique(['origen_tipo', 'origen_id', 'tipo', 'metodo_pago_id', 'moneda'], { indexName: 'uq_movimiento_caja_origen' });
  });
  await knex.raw("ALTER TABLE movimientos_caja ADD CONSTRAINT ck_movimientos_caja CHECK (moneda IN ('PEN','USD') AND monto <> 0)");
}

export async function down(knex: Knex): Promise<void> {
  for (const tabla of ['movimientos_caja', 'turno_saldos', 'turnos_caja', 'cajas', 'metodos_pago']) await knex.schema.dropTableIfExists(tabla);
}
