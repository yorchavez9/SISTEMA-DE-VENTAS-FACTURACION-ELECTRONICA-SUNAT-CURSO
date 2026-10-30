import { z } from 'zod';
import { fecha } from './comunes.js';

// Dashboard y reportes (fase 8). Todo sale de la BD local. Las ventas se cuentan "netas":
// ventas no anuladas − notas de crédito + notas de débito vigentes (las notas se atribuyen a la
// venta del comprobante que modifican: mismo cliente, vendedor y sucursal).

export interface DashboardDto {
  fecha: string;
  moneda: 'PEN';
  ventas: {
    /** Neto del día en soles (las ventas en dólares se convierten con su tipo de cambio). */
    totalPen: string;
    n: number;
    ticketPromedio: string | null;
    /** Variación porcentual contra el mismo día de la semana anterior; null si no hubo ventas. */
    variacion: number | null;
    porMoneda: Array<{ moneda: 'PEN' | 'USD'; total: string }>;
  };
  porMetodo: Array<{ metodo: string; moneda: 'PEN' | 'USD'; total: string }>;
  comprobantes: { aceptadosHoy: number; pendientes: number; enProceso: number; porVerificar: number; problemas: number; pendienteResumen: number };
  stockBajo: Array<{ productoId: number; codigo: string; nombre: string; stock: string; minimo: string }>;
  topProductos: Array<{ productoId: number; nombre: string; cantidad: string; totalPen: string }>;
  cxcVencida: Array<{ moneda: 'PEN' | 'USD'; saldo: string; cuotas: number }>;
  /** Ventas netas por día (últimos 14 días), en soles. */
  serieDiaria: Array<{ fecha: string; totalPen: string; n: number }>;
  guiasPendientes: number;
  /** Últimas ventas de la sucursal (como "Ventas recientes" de ferretería). */
  recientes: Array<{ id: number; fecha: string; comprobante: string | null; tipoDoc: string | null; estadoComprobante: string | null; anulada: boolean; total: string; moneda: 'PEN' | 'USD' }>;
  /** Productos activos del catálogo. */
  productos: number;
}

export const AGRUPACIONES_VENTAS = {
  dia: 'Día',
  producto: 'Producto',
  cliente: 'Cliente',
  usuario: 'Vendedor',
  sucursal: 'Sucursal',
  metodo: 'Medio de pago (caja)',
} as const;
export type AgrupacionVentas = keyof typeof AGRUPACIONES_VENTAS;

export const REPORTES = {
  ventas: 'Ventas',
  comprobantes: 'Comprobantes',
  inventario: 'Inventario valorizado',
  compras: 'Compras',
  caja: 'Cierres de caja',
  cxc: 'Cuentas por cobrar',
} as const;
export type TipoReporte = keyof typeof REPORTES;

const rango = {
  desde: fecha.optional(),
  hasta: fecha.optional(),
  sucursalId: z.coerce.number().int().positive().optional(),
  formato: z.enum(['json', 'csv']).default('json'),
};

export const filtroReporteSchema = z
  .object({
    ...rango,
    agrupar: z.enum(Object.keys(AGRUPACIONES_VENTAS) as [AgrupacionVentas, ...AgrupacionVentas[]]).default('dia'),
    moneda: z.enum(['PEN', 'USD']).optional(),
  })
  .refine((f) => !f.desde || !f.hasta || f.desde <= f.hasta, { message: 'El rango de fechas está invertido', path: ['hasta'] })
  .refine((f) => !f.desde || !f.hasta || (Date.parse(f.hasta) - Date.parse(f.desde)) / 86_400_000 <= 366, { message: 'El rango máximo es de un año', path: ['hasta'] });
export type FiltroReporte = z.infer<typeof filtroReporteSchema>;

export type TipoColumna = 'texto' | 'fecha' | 'entero' | 'cantidad' | 'importe' | 'porcentaje';

/** Reporte tabular genérico: la misma estructura se muestra en pantalla y se exporta a CSV. */
export interface ReporteDto {
  titulo: string;
  subtitulo: string;
  columnas: Array<{ clave: string; titulo: string; tipo: TipoColumna }>;
  filas: Array<Record<string, string | number | null>>;
  /** Totales por moneda (una fila por moneda cuando hay importes). */
  totales: Array<Record<string, string | number | null>>;
  notas: string[];
}

export const filtroAuditoriaSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  desde: fecha.optional(),
  hasta: fecha.optional(),
  accion: z.string().trim().max(80).optional(),
  entidad: z.string().trim().max(60).optional(),
  entidadId: z.string().trim().max(40).optional(),
  usuarioId: z.coerce.number().int().positive().optional(),
});
export type FiltroAuditoria = z.infer<typeof filtroAuditoriaSchema>;

export interface AuditoriaDto {
  id: number;
  fecha: string;
  usuario: string | null;
  operador: string | null;
  sucursal: string | null;
  accion: string;
  entidad: string;
  entidadId: string | null;
  antes: unknown;
  despues: unknown;
  ip: string | null;
}

export const filtroIntentosSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  entidadTipo: z.string().trim().max(30).optional(),
  entidadId: z.coerce.number().int().positive().optional(),
  soloErrores: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
export type FiltroIntentos = z.infer<typeof filtroIntentosSchema>;

export interface IntentoDto {
  id: number;
  fecha: string;
  operacion: string;
  metodo: string;
  ruta: string;
  entidadTipo: string | null;
  entidadId: number | null;
  httpStatus: number | null;
  duracionMs: number | null;
  error: string | null;
}
