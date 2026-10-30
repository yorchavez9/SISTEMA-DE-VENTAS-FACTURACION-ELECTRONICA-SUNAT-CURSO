import { z } from 'zod';
import { MONEDAS, MODOS_BOLETA, type EstadoComprobante, type Moneda } from '../enums.js';
import { fecha } from './comunes.js';
import { clienteSchema } from './terceros.js';

const importe = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Importe inválido (hasta 2 decimales)');

const cantidadPositiva = z
  .string()
  .trim()
  .regex(/^\d{1,11}(\.\d{1,3})?$/, 'Cantidad inválida (hasta 3 decimales)')
  .refine((v) => Number(v) > 0, 'Debe ser mayor a 0');

export const pagoSchema = z.object({
  metodoPagoId: z.coerce.number().int().positive(),
  moneda: z.enum(MONEDAS),
  monto: importe.refine((v) => Number(v) > 0, 'El pago debe ser mayor a 0'),
  /** Solo efectivo: lo que entregó el cliente (para calcular el vuelto). */
  montoRecibido: importe.optional(),
  referencia: z.string().trim().max(60).optional(),
});

export const ventaSchema = z
  .object({
    cajaId: z.coerce.number().int().positive(),
    tipoComprobante: z.enum(['01', '03']),
    serieId: z.coerce.number().int().positive(),
    /** Solo boletas; si no se indica, se usa el modo de la sucursal. */
    modoBoleta: z.enum(MODOS_BOLETA).optional(),
    moneda: z.enum(MONEDAS),
    cliente: z.union([z.object({ id: z.coerce.number().int().positive() }), z.object({ nuevo: clienteSchema }), z.null()]),
    items: z
      .array(z.object({ productoId: z.coerce.number().int().positive(), cantidad: cantidadPositiva }))
      .min(1, 'Agrega al menos un producto')
      .max(200)
      .refine((items) => new Set(items.map((i) => i.productoId)).size === items.length, 'Un producto aparece dos veces'),
    descuento: z
      .object({
        tipo: z.enum(['monto', 'porcentaje']),
        valor: z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Descuento inválido'),
        motivo: z.string().trim().min(3, 'Indica el motivo del descuento').max(255),
        autorizacionToken: z.string().max(100).optional(),
      })
      .optional(),
    formaPago: z.enum(['contado', 'credito']),
    /** Contado: deben cubrir el total. Crédito: cuota inicial (opcional). */
    pagos: z.array(pagoSchema).max(6).default([]),
    cuotas: z
      .array(z.object({ monto: importe.refine((v) => Number(v) > 0, 'Cuota mayor a 0'), fechaVencimiento: fecha }))
      .max(36)
      .default([]),
    /** Autorización de supervisor cuando se excede el crédito o el cliente tiene cuotas vencidas. */
    autorizacionCredito: z.string().max(100).optional(),
  })
  .refine((v) => v.formaPago === 'contado' || v.cuotas.length > 0, { message: 'Indica las cuotas del crédito', path: ['cuotas'] })
  .refine((v) => v.formaPago === 'credito' || v.cuotas.length === 0, { message: 'Las cuotas solo aplican al crédito', path: ['cuotas'] })
  .refine((v) => v.formaPago === 'credito' || v.pagos.length > 0, { message: 'Registra al menos un pago', path: ['pagos'] });
export type VentaInput = z.infer<typeof ventaSchema>;

/** Para cotizar (vista previa) basta con los ítems, la moneda y el descuento. */
export const cotizarSchema = z.object({
  moneda: z.enum(MONEDAS),
  items: z.array(z.object({ productoId: z.coerce.number().int().positive(), cantidad: cantidadPositiva })).min(1).max(200),
  descuento: z.object({ tipo: z.enum(['monto', 'porcentaje']), valor: z.string().trim().regex(/^\d{1,12}(\.\d{1,2})?$/) }).optional(),
});

export interface ComprobanteResumenDto {
  id: number;
  tipoDoc: '01' | '03' | '07' | '08';
  serie: string;
  correlativo: number | null;
  numeroCompleto: string | null;
  estado: EstadoComprobante;
  modoEnvio: 'individual' | 'resumen';
  total: string;
  moneda: Moneda;
  sunatDescripcion: string | null;
}

export interface VentaDto {
  id: number;
  fecha: string;
  sucursal: { id: number; nombre: string };
  cajero: string;
  cliente: { id: number | null; tipoDoc: string; numDoc: string; razonSocial: string; direccion: string | null };
  moneda: Moneda;
  tipoCambio: string;
  formaPago: 'contado' | 'credito';
  tipoComprobante: '01' | '03';
  subtotal: string;
  descuento: string;
  descuentoMotivo: string | null;
  opGravada: string;
  opExonerada: string;
  opInafecta: string;
  igv: string;
  tasaIgv: string;
  total: string;
  estado: 'confirmada' | 'anulacion_en_proceso' | 'anulada';
  items: Array<{ productoId: number; codigo: string; descripcion: string; unidad: string; cantidad: string; precioLista: string; precioUnitario: string; descuento: string; total: string }>;
  pagos: Array<{ metodo: string; moneda: Moneda; monto: string; montoRecibido: string | null; vuelto: string | null; referencia: string | null }>;
  cuotas: Array<{ numero: number; monto: string; saldo: string; fechaVencimiento: string; estado: string }>;
  comprobantes: ComprobanteResumenDto[];
}

export const anularVentaSchema = z.object({
  motivo: z.string().trim().min(5, 'Explica el motivo (mínimo 5 caracteres)').max(255),
  /** Caja abierta desde la que se devuelve el dinero al cliente. */
  cajaId: z.coerce.number().int().positive(),
  autorizacionToken: z.string().max(100).optional(),
});
