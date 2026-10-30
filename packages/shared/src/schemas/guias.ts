import { z } from 'zod';
import { fecha, rucValido, type Pagina } from './comunes.js';
import { errorNumeroDocumento, TIPOS_DOC_TERCERO } from './terceros.js';

/**
 * Motivos de traslado (catálogo SUNAT 20) que ofrece el sistema. Quedan fuera los que exigen DAM o
 * declaración simplificada (08 importación, 09 exportación, 19 zona primaria) y "13 otros", que
 * SUNAT pide describir y API-PRO no recibe la descripción.
 */
export const MOTIVOS_TRASLADO = {
  '01': 'Venta',
  '14': 'Venta sujeta a confirmación del comprador',
  '02': 'Compra',
  '04': 'Traslado entre establecimientos de la misma empresa',
  '06': 'Devolución',
} as const;
export type MotivoTraslado = keyof typeof MOTIVOS_TRASLADO;

/** El destinatario es la propia empresa (SUNAT 2554). */
export const MOTIVOS_DESTINO_PROPIO: readonly string[] = ['02', '04', '07'];
/** El destinatario no puede ser la propia empresa (SUNAT 2555). */
export const MOTIVOS_DESTINO_AJENO: readonly string[] = ['01', '03', '05', '06', '09', '14', '17'];
/** El destinatario debe tener RUC (SUNAT 3417). */
export const MOTIVOS_DESTINO_RUC: readonly string[] = ['06', '17', '19'];

export const MODALIDADES_TRASLADO = { '01': 'Transporte público', '02': 'Transporte privado' } as const;
export type ModalidadTraslado = keyof typeof MODALIDADES_TRASLADO;

export const ESTADOS_GUIA = ['pendiente', 'enviando', 'por_verificar', 'en_proceso', 'aceptado', 'rechazado', 'error_validacion', 'sin_respuesta_sunat'] as const;
export type EstadoGuia = (typeof ESTADOS_GUIA)[number];
export const ETIQUETA_ESTADO_GUIA: Record<EstadoGuia, string> = {
  pendiente: 'Pendiente',
  enviando: 'Enviando',
  por_verificar: 'Por verificar',
  en_proceso: 'En SUNAT',
  aceptado: 'Aceptada',
  rechazado: 'Rechazada',
  error_validacion: 'Error de datos',
  sin_respuesta_sunat: 'Sin respuesta',
};

const placa = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase().replace(/[-\s]/g, ''))
  .pipe(z.string().regex(/^[A-Z0-9]{6,8}$/, 'Placa inválida (6 a 8 letras o números, sin guion)'));
const ubigeo = z.string().trim().regex(/^\d{6}$/, 'Ubigeo inválido (6 dígitos)');
const ruc = z.string().trim().refine(rucValido, 'RUC inválido (11 dígitos con dígito verificador correcto)');
const cantidad = z
  .string()
  .trim()
  .regex(/^\d{1,11}(\.\d{1,3})?$/, 'Cantidad inválida')
  .refine((v) => Number(v) > 0, 'Debe ser mayor a 0');

// ---------- Datos maestros ----------

export const transportistaSchema = z.object({
  ruc,
  razonSocial: z.string().trim().min(3, 'Escribe la razón social').max(255),
  nroMtc: z.string().trim().max(20).optional().transform((v) => v || undefined),
  activo: z.boolean().default(true),
});
export type TransportistaInput = z.infer<typeof transportistaSchema>;
export interface TransportistaDto { id: number; ruc: string; razonSocial: string; nroMtc: string | null; activo: boolean }

export const vehiculoSchema = z.object({
  placa,
  nroCirculacion: z
    .string()
    .trim()
    .max(15)
    .optional()
    .transform((v) => (v ? v.toUpperCase() : undefined))
    .refine((v) => !v || /^[A-Z0-9]{10,15}$/.test(v), 'Certificado de circulación inválido (10 a 15 caracteres)'),
  descripcion: z.string().trim().max(120).optional().transform((v) => v || undefined),
  activo: z.boolean().default(true),
});
export type VehiculoInput = z.infer<typeof vehiculoSchema>;
export interface VehiculoDto { id: number; placa: string; nroCirculacion: string | null; descripcion: string | null; activo: boolean }

