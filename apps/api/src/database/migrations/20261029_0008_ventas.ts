import type { Knex } from 'knex';

// Ventas, pagos, cuentas por cobrar y comprobantes (docs/02-modelo-datos.md §7 y §8).
// La venta es el hecho comercial; el comprobante electrónico es su representación ante SUNAT.

function tiempos(t: Knex.CreateTableBuilder, knex: Knex): void {
  t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
  t.specificType('updated_at', 'DATETIME(3)')
    .notNullable()
    .defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
}

const ESTADOS_COMPROBANTE = [
  'pendiente', 'enviando', 'en_proceso', 'pendiente_resumen', 'en_resumen', 'aceptado', 'observado', 'rechazado',
  'error_validacion', 'por_verificar', 'sin_respuesta_sunat', 'anulacion_en_proceso', 'anulado', 'anulado_interno',
];

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('ventas', (t) => {
    t.bigIncrements('id');
    t.specificType('idempotency_key', 'CHAR(36)').notNullable().unique();
    t.bigInteger('sucursal_id').unsigned().notNullable().references('sucursales.id');
    t.bigInteger('turno_id').unsigned().notNullable().references('turnos_caja.id');
    t.bigInteger('usuario_id').unsigned().notNullable().references('usuarios.id'); // operador (cajero)
    t.bigInteger('cliente_id').unsigned().references('clientes.id'); // NULL = clientes varios
    t.specificType('fecha', 'DATETIME(3)').notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.specificType('moneda', 'CHAR(3)').notNullable();
    t.decimal('tipo_cambio', 10, 4).notNullable().defaultTo(1);
    t.enu('forma_pago', ['contado', 'credito']).notNullable();
    t.specificType('tipo_comprobante', 'CHAR(2)').notNullable();
    t.decimal('tasa_igv', 5, 2).notNullable();
    t.decimal('subtotal', 14, 2).notNullable();
    t.decimal('descuento', 14, 2).notNullable().defaultTo(0);
    t.string('descuento_motivo', 255);
    t.bigInteger('descuento_autorizado_por').unsigned().references('usuarios.id');
    t.decimal('op_gravada', 14, 2).notNullable();
    t.decimal('op_exonerada', 14, 2).notNullable();
    t.decimal('op_inafecta', 14, 2).notNullable();
    t.decimal('igv', 14, 2).notNullable();
    t.decimal('total', 14, 2).notNullable();
    t.enu('estado', ['confirmada', 'anulacion_en_proceso', 'anulada']).notNullable().defaultTo('confirmada');
    t.string('motivo_anulacion', 255);
    t.bigInteger('anulada_por').unsigned().references('usuarios.id');
    tiempos(t, knex);
    t.index(['sucursal_id', 'fecha']);
    t.index(['cliente_id']);
  });
  await knex.raw(`
    ALTER TABLE ventas
      ADD CONSTRAINT ck_ventas_moneda CHECK (moneda IN ('PEN','USD')),
      ADD CONSTRAINT ck_ventas_tipo CHECK (tipo_comprobante IN ('01','03')),
      ADD CONSTRAINT ck_ventas_importes CHECK (total > 0 AND descuento >= 0 AND igv >= 0 AND tipo_cambio > 0)
  `);

  await knex.schema.createTable('venta_items', (t) => {
    t.bigIncrements('id');
    t.bigInteger('venta_id').unsigned().notNullable().references('ventas.id').onDelete('CASCADE');
    t.bigInteger('producto_id').unsigned().notNullable().references('productos.id');
    // Instantánea: los cambios posteriores del producto no alteran la venta.
    t.string('codigo', 30).notNullable();
    t.string('descripcion', 255).notNullable();
    t.string('unidad', 3).notNullable();
    t.specificType('tip_afe_igv', 'CHAR(2)').notNullable();
    t.decimal('cantidad', 14, 3).notNullable();
    t.decimal('precio_lista', 16, 6).notNullable();
    t.decimal('precio_unitario', 16, 6).notNullable(); // con el descuento repartido; es el que va a SUNAT
    t.decimal('descuento', 14, 2).notNullable().defaultTo(0);
    t.decimal('valor_venta', 14, 2).notNullable();
    t.decimal('igv', 14, 2).notNullable();
    t.decimal('total', 14, 2).notNullable();
  });
  await knex.raw('ALTER TABLE venta_items ADD CONSTRAINT ck_venta_items CHECK (cantidad > 0 AND total > 0)');

  await knex.schema.createTable('pagos', (t) => {
    t.bigIncrements('id');
    t.bigInteger('venta_id').unsigned().notNullable().references('ventas.id').onDelete('CASCADE');
    t.bigInteger('metodo_pago_id').unsigned().notNullable().references('metodos_pago.id');
    t.specificType('moneda', 'CHAR(3)').notNullable();
    t.decimal('monto', 14, 2).notNullable(); // en la moneda del pago
    t.decimal('monto_en_moneda_venta', 14, 2).notNullable();
    t.decimal('monto_recibido', 14, 2);
    t.decimal('vuelto', 14, 2);
    t.string('referencia', 60);
  });

  await knex.schema.createTable('cuentas_por_cobrar', (t) => {
    t.bigIncrements('id');
    t.bigInteger('venta_id').unsigned().notNullable().unique().references('ventas.id');
    t.bigInteger('cliente_id').unsigned().notNullable().references('clientes.id');
    t.specificType('moneda', 'CHAR(3)').notNullable();
    t.decimal('total', 14, 2).notNullable();
    t.decimal('saldo', 14, 2).notNullable();
    t.enu('estado', ['pendiente', 'parcial', 'pagada', 'anulada']).notNullable().defaultTo('pendiente');
    t.date('vence_ultima').notNullable();
    tiempos(t, knex);
    t.index(['cliente_id', 'estado']);
  });
  await knex.raw('ALTER TABLE cuentas_por_cobrar ADD CONSTRAINT ck_cxc CHECK (saldo >= 0 AND saldo <= total)');

  await knex.schema.createTable('cuotas', (t) => {
    t.bigIncrements('id');
    t.bigInteger('cxc_id').unsigned().notNullable().references('cuentas_por_cobrar.id').onDelete('CASCADE');
    t.smallint('numero').notNullable();
    t.decimal('monto', 14, 2).notNullable();
    t.decimal('saldo', 14, 2).notNullable();
    t.date('fecha_vencimiento').notNullable();
    t.enu('estado', ['pendiente', 'parcial', 'pagada', 'anulada']).notNullable().defaultTo('pendiente');
    t.unique(['cxc_id', 'numero']);
    t.index(['fecha_vencimiento']);
  });
  await knex.raw('ALTER TABLE cuotas ADD CONSTRAINT ck_cuotas CHECK (monto > 0 AND saldo >= 0 AND saldo <= monto)');

  await knex.schema.createTable('comprobantes', (t) => {
    t.bigIncrements('id');
    t.bigInteger('sucursal_id').unsigned().notNullable().references('sucursales.id');
    t.bigInteger('venta_id').unsigned().references('ventas.id');
    t.specificType('tipo_doc', 'CHAR(2)').notNullable();
    t.bigInteger('serie_id').unsigned().notNullable().references('series.id');
    t.specificType('serie', 'CHAR(4)').notNullable();
    t.integer('correlativo').unsigned(); // lo asigna API-PRO
    t.string('numero_completo', 20);
    t.date('fecha_emision').notNullable(); // hora de Lima
    t.specificType('moneda', 'CHAR(3)').notNullable();
    t.decimal('tipo_cambio', 10, 4).notNullable().defaultTo(1);
    t.enu('forma_pago', ['contado', 'credito']).notNullable();
    // Instantánea del cliente
    t.specificType('cliente_tipo_doc', 'CHAR(1)').notNullable();
    t.string('cliente_num_doc', 15).notNullable();
    t.string('cliente_razon_social', 255).notNullable();
    t.string('cliente_direccion', 255);
    t.string('cliente_email', 160);
    t.decimal('op_gravada', 14, 2).notNullable();
    t.decimal('op_exonerada', 14, 2).notNullable();
    t.decimal('op_inafecta', 14, 2).notNullable();
    t.decimal('igv', 14, 2).notNullable();
    t.decimal('total', 14, 2).notNullable();
    t.decimal('total_api', 14, 2); // el que devuelve API-PRO, para conciliar
    t.enu('modo_envio', ['individual', 'resumen']).notNullable().defaultTo('individual');
    t.enu('estado', ESTADOS_COMPROBANTE).notNullable().defaultTo('pendiente');
    t.bigInteger('api_id').unsigned();
    t.string('sunat_codigo', 20);
    t.text('sunat_descripcion');
    t.json('sunat_notas');
    t.string('hash_cpe', 100);
    t.specificType('idempotency_key', 'CHAR(36)').notNullable().unique();
    t.integer('intentos').unsigned().notNullable().defaultTo(0);
    t.specificType('proximo_intento_en', 'DATETIME(3)');
    t.text('ultimo_error');
    t.boolean('simulado').notNullable().defaultTo(false);
    t.bigInteger('emitido_por').unsigned().notNullable().references('usuarios.id');
    tiempos(t, knex);
    t.unique(['tipo_doc', 'api_id']);
    t.unique(['serie', 'correlativo', 'simulado']);
    t.index(['estado', 'proximo_intento_en']);
    t.index(['sucursal_id', 'fecha_emision']);
    t.index(['venta_id']);
    t.index(['serie_id', 'estado']);
  });
  await knex.raw("ALTER TABLE comprobantes ADD CONSTRAINT ck_comprobantes_tipo CHECK (tipo_doc IN ('01','03','07','08'))");

  await knex.schema.createTable('comprobante_items', (t) => {
    t.bigIncrements('id');
    t.bigInteger('comprobante_id').unsigned().notNullable().references('comprobantes.id').onDelete('CASCADE');
    t.bigInteger('venta_item_id').unsigned().references('venta_items.id');
    t.bigInteger('producto_id').unsigned().references('productos.id');
    t.string('codigo', 30);
    t.string('descripcion', 255).notNullable();
    t.string('unidad', 3).notNullable();
    t.specificType('tip_afe_igv', 'CHAR(2)').notNullable();
    t.decimal('cantidad', 14, 3).notNullable();
    t.decimal('precio_unitario', 16, 6).notNullable();
    t.decimal('valor_venta', 14, 2).notNullable();
    t.decimal('igv', 14, 2).notNullable();
    t.decimal('total', 14, 2).notNullable();
  });

  await knex.schema.createTable('comprobante_cuotas', (t) => {
    t.bigIncrements('id');
    t.bigInteger('comprobante_id').unsigned().notNullable().references('comprobantes.id').onDelete('CASCADE');
    t.smallint('numero').notNullable();
    t.decimal('monto', 14, 2).notNullable();
    t.date('fecha_pago').notNullable();
    t.unique(['comprobante_id', 'numero']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const tabla of ['comprobante_cuotas', 'comprobante_items', 'comprobantes', 'cuotas', 'cuentas_por_cobrar', 'pagos', 'venta_items', 'ventas']) {
    await knex.schema.dropTableIfExists(tabla);
  }
}
