import type { EstadoComprobante } from '@sv/shared';

// Contrato con API-PRO para facturas y boletas (docs/00-plan-implementacion.md §2.4, verificado en
// StoreInvoiceRequest / StoreBoletaRequest). Funciones puras: sin base de datos ni red.

export const RECURSO_API: Record<string, string> = {
  '01': 'facturas',
  '03': 'boletas',
  '07': 'notas-credito',
  '08': 'notas-debito',
};

export interface ComprobanteParaEnvio {
  tipo_doc: string;
  serie: string;
  fecha_emision: string;
  moneda: string;
  forma_pago: 'contado' | 'credito';
  modo_envio: 'individual' | 'resumen';
  cliente_tipo_doc: string;
  cliente_num_doc: string;
  cliente_razon_social: string;
  cliente_direccion: string | null;
  cliente_email: string | null;
}

export interface ItemParaEnvio {
  codigo: string | null;
  descripcion: string;
  unidad: string;
  tip_afe_igv: string;
  cantidad: string;
  precio_unitario: string;
}

export interface CuotaParaEnvio {
  monto: string;
  fecha_pago: string;
}

/**
 * Payload de POST /facturas o /boletas. Nunca incluye totales ni montos calculados (guarda B7):
 * API-PRO calcula con cantidad, precio con IGV y afectación, igual que el sistema.
 */
export function construirPayload(c: ComprobanteParaEnvio, items: ItemParaEnvio[], cuotas: CuotaParaEnvio[], codLocal: string | null): Record<string, unknown> {
  const cliente: Record<string, string> = {
    tipo_doc: c.cliente_tipo_doc,
    num_doc: c.cliente_num_doc,
    razon_social: c.cliente_razon_social,
  };
  if (c.cliente_direccion) cliente.direccion = c.cliente_direccion;
  if (c.cliente_email) cliente.email = c.cliente_email;

  const payload: Record<string, unknown> = {
    serie: c.serie,
    fecha_emision: c.fecha_emision,
    tipo_moneda: c.moneda,
    forma_pago: c.forma_pago === 'credito' ? 'Credito' : 'Contado',
    cliente,
    items: items.map((i) => ({
      ...(i.codigo ? { codigo: i.codigo } : {}),
      descripcion: i.descripcion,
      unidad: i.unidad,
      cantidad: Number(i.cantidad),
      precio_unitario: Number(i.precio_unitario),
      tip_afe_igv: i.tip_afe_igv,
    })),
    enviar_automatico: true,
  };
  if (codLocal) payload.cod_local = codLocal;
  if (c.tipo_doc === '01') payload.tipo_operacion = '0101'; // venta interna
  if (c.forma_pago === 'credito') payload.cuotas = cuotas.map((q) => ({ monto: Number(q.monto), fecha_pago: q.fecha_pago }));
  if (c.tipo_doc === '03' && c.modo_envio === 'resumen') payload.solo_registro = true;
  return payload;
}

export interface NotaParaEnvio {
  cod_motivo: string;
  des_motivo: string;
  afectado: { tipo_doc: string; serie: string; correlativo: number };
}

/**
 * Payload de POST /notas-credito o /notas-debito (StoreCreditNoteRequest / StoreDebitNoteRequest).
 * Las notas no llevan forma de pago ni cuotas (API-PRO no las admite) y siempre se envían individualmente.
 */
export function construirPayloadNota(c: ComprobanteParaEnvio, items: ItemParaEnvio[], nota: NotaParaEnvio, codLocal: string | null): Record<string, unknown> {
  const base = construirPayload({ ...c, forma_pago: 'contado', modo_envio: 'individual', tipo_doc: c.tipo_doc }, items, [], codLocal);
  delete base.forma_pago;
  delete base.tipo_operacion;
  return {
    ...base,
    doc_afectado_tipo: nota.afectado.tipo_doc,
    doc_afectado_serie: nota.afectado.serie,
    doc_afectado_correlativo: String(nota.afectado.correlativo), // API-PRO lo espera como texto
    cod_motivo: nota.cod_motivo,
    des_motivo: nota.des_motivo.slice(0, 250),
  };
}

export interface SunatApi {
  estado: string;
  codigo: string | number | null;
  descripcion: string | null;
  notas: unknown;
  hash_cpe?: string | null;
}

export interface DocumentoApi {
  id: number;
  serie: string;
  correlativo: number;
  numero_completo: string;
  totales?: { total?: number };
  sunat: SunatApi;
}

/** Estados locales que ya no requieren consultar a API-PRO (salvo acción del usuario). */
export const ESTADOS_FINALES: readonly EstadoComprobante[] = ['aceptado', 'observado', 'rechazado', 'anulado', 'sin_respuesta_sunat', 'pendiente_resumen', 'error_validacion'];

/** Traduce el estado de API-PRO al estado local (docs/00-plan-implementacion.md §10.1). */
export function estadoLocal(sunat: SunatApi, modoEnvio: 'individual' | 'resumen'): EstadoComprobante {
  const codigo = Number(sunat.codigo);
  const conNotas = Array.isArray(sunat.notas) ? sunat.notas.length > 0 : Boolean(sunat.notas);
  switch (sunat.estado) {
    case 'aceptado':
      return conNotas || (Number.isFinite(codigo) && codigo >= 4000) ? 'observado' : 'aceptado';
    case 'rechazado':
      return 'rechazado';
    case 'anulado':
      return 'anulado';
    case 'anulacion_en_proceso':
      return 'anulacion_en_proceso';
    case 'pendiente':
      if (String(sunat.codigo) === 'SUNAT_TIMEOUT') return 'sin_respuesta_sunat';
      // Una boleta registrada con solo_registro espera el resumen diario.
      return modoEnvio === 'resumen' ? 'pendiente_resumen' : 'en_proceso';
    default: // 'enviado' u otro estado transitorio
      return 'en_proceso';
  }
}

/** Mensaje legible de un error de validación de API-PRO (mensaje + errores por campo). */
export function mensajeValidacion(cuerpo: { mensaje?: string; errores?: Record<string, string[]> | string[] } | null): string {
  if (!cuerpo) return 'API-PRO rechazó los datos';
  const errores = Array.isArray(cuerpo.errores) ? cuerpo.errores : Object.entries(cuerpo.errores ?? {}).map(([c, m]) => `${c}: ${(m as string[]).join(', ')}`);
  return [cuerpo.mensaje, ...errores].filter(Boolean).join(' · ').slice(0, 2000);
}

/** Espera (s) antes del siguiente intento según el número de intentos previos. */
export function esperaReintento(intentos: number, tabla: readonly number[]): number {
  return tabla[Math.max(0, Math.min(intentos, tabla.length - 1))]!;
}
export const ESPERAS_ENVIO = [30, 120, 600, 1800, 7200] as const;
export const ESPERAS_CONSULTA = [5, 10, 20, 40, 60, 120, 300, 600, 1200, 1800, 3600] as const;
