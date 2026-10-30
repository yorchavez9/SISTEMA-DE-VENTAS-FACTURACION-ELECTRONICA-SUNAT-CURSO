import { z } from 'zod';
import { rucValido } from './comunes.js';

/** Documentos de identidad que se guardan (catálogo 06, sin el "0 - sin documento"). */
export const TIPOS_DOC_TERCERO = ['1', '6', '4', '7', 'A'] as const;
export type TipoDocTercero = (typeof TIPOS_DOC_TERCERO)[number];

export const NOMBRE_TIPO_DOC: Record<TipoDocTercero, string> = {
  '1': 'DNI',
  '6': 'RUC',
  '4': 'Carnet de extranjería',
  '7': 'Pasaporte',
  A: 'Cédula diplomática',
};

/** Valida el número según el tipo. Devuelve el mensaje de error o null. */
export function errorNumeroDocumento(tipo: string, numero: string): string | null {
  switch (tipo) {
    case '1':
      return /^\d{8}$/.test(numero) ? null : 'El DNI tiene 8 dígitos';
    case '6':
      return rucValido(numero) ? null : 'RUC inválido (11 dígitos con dígito verificador correcto)';
    case '4':
    case '7':
      return /^[A-Za-z0-9]{6,12}$/.test(numero) ? null : 'Entre 6 y 12 letras o números';
    case 'A':
      return /^[A-Za-z0-9]{6,15}$/.test(numero) ? null : 'Entre 6 y 15 letras o números';
    default:
      return 'Tipo de documento inválido';
  }
}

const documento = {
  tipoDoc: z.enum(TIPOS_DOC_TERCERO),
  numDoc: z.string().trim().toUpperCase(),
};

const opcional = (max: number) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));

const conDocumentoValido = <T extends { tipoDoc: string; numDoc: string }>(v: T, ctx: z.RefinementCtx) => {
  const error = errorNumeroDocumento(v.tipoDoc, v.numDoc);
  if (error) ctx.addIssue({ code: 'custom', message: error, path: ['numDoc'] });
};

export const clienteSchema = z
  .object({
    ...documento,
    razonSocial: z.string().trim().min(2, 'Ingresa el nombre o razón social').max(255),
    direccion: opcional(255),
    ubigeo: z.string().regex(/^\d{6}$/, 'Ubigeo de 6 dígitos').optional().or(z.literal('').transform(() => undefined)),
    email: z.string().trim().email('Email inválido').max(160).optional().or(z.literal('').transform(() => undefined)),
    telefono: opcional(30),
    limiteCredito: z
      .string()
      .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Importe inválido')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    monedaCredito: z.enum(['PEN', 'USD']).optional(),
    activo: z.boolean().default(true),
  })
  .superRefine(conDocumentoValido)
  .refine((c) => !c.limiteCredito || c.monedaCredito, { message: 'Indica la moneda del límite', path: ['monedaCredito'] });
export type ClienteInput = z.infer<typeof clienteSchema>;

export const proveedorSchema = z
  .object({
    ...documento,
    razonSocial: z.string().trim().min(2, 'Ingresa la razón social').max(255),
    direccion: opcional(255),
    contacto: opcional(120),
    email: z.string().trim().email('Email inválido').max(160).optional().or(z.literal('').transform(() => undefined)),
    telefono: opcional(30),
    activo: z.boolean().default(true),
  })
  .superRefine(conDocumentoValido);
export type ProveedorInput = z.infer<typeof proveedorSchema>;

export interface ClienteDto {
  id: number;
  tipoDoc: TipoDocTercero;
  numDoc: string;
  razonSocial: string;
  direccion: string | null;
  ubigeo: string | null;
  email: string | null;
  telefono: string | null;
  limiteCredito: string | null;
  monedaCredito: 'PEN' | 'USD' | null;
  activo: boolean;
}

export interface ProveedorDto {
  id: number;
  tipoDoc: TipoDocTercero;
  numDoc: string;
  razonSocial: string;
  direccion: string | null;
  contacto: string | null;
  email: string | null;
  telefono: string | null;
  activo: boolean;
}

export const buscarDocumentoSchema = z
  .object({ tipoDoc: z.enum(TIPOS_DOC_TERCERO), numDoc: z.string().trim().toUpperCase() })
  .superRefine(conDocumentoValido);

/** Resultado de buscar un documento: registrado localmente, encontrado en SUNAT/RENIEC, o nada. */
export interface ResultadoBusquedaDocumento {
  origen: 'local' | 'externo' | 'no_encontrado';
  /** Registro local (si existe). */
  id: number | null;
  tipoDoc: TipoDocTercero;
  numDoc: string;
  razonSocial: string | null;
  direccion: string | null;
  /** Solo RUC consultado en SUNAT: estado y condición del contribuyente. */
  estado: string | null;
  condicion: string | null;
  /** De dónde salieron los datos externos (json.pe, MIGO o API-PRO). */
  fuente?: string | null;
  avisos: string[];
}
