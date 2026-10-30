// Estados y valores de dominio compartidos entre web y api.
// Fuente: docs/02-modelo-datos.md y docs/00-plan-implementacion.md §10.1 / §0.4.

export const MONEDAS = ['PEN', 'USD'] as const;
export type Moneda = (typeof MONEDAS)[number];

export const TIPOS_COMPROBANTE = ['01', '03', '07', '08'] as const;
export type TipoComprobante = (typeof TIPOS_COMPROBANTE)[number];

export const MODOS_BOLETA = ['individual', 'resumen'] as const;
export type ModoBoleta = (typeof MODOS_BOLETA)[number];

export const FORMAS_PAGO = ['contado', 'credito'] as const;
export type FormaPago = (typeof FORMAS_PAGO)[number];

export const ESTADOS_COMPROBANTE = [
  'pendiente',
  'enviando',
  'en_proceso',
  'pendiente_resumen',
  'en_resumen',
  'aceptado',
  'observado',
  'rechazado',
  'error_validacion',
  'por_verificar',
  'sin_respuesta_sunat',
  'anulacion_en_proceso',
  'anulado',
  'anulado_interno',
] as const;
export type EstadoComprobante = (typeof ESTADOS_COMPROBANTE)[number];

/** Estados en los que el comprobante es válido ante SUNAT. */
export const ESTADOS_VALIDOS_SUNAT: readonly EstadoComprobante[] = ['aceptado', 'observado'];

/** Estados en los que el sistema todavía espera un resultado. */
export const ESTADOS_EN_CURSO: readonly EstadoComprobante[] = [
  'pendiente',
  'enviando',
  'en_proceso',
  'en_resumen',
  'por_verificar',
  'anulacion_en_proceso',
];

export type TonoEstado = 'neutro' | 'info' | 'ok' | 'aviso' | 'alerta';

export const ETIQUETA_ESTADO: Record<EstadoComprobante, { texto: string; tono: TonoEstado }> = {
  pendiente: { texto: 'Por emitir', tono: 'neutro' },
  enviando: { texto: 'Enviando', tono: 'info' },
  en_proceso: { texto: 'En SUNAT', tono: 'info' },
  pendiente_resumen: { texto: 'Para resumen', tono: 'info' },
  en_resumen: { texto: 'En resumen', tono: 'info' },
  aceptado: { texto: 'Aceptado', tono: 'ok' },
  observado: { texto: 'Aceptado con obs.', tono: 'aviso' },
  rechazado: { texto: 'Rechazado', tono: 'alerta' },
  error_validacion: { texto: 'Datos inválidos', tono: 'alerta' },
  por_verificar: { texto: 'Por comprobar', tono: 'aviso' },
  sin_respuesta_sunat: { texto: 'Sin respuesta', tono: 'aviso' },
  anulacion_en_proceso: { texto: 'Anulando', tono: 'neutro' },
  anulado: { texto: 'Anulado', tono: 'neutro' },
  anulado_interno: { texto: 'Anulado (interno)', tono: 'neutro' },
};
