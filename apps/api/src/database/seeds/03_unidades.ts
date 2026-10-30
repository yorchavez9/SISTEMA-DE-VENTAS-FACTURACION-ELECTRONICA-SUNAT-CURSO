import type { Knex } from 'knex';

// Unidades del catálogo 03 más usadas en una tienda. Todos los códigos están en la lista
// que acepta API-PRO (StoreInvoiceRequest, regla items.*.unidad). Idempotente.
const UNIDADES: Array<[codigo: string, nombre: string, fraccionable: boolean]> = [
  ['NIU', 'Unidad (bienes)', false],
  ['ZZ', 'Unidad (servicios)', false],
  ['KGM', 'Kilogramo', true],
  ['GRM', 'Gramo', true],
  ['TNE', 'Tonelada', true],
  ['LTR', 'Litro', true],
  ['MLT', 'Mililitro', true],
  ['GLL', 'Galón', true],
  ['MTR', 'Metro', true],
  ['CMT', 'Centímetro', true],
  ['MTK', 'Metro cuadrado', true],
  ['MTQ', 'Metro cúbico', true],
  ['BX', 'Caja', false],
  ['PK', 'Paquete', false],
  ['DZN', 'Docena', false],
  ['SET', 'Juego', false],
  ['PR', 'Par', false],
  ['BG', 'Bolsa', false],
  ['BO', 'Botella', false],
  ['HUR', 'Hora', true],
  ['DAY', 'Día', false],
  ['MON', 'Mes', false],
];

export async function seed(knex: Knex): Promise<void> {
  await knex('unidades')
    .insert(UNIDADES.map(([codigo_sunat, nombre, fraccionable]) => ({ codigo_sunat, nombre, fraccionable })))
    .onConflict('codigo_sunat')
    .merge(['nombre', 'fraccionable']);
}
