import type { Knex } from 'knex';

// Medios de pago iniciales (configurables después). Idempotente.
const METODOS: Array<[codigo: string, nombre: string, tipo: string, referencia: boolean, orden: number]> = [
  ['EFECTIVO', 'Efectivo', 'efectivo', false, 1],
  ['YAPE', 'Yape', 'billetera', true, 2],
  ['PLIN', 'Plin', 'billetera', true, 3],
  ['TARJETA', 'Tarjeta de débito/crédito', 'tarjeta', true, 4],
  ['TRANSFERENCIA', 'Transferencia bancaria', 'transferencia', true, 5],
];

export async function seed(knex: Knex): Promise<void> {
  await knex('metodos_pago')
    .insert(METODOS.map(([codigo, nombre, tipo, requiere_referencia, orden]) => ({ codigo, nombre, tipo, requiere_referencia, orden })))
    .onConflict('codigo')
    .ignore();
}
