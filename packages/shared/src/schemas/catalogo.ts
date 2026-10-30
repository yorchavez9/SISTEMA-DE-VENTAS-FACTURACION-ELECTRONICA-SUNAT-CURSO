import { z } from 'zod';
import { AFECTACIONES_IGV } from '../catalogos.js';

/** Precio con hasta 6 decimales, como string (p. ej. "29.50"). */
export const precio = z
  .string()
  .trim()
  .regex(/^\d{1,10}(\.\d{1,6})?$/, 'Precio inválido (hasta 6 decimales)');

/** Cantidad de stock con signo y hasta 3 decimales (para ajustes). */
export const cantidadConSigno = z
  .string()
  .trim()
  .regex(/^-?\d{1,11}(\.\d{1,3})?$/, 'Cantidad inválida (hasta 3 decimales)')
  .refine((v) => Number(v) !== 0, 'La cantidad no puede ser 0');

const cantidadNoNegativa = z
  .string()
  .trim()
  .regex(/^\d{1,11}(\.\d{1,3})?$/, 'Cantidad inválida (hasta 3 decimales)');

export const categoriaSchema = z.object({
  nombre: z.string().trim().min(2, 'Mínimo 2 caracteres').max(80),
  activo: z.boolean().default(true),
});

export interface CategoriaDto {
  id: number;
  nombre: string;
  activo: boolean;
  productos: number;
}

export interface UnidadDto {
  id: number;
  codigoSunat: string;
  nombre: string;
  fraccionable: boolean;
}

const afectacion = z.enum(Object.keys(AFECTACIONES_IGV) as [keyof typeof AFECTACIONES_IGV, ...Array<keyof typeof AFECTACIONES_IGV>]);

export const productoSchema = z
  .object({
    codigo: z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{1,30}$/, 'Código: letras, números, punto o guion (máx. 30)'),
    codigoBarras: z
      .string()
      .trim()
      .regex(/^[0-9A-Za-z-]{4,50}$/, 'Código de barras inválido')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    nombre: z.string().trim().min(2, 'Ingresa el nombre').max(200),
    descripcion: z.string().trim().max(500).optional(),
    categoriaId: z.coerce.number().int().positive().nullable().optional(),
    unidadId: z.coerce.number().int().positive({ message: 'Elige la unidad' }),
    tipo: z.enum(['bien', 'servicio']),
    inventariable: z.boolean(),
    tipAfeIgv: afectacion,
    codProductoSunat: z
      .string()
      .regex(/^\d{8}$/, 'El código SUNAT tiene 8 dígitos')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    precioVenta: precio,
    precioVentaUsd: precio.optional().or(z.literal('').transform(() => undefined)),
    stockMinimo: cantidadNoNegativa.default('0'),
    pesoKg: z
      .string()
      .regex(/^\d{1,7}(\.\d{1,3})?$/, 'Peso inválido')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    activo: z.boolean().default(true),
    /** Solo al crear: stock inicial en la sucursal activa. */
    stockInicial: cantidadNoNegativa.optional().or(z.literal('').transform(() => undefined)),
  })
  .refine((p) => p.tipo === 'bien' || !p.inventariable, { message: 'Un servicio no lleva inventario', path: ['inventariable'] })
  .refine((p) => p.inventariable || !p.stockInicial || Number(p.stockInicial) === 0, { message: 'Solo los productos inventariables tienen stock', path: ['stockInicial'] });
export type ProductoInput = z.infer<typeof productoSchema>;

export interface ProductoDto {
  id: number;
  codigo: string;
  codigoBarras: string | null;
  nombre: string;
  descripcion: string | null;
  categoria: { id: number; nombre: string } | null;
  unidad: { id: number; codigoSunat: string; nombre: string; fraccionable: boolean };
  tipo: 'bien' | 'servicio';
  inventariable: boolean;
  tipAfeIgv: keyof typeof AFECTACIONES_IGV;
  codProductoSunat: string | null;
  precioVenta: string;
  precioVentaUsd: string | null;
  costoPromedio: string;
  stockMinimo: string;
  pesoKg: string | null;
  /** Imagen opcional (URL de la API, con versión); null si no tiene. */
  imagenUrl: string | null;
  activo: boolean;
  /** Stock en la sucursal consultada (null si no es inventariable). */
  stock: string | null;
  stockBajo: boolean;
}

export const filtroProductosSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  categoriaId: z.coerce.number().int().positive().optional(),
  activo: z.enum(['true', 'false', 'todos']).default('true'),
  stockBajo: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  sucursalId: z.coerce.number().int().positive().optional(),
  soloInventariables: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const ajusteSchema = z.object({
  motivo: z.string().trim().min(3, 'Indica el motivo').max(255),
  items: z
    .array(z.object({ productoId: z.coerce.number().int().positive(), cantidad: cantidadConSigno }))
    .min(1, 'Agrega al menos un producto')
    .max(200)
    .refine((items) => new Set(items.map((i) => i.productoId)).size === items.length, 'Un producto aparece dos veces'),
});
export type AjusteInput = z.infer<typeof ajusteSchema>;

export interface MovimientoDto {
  id: number;
  fecha: string;
  tipo: string;
  cantidad: string;
  stockResultante: string;
  costoUnitario: string | null;
  origenTipo: string;
  origenId: number;
  usuario: string | null;
  nota: string | null;
}

export interface FaltanteStock {
  productoId: number;
  nombre: string;
  disponible: string;
  solicitado: string;
}
