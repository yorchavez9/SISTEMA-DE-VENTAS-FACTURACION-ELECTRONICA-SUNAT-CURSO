import { z } from 'zod';
import { fecha } from './comunes.js';

export const enviarResumenSchema = z.object({ fecha });
export const enviarIndividualSchema = z.object({ comprobanteIds: z.array(z.coerce.number().int().positive()).min(1).max(500) });

export interface PendientesResumenDto {
  fecha: string;
  boletas: number;
  total: string;
  /** Último día en que API-PRO acepta el resumen de esa fecha (fecha + 7). */
  plazoHasta: string;
  vencido: boolean;
}

export interface VerificacionResumenDto {
  fecha: string;
  propias: number;
  ajenas: Array<{ apiId: number; numero: string; cliente: string | null }>;
  /** Boletas locales "para resumen" que API-PRO no lista como pendientes (inconsistencia). */
  noEncontradas: string[];
  puedeEnviar: boolean;
}

export interface ResumenDto {
  id: number;
  tipo: 'envio' | 'anulacion';
  fechaResumen: string;
  identifier: string | null;
  estado: 'verificando' | 'bloqueado' | 'enviado' | 'aceptado' | 'rechazado' | 'error';
  incidente: boolean;
  simulado: boolean;
  documentos: number;
  bloqueo: VerificacionResumenDto | null;
  sunatDescripcion: string | null;
  ultimoError: string | null;
  creadoEn: string;
  creadoPor: string | null;
}
