import type { Knex } from 'knex';

// Cobros de cuentas por cobrar (docs/02-modelo-datos.md §7). Un cobro puede pagar varias cuotas.

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('cobros', (t) => {
    t.bigIncrements('id');
    t.bigInteger('cliente_id').unsigned().notNullable().references('clientes.id');
    t.bigInteger('turno_id').unsigned().notNullable().references('turnos_caja.id');
    t.bigInteger('metodo_pago_id').unsigned().notNullable().references('metodos_pago.id');
    t.specificType('moneda', 'CHAR(3)').notNullable(); // moneda en la que pagó el cliente
    t.decimal('monto', 14, 2).notNullable();
    t.decimal('tipo_cambio', 10, 4).notNullable().defaultTo(1);
    t.string('referencia', 60);
    t.enu('estado', ['registrado', 'anulado']).notNullable().defaultTo('registrado');
    t.string('motivo_anulacion', 255);
    t.bigInteger('anulado_por').unsigned().references('usuarios.id');
    t.bigInteger('usuario_id').unsigned().notNullable().references('usuarios.id');
    t.specificType('idempotency_key', 'CHAR(36)').notNullable().unique();
    t.specificType('fecha', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.index(['cliente_id']);
  });
  await knex.raw("ALTER TABLE cobros ADD CONSTRAINT ck_cobros CHECK (monto > 0 AND moneda IN ('PEN','USD'))");

  await knex.schema.createTable('cobro_aplicaciones', (t) => {
    t.bigIncrements('id');
    t.bigInteger('cobro_id').unsigned().notNullable().references('cobros.id').onDelete('CASCADE');
    t.bigInteger('cuota_id').unsigned().notNullable().references('cuotas.id');
    t.decimal('monto', 14, 2).notNullable(); // en la moneda de la cuota
    t.unique(['cobro_id', 'cuota_id']);
  });
  await knex.raw('ALTER TABLE cobro_aplicaciones ADD CONSTRAINT ck_cobro_aplicaciones CHECK (monto > 0)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cobro_aplicaciones');
  await knex.schema.dropTableIfExists('cobros');
}