export const conductorSchema = z
  .object({
    tipoDoc: z.enum(['1', '4', '7']),
    numDoc: z.string().trim().max(15),
    nombres: z.string().trim().min(2, 'Escribe los nombres').max(100),
    apellidos: z.string().trim().min(2, 'Escribe los apellidos').max(100),
    licencia: z.string().trim().toUpperCase().min(5, 'Licencia inválida').max(20),
    activo: z.boolean().default(true),
  })
  .superRefine((c, ctx) => {
    const e = errorNumeroDocumento(c.tipoDoc, c.numDoc);
    if (e) ctx.addIssue({ code: 'custom', message: e, path: ['numDoc'] });
  });
export type ConductorInput = z.infer<typeof conductorSchema>;
export interface ConductorDto { id: number; tipoDoc: string; numDoc: string; nombres: string; apellidos: string; licencia: string; activo: boolean }

// ---------- Guía ----------

export const guiaSchema = z
  .object({
    serieId: z.coerce.number().int().positive().optional(),
    origen: z.discriminatedUnion('tipo', [
      z.object({ tipo: z.literal('venta'), comprobanteId: z.coerce.number().int().positive() }),
      z.object({ tipo: z.literal('traslado'), trasladoId: z.coerce.number().int().positive() }),
      z.object({ tipo: z.literal('manual') }),
    ]),
    destinatario: z.object({
      tipoDoc: z.enum(TIPOS_DOC_TERCERO),
      numDoc: z.string().trim().max(15),
      razonSocial: z.string().trim().min(3, 'Escribe el nombre o razón social').max(255),
    }),
    codTraslado: z.enum(Object.keys(MOTIVOS_TRASLADO) as [MotivoTraslado, ...MotivoTraslado[]]),
    modTraslado: z.enum(['01', '02']),
    /** Vehículo de categoría M1 o L (auto o moto): no exige vehículo ni conductor. */
    vehiculoM1l: z.boolean().default(false),
    fechaTraslado: fecha,
    fechaEntregaTransportista: fecha.optional(),
    pesoTotal: z
      .string()
      .trim()
      .regex(/^\d{1,9}(\.\d{1,3})?$/, 'Peso inválido')
      .refine((v) => Number(v) > 0, 'El peso debe ser mayor a 0'),
    numBultos: z.coerce.number().int().positive().max(999_999).optional(),
    partida: z.object({ ubigeo, direccion: z.string().trim().min(5, 'Escribe la dirección').max(500) }),
    llegada: z.object({ ubigeo, direccion: z.string().trim().min(5, 'Escribe la dirección').max(500) }),
    transportistaId: z.coerce.number().int().positive().optional(),
    vehiculoId: z.coerce.number().int().positive().optional(),
    vehiculosSecundariosIds: z.array(z.coerce.number().int().positive()).max(2).default([]),
    conductoresIds: z.array(z.coerce.number().int().positive()).max(3).default([]),
    observacion: z.string().trim().max(500).optional().transform((v) => v || undefined),
    items: z
      .array(
        z.object({
          productoId: z.coerce.number().int().positive().optional(),
          codigo: z.string().trim().max(50).optional(),
          descripcion: z.string().trim().min(2, 'Describe el bien').max(500),
          unidad: z.string().trim().min(1).max(5),
          cantidad,
        }),
      )
      .min(1, 'Agrega al menos un bien')
      .max(200),
  })
  .superRefine((g, ctx) => {
    const e = errorNumeroDocumento(g.destinatario.tipoDoc, g.destinatario.numDoc);
    if (e) ctx.addIssue({ code: 'custom', message: e, path: ['destinatario', 'numDoc'] });
    if (g.modTraslado === '01' && !g.vehiculoM1l) {
      if (!g.transportistaId) ctx.addIssue({ code: 'custom', message: 'Elige el transportista', path: ['transportistaId'] });
      if (!g.fechaEntregaTransportista) ctx.addIssue({ code: 'custom', message: 'Indica cuándo se entregan los bienes al transportista', path: ['fechaEntregaTransportista'] });
      else if (g.fechaEntregaTransportista < g.fechaTraslado) ctx.addIssue({ code: 'custom', message: 'No puede ser anterior a la fecha de traslado', path: ['fechaEntregaTransportista'] });
    }
    if (g.modTraslado === '02' && !g.vehiculoM1l) {
      if (!g.vehiculoId) ctx.addIssue({ code: 'custom', message: 'Elige el vehículo', path: ['vehiculoId'] });
      if (g.conductoresIds.length === 0) ctx.addIssue({ code: 'custom', message: 'Elige al menos un conductor', path: ['conductoresIds'] });
    }
    if (new Set(g.conductoresIds).size !== g.conductoresIds.length) ctx.addIssue({ code: 'custom', message: 'Un conductor aparece dos veces', path: ['conductoresIds'] });
    if (MOTIVOS_DESTINO_RUC.includes(g.codTraslado) && g.destinatario.tipoDoc !== '6') {
      ctx.addIssue({ code: 'custom', message: 'Para este motivo el destinatario debe tener RUC', path: ['destinatario', 'tipoDoc'] });
    }
  });
