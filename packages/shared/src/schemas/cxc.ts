import { z } from 'zod';
import { MONEDAS, type Moneda } from '../enums.js';

const importe = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Importe inválido (hasta 2 decimales)')
  .refine((v) => Number(v) > 0, 'Debe ser mayor a 0');

export const cobroSchema = z.object({
  clienteId: z.coerce.number().int().positive(),
  cajaId: z.coerce.number().int().positive(),
  metodoPagoId: z.coerce.number().int().positive(),
  /** Moneda en la que paga el cliente. */
  moneda: z.enum(MONEDAS),
  monto: importe,
  referencia: z.string().trim().max(60).optional(),
  /**
   * Cuotas a las que se aplica (montos en la moneda de cada cuota). Si se omite, el pago se aplica
   * a las cuotas de la misma moneda, de la más antigua a la más nueva.
   */
  aplicaciones: z
    .array(z.object({ cuotaId: z.coerce.number().int().positive(), monto: importe }))
    .max(60)
    .refine((a) => new Set(a.map((x) => x.cuotaId)).size === a.length, 'Una cuota aparece dos veces')
    .optional(),
});
export type CobroInput = z.infer<typeof cobroSchema>;

export const anularCobroSchema = z.object({
  motivo: z.string().trim().min(5, 'Explica el motivo (mínimo 5 caracteres)').max(255),
  cajaId: z.coerce.number().int().positive(),
  autorizacionToken: z.string().max(100).optional(),
});

export interface CuotaDto {
  id: number;
  numero: number;
  monto: string;
  saldo: string;
  fechaVencimiento: string;
  estado: 'pendiente' | 'parcial' | 'pagada' | 'anulada';
  diasVencida: number; // 0 si no está vencida
}

export interface CuentaPorCobrarDto {
  id: number;
  ventaId: number;
  comprobante: string | null;
  cliente: { id: number; razonSocial: string; numDoc: string };
  moneda: Moneda;
  total: string;
  saldo: string;
  estado: 'pendiente' | 'parcial' | 'pagada' | 'anulada';
  fecha: string;
  venceUltima: string;
  vencida: boolean;
  cuotas: CuotaDto[];
}

export interface CobroDto {
  id: number;
  fecha: string;
  cliente: { id: number; razonSocial: string };
  metodo: string;
  moneda: Moneda;
  monto: string;
  tipoCambio: string;
  referencia: string | null;
  estado: 'registrado' | 'anulado';
  motivoAnulacion: string | null;
  usuario: string;
  aplicaciones: Array<{ cuotaId: number; ventaId: number; numero: number; moneda: Moneda; monto: string }>;
}

export interface EstadoCuentaDto {
  cliente: { id: number; razonSocial: string; numDoc: string; limiteCredito: string | null; monedaCredito: Moneda | null };
  saldos: Array<{ moneda: Moneda; saldo: string; vencido: string }>;
  cuentas: CuentaPorCobrarDto[];
  cobros: CobroDto[];
}

export interface AntiguedadDto {
  moneda: Moneda;
  porVencer: string;
  d1a30: string;
  d31a60: string;
  d61a90: string;
  mas90: string;
  total: string;
}
