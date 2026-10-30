import { z } from 'zod';

/** Importe como string decimal con 2 decimales como máximo, p. ej. "118.00". */
export const importe = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,2})?$/, 'Importe inválido');

/** Cantidad como string decimal con 3 decimales como máximo. */
export const cantidad = z
  .string()
  .regex(/^\d{1,11}(\.\d{1,3})?$/, 'Cantidad inválida')
  .refine((v) => Number(v) > 0, 'La cantidad debe ser mayor a 0');

export const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');

export const paginacionQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  sort: z
    .string()
    .regex(/^[a-zA-Z_]+:(asc|desc)$/)
    .optional(),
});
export type PaginacionQuery = z.infer<typeof paginacionQuery>;

export interface Pagina<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ErrorApi {
  error: string;
  codigo: string;
  campos?: Record<string, string>;
  detalle?: unknown;
  requestId?: string;
}

/** RUC peruano: 11 dígitos, prefijo 10/15/17/20 y dígito verificador módulo 11. */
export function rucValido(ruc: string): boolean {
  if (!/^(10|15|17|20)\d{9}$/.test(ruc)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, p, i) => acc + p * Number(ruc[i]), 0);
  const resto = 11 - (suma % 11);
  const dv = resto === 10 ? 0 : resto === 11 ? 1 : resto;
  return dv === Number(ruc[10]);
}
