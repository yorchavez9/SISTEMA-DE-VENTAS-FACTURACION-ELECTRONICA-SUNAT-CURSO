import { z } from 'zod';

export const anulacionSchema = z.object({
  comprobanteIds: z.array(z.coerce.number().int().positive()).min(1).max(100),
  motivo: z.string().trim().min(5, 'Explica el motivo (mínimo 5 caracteres)').max(255),
  autorizacionToken: z.string().max(100).optional(),
});
export type AnulacionInput = z.infer<typeof anulacionSchema>;

export const validarAnulacionSchema = z.object({ comprobanteIds: z.array(z.coerce.number().int().positive()).min(1).max(100) });

export interface ValidacionAnulacionDto {
  /** RA = comunicación de baja (facturas y notas); RC = resumen de anulación (boletas). */
  mecanismo: 'RA' | 'RC' | null;
  permitido: boolean;
  bloqueos: string[];
  advertencias: string[];
  /** Último día para anular (fecha de emisión + 7). */
  plazoHasta: string | null;
}

export interface BajaDto {
  id: number;
  mecanismo: 'RA' | 'RC';
  identifier: string | null;
  fecha: string;
  estado: string;
  motivo: string | null;
  simulado: boolean;
  documentos: Array<{ comprobanteId: number; numero: string | null; estado: string }>;
  sunatDescripcion: string | null;
  creadoEn: string;
}

export const reembolsoSchema = z.object({
  cajaId: z.coerce.number().int().positive(),
  metodoPagoId: z.coerce.number().int().positive(),
});
