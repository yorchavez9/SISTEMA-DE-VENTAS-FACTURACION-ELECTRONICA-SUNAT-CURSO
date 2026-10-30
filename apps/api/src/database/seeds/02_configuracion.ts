import type { Knex } from 'knex';

// Ajustes no sensibles por defecto. No sobrescribe valores ya configurados.
const AJUSTES: Record<string, unknown> = {
  'sesion.inactividad_min': 30,
  'ticket.mensaje_pie': 'Gracias por su compra',
  'credito.limite_por_cliente': false,
  'credito.bloquear_vencidos': true,
  'alertas.comprobante_atascado_min': 30,
};

export async function seed(knex: Knex): Promise<void> {
  await knex('configuracion')
    .insert(Object.entries(AJUSTES).map(([clave, valor]) => ({ clave, valor: JSON.stringify(valor) })))
    .onConflict('clave')
    .ignore();
}
