import { z } from 'zod';
import { MONEDAS } from '../enums.js';
import { fecha } from './comunes.js';
import { precio } from './catalogo.js';

export const TIPOS_DOC_COMPRA = {
  '01': 'Factura',
  '03': 'Boleta',
  '12': 'Ticket',
  '00': 'Otro documento',
} as const;
export type TipoDocCompra = keyof typeof TIPOS_DOC_COMPRA;

const cantidadPositiva = z
  .string()
  .trim()
  .regex(/^\d{1,11}(\.\d{1,3})?$/, 'Cantidad inválida (hasta 3 decimales)')
  .refine((v) => Number(v) > 0, 'Debe ser mayor a 0');

const tasaCambio = z
  .string()
  .regex(/^\d{1,4}(\.\d{1,4})?$/, 'Tipo de cambio inválido')
  .refine((v) => Number(v) > 0, 'Debe ser mayor a 0');

const sinRepetidos = (items: Array<{ productoId: number }>) => new Set(items.map((i) => i.productoId)).size === items.length;

export const compraSchema = z
  .object({
    proveedorId: z.coerce.number().int().positive({ message: 'Elige el proveedor' }),
    tipoDocCompra: z.enum(Object.keys(TIPOS_DOC_COMPRA) as [TipoDocCompra, ...TipoDocCompra[]]),
    serieNumero: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9-]{0,19}$/, 'Serie y número, p. ej. F001-123'),
    fecha,
    moneda: z.enum(MONEDAS),
    /** Obligatorio si la moneda es USD (S/ por US$). */
    tipoCambio: tasaCambio.optional(),
    preciosIncluyenIgv: z.boolean(),
    nota: z.string().trim().max(255).optional(),
    items: z
      .array(z.object({ productoId: z.coerce.number().int().positive(), cantidad: cantidadPositiva, costoUnitario: precio }))
      .min(1, 'Agrega al menos un producto')
      .max(300)
      .refine(sinRepetidos, 'Un producto aparece dos veces'),
  })
  .refine((c) => c.moneda === 'PEN' || c.tipoCambio, { message: 'Indica el tipo de cambio', path: ['tipoCambio'] });
export type CompraInput = z.infer<typeof compraSchema>;

export const anularSchema = z.object({ motivo: z.string().trim().min(5, 'Explica el motivo (mínimo 5 caracteres)').max(255) });

export interface CompraDto {
  id: number;
  proveedor: { id: number; razonSocial: string; numDoc: string };
  sucursal: { id: number; nombre: string };
  tipoDocCompra: TipoDocCompra;
  serieNumero: string;
  fecha: string;
  moneda: 'PEN' | 'USD';
  tipoCambio: string;
  preciosIncluyenIgv: boolean;
  tasaIgv: string;
  subtotal: string;
  igv: string;
  total: string;
  estado: 'registrada' | 'anulada';
  nota: string | null;
  motivoAnulacion: string | null;
  usuario: string;
  creadoEn: string;
  items?: Array<{ productoId: number; codigo: string; nombre: string; cantidad: string; costoUnitario: string; costoNetoPen: string; total: string }>;
}

export const filtroComprasSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  desde: fecha.optional(),
  hasta: fecha.optional(),
  proveedorId: z.coerce.number().int().positive().optional(),
  estado: z.enum(['registrada', 'anulada']).optional(),
  q: z.string().trim().max(40).optional(),
});

// ---------- Traslados ----------

export const trasladoSchema = z.object({
  sucursalDestinoId: z.coerce.number().int().positive({ message: 'Elige la sucursal de destino' }),
  nota: z.string().trim().max(255).optional(),
  items: z
    .array(z.object({ productoId: z.coerce.number().int().positive(), cantidad: cantidadPositiva }))
    .min(1, 'Agrega al menos un producto')
    .max(300)
    .refine(sinRepetidos, 'Un producto aparece dos veces'),
});
export type TrasladoInput = z.infer<typeof trasladoSchema>;

export interface TrasladoDto {
  id: number;
  origen: { id: number; nombre: string };
  destino: { id: number; nombre: string };
  estado: 'enviado' | 'recibido' | 'anulado';
  nota: string | null;
  enviadoPor: string;
  recibidoPor: string | null;
  creadoEn: string;
  recibidoEn: string | null;
  items: Array<{ productoId: number; codigo: string; nombre: string; cantidad: string }>;
}