export type GuiaInput = z.infer<typeof guiaSchema>;

export const filtroGuiasSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  desde: fecha.optional(),
  hasta: fecha.optional(),
  estado: z.enum(ESTADOS_GUIA).optional(),
  q: z.string().trim().max(60).optional(),
});
export type FiltroGuias = z.infer<typeof filtroGuiasSchema>;

export type AccionGuia = 'reintentar' | 'consultar' | 'corregir' | 'pdf' | 'xml' | 'cdr';

export interface GuiaListaDto {
  id: number;
  numeroCompleto: string | null;
  serie: string;
  fechaEmision: string;
  fechaTraslado: string;
  destinatario: string;
  motivo: string;
  estado: EstadoGuia;
  simulado: boolean;
  sucursal: string;
}

export interface GuiaDetalleDto extends GuiaListaDto {
  sucursalId: number;
  origen: { tipo: 'venta' | 'traslado' | 'manual'; comprobanteId: number | null; comprobante: string | null; trasladoId: number | null };
  destinatarioDoc: { tipoDoc: string; numDoc: string; razonSocial: string };
  codTraslado: string;
  modTraslado: ModalidadTraslado;
  vehiculoM1l: boolean;
  fechaEntregaTransportista: string | null;
  pesoTotal: string;
  numBultos: number | null;
  partida: { ubigeo: string; direccion: string; lugar: string | null };
  llegada: { ubigeo: string; direccion: string; lugar: string | null };
  transportista: { ruc: string; razonSocial: string; nroMtc: string | null } | null;
  vehiculo: { placa: string; nroCirculacion: string | null; secundarios: string[] } | null;
  conductores: Array<{ tipo: 'Principal' | 'Secundario'; tipoDoc: string; numDoc: string; nombre: string; licencia: string }>;
  observacion: string | null;
  items: Array<{ productoId: number | null; codigo: string | null; descripcion: string; unidad: string; cantidad: string }>;
  sunatCodigo: string | null;
  sunatDescripcion: string | null;
  ultimoError: string | null;
  acciones: AccionGuia[];
  /** Datos guardados para reabrir el formulario al corregir. */
  ids: { serieId: number; transportistaId: number | null; vehiculoId: number | null; conductoresIds: number[] };
  creadoEn: string;
}

/** Datos sugeridos para el formulario a partir de una venta o un traslado. */
export interface BorradorGuiaDto {
  origen: GuiaInput['origen'];
  codTraslado: MotivoTraslado;
  destinatario: { tipoDoc: string; numDoc: string; razonSocial: string } | null;
  partida: { ubigeo: string; direccion: string } | null;
  llegada: { ubigeo: string; direccion: string } | null;
  items: Array<{ productoId: number | null; codigo: string | null; descripcion: string; unidad: string; cantidad: string }>;
  advertencias: string[];
  guiasPrevias: string[];
}

export interface UbigeoDto { codigo: string; nombre: string }

export type PaginaGuias = Pagina<GuiaListaDto>;
