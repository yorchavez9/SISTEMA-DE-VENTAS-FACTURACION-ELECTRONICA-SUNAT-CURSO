import { z } from 'zod';
import { MONEDAS, type Moneda } from '../enums.js';

const importePositivo = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Importe inválido (hasta 2 decimales)');

export const cajaSchema = z.object({
  nombre: z.string().trim().min(2).max(60),
  activo: z.boolean().default(true),
});

export const abrirTurnoSchema = z.object({
  cajaId: z.coerce.number().int().positive(),
  saldosIniciales: z
    .array(z.object({ moneda: z.enum(MONEDAS), monto: importePositivo }))
    .max(2)
    .refine((s) => new Set(s.map((x) => x.moneda)).size === s.length, 'Moneda repetida')
    .default([]),
});

export const movimientoCajaSchema = z.object({
  tipo: z.enum(['ingreso', 'egreso']),
  metodoPagoId: z.coerce.number().int().positive(),
  moneda: z.enum(MONEDAS),
  monto: importePositivo.refine((v) => Number(v) > 0, 'Debe ser mayor a 0'),
  concepto: z.string().trim().min(3, 'Indica el concepto').max(255),
  referencia: z.string().trim().max(60).optional(),
});

export const cerrarTurnoSchema = z.object({
  contado: z
    .array(z.object({ moneda: z.enum(MONEDAS), monto: importePositivo }))
    .refine((s) => new Set(s.map((x) => x.moneda)).size === s.length, 'Moneda repetida'),
  nota: z.string().trim().max(255).optional(),
});

export interface MetodoPagoDto {
  id: number;
  codigo: string;
  nombre: string;
  tipo: 'efectivo' | 'tarjeta' | 'billetera' | 'transferencia' | 'otro';
  requiereReferencia: boolean;
}

export interface CajaDto {
  id: number;
  nombre: string;
  sucursalId: number;
  activo: boolean;
  turnoAbierto: { id: number; abiertoEn: string; usuario: string } | null;
}

export interface ResumenTurnoDto {
  turno: {
    id: number;
    caja: { id: number; nombre: string };
    sucursalId: number;
    estado: 'abierto' | 'cerrado';
    abiertoEn: string;
    abiertoPor: string;
    cerradoEn: string | null;
    cerradoPor: string | null;
    nota: string | null;
  };
  /** Efectivo por moneda: inicial + entradas − salidas = esperado. */
  efectivo: Array<{ moneda: Moneda; inicial: string; entradas: string; salidas: string; esperado: string; contado: string | null; diferencia: string | null }>;
  /** Totales por medio de pago y moneda (ventas, cobros, ingresos y egresos). */
  porMetodo: Array<{ metodo: string; tipo: MetodoPagoDto['tipo']; moneda: Moneda; total: string }>;
  movimientos: Array<{ id: number; fecha: string; tipo: string; metodo: string; moneda: Moneda; monto: string; concepto: string; referencia: string | null; usuario: string }>;
}
