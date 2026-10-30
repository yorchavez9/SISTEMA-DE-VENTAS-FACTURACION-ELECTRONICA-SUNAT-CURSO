import { z } from 'zod';
import { fecha } from './comunes.js';
import { precio } from './catalogo.js';

/**
 * Motivos que ofrece el sistema. Códigos según los catálogos SUNAT 09 y 10 y dentro de los que acepta
 * API-PRO (config/sunat_catalogs.php). Las descripciones de API-PRO para 06 y 07 no coinciden con
 * SUNAT; se usa el significado de SUNAT, que es el que vale para la validación del comprobante.
 * Fuera del MVP: NC 13 (API-PRO no admite cuotas en la NC) y ND 13 (exige operaciones inafectas).
 */
export const MOTIVOS_NC = {
  '01': 'Anulación de la operación',
  '06': 'Devolución total',
  '07': 'Devolución por ítem',
} as const;
export type MotivoNc = keyof typeof MOTIVOS_NC;

export const MOTIVOS_ND = {
  '01': 'Intereses por mora',
  '02': 'Aumento en el valor',
  '03': 'Otros conceptos',
} as const;
export type MotivoNd = keyof typeof MOTIVOS_ND;

const cantidad = z
  .string()
  .trim()
  .regex(/^\d{1,11}(\.\d{1,3})?$/, 'Cantidad inválida')
  .refine((v) => Number(v) > 0, 'Debe ser mayor a 0');

const reintegro = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('caja'), cajaId: z.coerce.number().int().positive(), metodoPagoId: z.coerce.number().int().positive() }),
  z.object({ tipo: z.literal('cxc') }),
  z.object({ tipo: z.literal('ninguno') }),
]);

export const notaCreditoSchema = z
  .object({
    comprobanteAfectadoId: z.coerce.number().int().positive(),
    codMotivo: z.enum(Object.keys(MOTIVOS_NC) as [MotivoNc, ...MotivoNc[]]),
    desMotivo: z.string().trim().min(5, 'Describe el motivo').max(250),
    serieId: z.coerce.number().int().positive().optional(),
    /** Solo motivo 07: líneas del comprobante original y cantidades a acreditar. */
    items: z
      .array(z.object({ comprobanteItemId: z.coerce.number().int().positive(), cantidad }))
      .max(200)
      .refine((i) => new Set(i.map((x) => x.comprobanteItemId)).size === i.length, 'Una línea aparece dos veces')
      .optional(),
    devuelveStock: z.boolean(),
    /** Cómo se devuelve el importe: efectivo/medio desde la caja, rebaja de la cuenta por cobrar o nada. */
    reintegro,
    autorizacionToken: z.string().max(100).optional(),
  })
  .refine((n) => n.codMotivo !== '07' || (n.items?.length ?? 0) > 0, { message: 'Elige las líneas a devolver', path: ['items'] });
export type NotaCreditoInput = z.infer<typeof notaCreditoSchema>;

export const notaDebitoSchema = z.object({
  comprobanteAfectadoId: z.coerce.number().int().positive(),
  codMotivo: z.enum(Object.keys(MOTIVOS_ND) as [MotivoNd, ...MotivoNd[]]),
  desMotivo: z.string().trim().min(5, 'Describe el motivo').max(250),
  serieId: z.coerce.number().int().positive().optional(),
  items: z
    .array(z.object({ descripcion: z.string().trim().min(2).max(250), cantidad, precioUnitario: precio, tipAfeIgv: z.enum(['10', '20', '30']) }))
    .min(1, 'Agrega al menos un concepto')
    .max(50),
  /** Cobro del cargo: ahora en caja, como nueva cuota de la cuenta por cobrar, o después (ninguno). */
  cobro: z.discriminatedUnion('tipo', [
    z.object({ tipo: z.literal('caja'), cajaId: z.coerce.number().int().positive(), metodoPagoId: z.coerce.number().int().positive() }),
    z.object({ tipo: z.literal('cxc'), fechaVencimiento: fecha }),
    z.object({ tipo: z.literal('ninguno') }),
  ]),
});
export type NotaDebitoInput = z.infer<typeof notaDebitoSchema>;

export interface SaldoNotaCreditoDto {
  comprobanteId: number;
  numero: string;
  moneda: 'PEN' | 'USD';
  total: string;
  acreditado: string;
  saldo: string;
  formaPago: 'contado' | 'credito';
  saldoCxc: string | null;
  lineas: Array<{ id: number; descripcion: string; unidad: string; cantidad: string; acreditada: string; disponible: string; precioUnitario: string; inventariable: boolean }>;
  seriesNc: Array<{ id: number; serie: string; predeterminada: boolean }>;
  seriesNd: Array<{ id: number; serie: string; predeterminada: boolean }>;
}
