import { z } from 'zod';
import type { EstadoComprobante, Moneda } from '../enums.js';
import { fecha } from './comunes.js';
import { TIPOS_DOC_TERCERO } from './terceros.js';

export const FORMATOS_PDF = ['a4', 'a5', 'ticket-80', 'ticket-58'] as const;
export type FormatoPdf = (typeof FORMATOS_PDF)[number];

export type AccionComprobante = 'pdf' | 'xml' | 'cdr' | 'reintentar' | 'consultar' | 'corregir' | 'anular_interna' | 'nota_credito' | 'nota_debito' | 'anular';

export const filtroComprobantesSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  desde: fecha.optional(),
  hasta: fecha.optional(),
  tipoDoc: z.enum(['01', '03', '07', '08']).optional(),
  estado: z.string().max(30).optional(),
  q: z.string().trim().max(40).optional(),
  atencion: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

/** Corrección de los datos del cliente de un comprobante rechazado o con datos inválidos. */
export const corregirComprobanteSchema = z.object({
  cliente: z.object({
    tipoDoc: z.enum([...TIPOS_DOC_TERCERO, '0']),
    numDoc: z.string().trim().min(1).max(15),
    razonSocial: z.string().trim().min(2).max(255),
    direccion: z.string().trim().max(255).optional(),
  }),
});

export interface ComprobanteListaDto {
  id: number;
  tipoDoc: '01' | '03' | '07' | '08';
  serie: string;
  correlativo: number | null;
  numeroCompleto: string | null;
  fechaEmision: string;
  ventaId: number | null;
  cliente: { tipoDoc: string; numDoc: string; razonSocial: string };
  moneda: Moneda;
  total: string;
  estado: EstadoComprobante;
  modoEnvio: 'individual' | 'resumen';
  simulado: boolean;
  /** Archivos de API-PRO que ya se pueden ver o descargar. */
  archivos: Array<'pdf' | 'xml' | 'cdr'>;
  detalle: string | null;
  creadoEn: string;
}

export interface ComprobanteDetalleDto extends ComprobanteListaDto {
  sucursal: { id: number; nombre: string };
  formaPago: 'contado' | 'credito';
  opGravada: string;
  opExonerada: string;
  opInafecta: string;
  igv: string;
  totalApi: string | null;
  apiId: number | null;
  sunat: { codigo: string | null; descripcion: string | null; notas: unknown; hash: string | null };
  ultimoError: string | null;
  intentos: number;
  items: Array<{ codigo: string | null; descripcion: string; unidad: string; cantidad: string; precioUnitario: string; total: string }>;
  cuotas: Array<{ numero: number; monto: string; fechaPago: string }>;
  acciones: AccionComprobante[];
  /** Dinero por devolver al cliente de una venta anulada por SUNAT. */
  reembolsoPendiente: string | null;
  historial: Array<{ fecha: string; operacion: string; metodo: string; ruta: string; httpStatus: number | null; error: string | null; duracionMs: number | null }>;
}

export interface EstadoIntegracionDto {
  modoEmision: 'simulacion' | 'real';
  entorno: 'beta' | 'production' | null;
  credenciales: 'base_datos' | 'env' | 'ninguno';
  verificadaEn: string | null;
  colaPausada: boolean;
  pausa: { codigo: string; motivo: string; desde: string; hasta: string } | null;
  contadores: { pendientes: number; enProceso: number; porVerificar: number; problemas: number; pendienteResumen: number };
  atascados: AtascadosDto;
}

/** Documentos que debían resolverse solos y no lo hicieron (alerta de operación). */
export interface AtascadosDto {
  /** Minutos sin cambios para considerar atascado un envío (ajuste alertas.comprobante_atascado_min). */
  minutos: number;
  total: number;
  items: Array<{ tipo: 'comprobante' | 'guia'; id: number; numero: string; estado: string; desde: string }>;
  boletasSinResumen: number;
  trabajosFallidos: number;
}
