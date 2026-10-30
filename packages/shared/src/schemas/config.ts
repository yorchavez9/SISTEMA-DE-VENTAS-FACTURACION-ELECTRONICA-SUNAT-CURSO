import { z } from 'zod';
import { MODOS_BOLETA } from '../enums.js';

// ---------- Empresa y conexión con API-PRO ----------

export const editarEmpresaSchema = z.object({
  nombreComercial: z.string().trim().min(1).max(255),
  modoEmision: z.enum(['simulacion', 'real']),
});

export const credencialesApiSchema = z.object({
  baseUrl: z.string().trim().url('URL inválida').refine((u) => u.startsWith('https://') || u.startsWith('http://localhost') || u.startsWith('http://api-pro.test'), 'Usa HTTPS'),
  apiKey: z.string().trim().min(20, 'API key inválida').max(200),
  apiSecret: z.string().trim().min(20, 'API secret inválido').max(200),
  /** Se pide la contraseña del administrador para confirmar el cambio. */
  password: z.string().min(1, 'Confirma con tu contraseña'),
  /** Obligatorio si las credenciales nuevas pertenecen a otro RUC. */
  confirmarCambioRuc: z.boolean().optional(),
});

export interface EmpresaDto {
  ruc: string | null;
  razonSocial: string | null;
  nombreComercial: string | null;
  direccionFiscal: string | null;
  tasaIgv: string;
  taxRegime: string | null;
  modoEmision: 'simulacion' | 'real';
  api: {
    baseUrl: string;
    origen: 'base_datos' | 'env' | 'ninguno';
    apiKey: string | null; // enmascarada
    entorno: 'beta' | 'production' | null;
    verificadaEn: string | null;
  };
}

export interface ProbarConexionDto {
  ok: boolean;
  ruc: string;
  razonSocial: string;
  entorno: string;
  tasaIgv: number;
  sunatDisponible: boolean;
  rateLimitPorMinuto: number | null;
  sucursalesApi: Array<{ id: number; codLocal: string; nombre: string; totalSeries: number; vinculadaA: number | null }>;
  seriesSincronizadas: number;
  avisos: string[];
}

// ---------- Sucursales ----------

export const crearSucursalSchema = z.object({
  nombre: z.string().trim().min(2).max(100),
  codLocal: z.string().regex(/^\d{4}$/, 'El código de local son 4 dígitos (ej. 0002)'),
  direccion: z.string().trim().min(3).max(255),
  ubigeo: z.string().regex(/^\d{6}$/, 'Ubigeo de 6 dígitos'),
  telefono: z.string().trim().max(20).optional(),
  modoBoletas: z.enum(MODOS_BOLETA).default('individual'),
  horaResumen: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora HH:MM').default('23:00'),
  /** Crea también la sucursal en API-PRO (operación de escritura en la API). */
  crearEnApi: z.boolean().default(false),
});
export type CrearSucursalInput = z.infer<typeof crearSucursalSchema>;

export const editarSucursalSchema = crearSucursalSchema.omit({ codLocal: true, crearEnApi: true }).extend({
  activo: z.boolean(),
});

export const vincularSucursalSchema = z.object({ apiSucursalId: z.coerce.number().int().positive() });

export interface SucursalDto {
  id: number;
  nombre: string;
  codLocal: string;
  apiSucursalId: number | null;
  direccion: string | null;
  ubigeo: string | null;
  telefono: string | null;
  modoBoletas: 'individual' | 'resumen';
  horaResumen: string;
  activo: boolean;
}

// ---------- Series ----------

export const TIPOS_SERIE = ['01', '03', '07', '08', '09'] as const;
export type TipoSerie = (typeof TIPOS_SERIE)[number];

/** Prefijos admitidos por API-PRO (Serie::PREFIJOS) para los tipos que usa este sistema. */
export const PREFIJOS_SERIE: Record<TipoSerie, readonly string[]> = {
  '01': ['F'],
  '03': ['B'],
  '07': ['F', 'B'],
  '08': ['F', 'B'],
  '09': ['T'],
};

export const NOMBRE_TIPO_SERIE: Record<TipoSerie, string> = {
  '01': 'Factura',
  '03': 'Boleta',
  '07': 'Nota de crédito',
  '08': 'Nota de débito',
  '09': 'Guía de remisión remitente',
};

export const serieCodigo = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{3}$/, 'La serie tiene 4 caracteres (ej. F101)');

export const validarSerieSchema = z.discriminatedUnion('operacion', [
  z.object({
    operacion: z.literal('crear'),
    tipoDoc: z.enum(TIPOS_SERIE),
    serie: serieCodigo,
    sucursalId: z.coerce.number().int().positive(),
    correlativoInicial: z.coerce.number().int().min(0).default(0),
  }),
  z.object({ operacion: z.literal('correlativo'), serieId: z.coerce.number().int().positive(), correlativo: z.coerce.number().int().min(0) }),
  z.object({ operacion: z.literal('mover'), serieId: z.coerce.number().int().positive(), sucursalId: z.coerce.number().int().positive() }),
  z.object({ operacion: z.literal('activar'), serieId: z.coerce.number().int().positive(), activo: z.boolean() }),
  z.object({ operacion: z.literal('predeterminada'), serieId: z.coerce.number().int().positive() }),
]);
export type OperacionSerie = z.infer<typeof validarSerieSchema>;

/** Igual que la validación, más la confirmación escrita (el nombre de la serie). */
export const aplicarSerieSchema = z.intersection(
  validarSerieSchema,
  z.object({ confirmacion: z.string().trim().toUpperCase(), confirmacionReforzada: z.boolean().optional() }),
);

export interface ResultadoValidacionSerie {
  permitido: boolean;
  bloqueos: string[];
  advertencias: string[];
  /** Texto que el usuario debe escribir para confirmar. */
  confirmacionRequerida: string;
  /** La serie es de otro sistema del RUC: exige confirmacionReforzada. */
  requiereConfirmacionReforzada: boolean;
}

export interface SerieDto {
  id: number;
  apiSerieId: number;
  tipoDoc: TipoSerie;
  serie: string;
  aplicaA: 'F' | 'B' | null;
  propia: boolean;
  activo: boolean;
  predeterminada: boolean;
  ultimoCorrelativo: number;
  sucursal: { id: number; nombre: string; codLocal: string } | null;
  apiSucursal: { id: number; codLocal: string } | null;
  sincronizadoEn: string | null;
}

// ---------- Tipo de cambio ----------

const tasa = z
  .string()
  .regex(/^\d{1,4}(\.\d{1,4})?$/, 'Tipo de cambio inválido (hasta 4 decimales)')
  .refine((v) => Number(v) > 0, 'Debe ser mayor a 0');

export const tipoCambioSchema = z
  .object({ compra: tasa, venta: tasa })
  .refine((t) => Number(t.venta) >= Number(t.compra), { message: 'La venta no puede ser menor que la compra', path: ['venta'] });

export interface TipoCambioDto {
  fecha: string;
  compra: string;
  venta: string;
  fuente: 'manual';
}

// ---------- Configuración tipada ----------

export const ajustesSchema = z.object({
  'sesion.inactividad_min': z.number().int().min(5).max(480),
  'ticket.mensaje_pie': z.string().max(200),
  'credito.limite_por_cliente': z.boolean(),
  'credito.bloquear_vencidos': z.boolean(),
  'alertas.comprobante_atascado_min': z.number().int().min(5).max(1440),
});
export type Ajustes = z.infer<typeof ajustesSchema>;

// ---------- Consulta de DNI y RUC (json.pe, MIGO) ----------

export const PROVEEDORES_DOCUMENTO = { jsonpe: 'json.pe', migo: 'MIGO' } as const;
export type ProveedorDocumento = keyof typeof PROVEEDORES_DOCUMENTO;
const codigoProveedor = z.enum(Object.keys(PROVEEDORES_DOCUMENTO) as [ProveedorDocumento, ...ProveedorDocumento[]]);

/** Proveedor tal como lo ve la web: el token nunca sale de la api (solo sus últimos 4 caracteres). */
export interface ProveedorDocumentoDto {
  codigo: ProveedorDocumento;
  nombre: string;
  activo: boolean;
  orden: number;
  /** "••••1234" si hay token guardado. */
  token: string | null;
}

export const proveedoresDocumentoSchema = z
  .object({
    /** El que se consulta primero; si no encuentra o falla, se prueba el otro y al final API-PRO. */
    principal: codigoProveedor,
    proveedores: z
      .array(
        z.object({
          codigo: codigoProveedor,
          activo: z.boolean(),
          /** Token nuevo; si no viene, se conserva el guardado. */
          token: z.string().trim().min(10, 'El token es muy corto').max(500).regex(/^[\x21-\x7e]+$/, 'El token no debe tener espacios').optional(),
          quitarToken: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(Object.keys(PROVEEDORES_DOCUMENTO).length),
  })
  .refine((d) => new Set(d.proveedores.map((p) => p.codigo)).size === d.proveedores.length, { message: 'Proveedor repetido', path: ['proveedores'] });
export type ProveedoresDocumentoInput = z.infer<typeof proveedoresDocumentoSchema>;

export const probarProveedorDocumentoSchema = z
  .object({ codigo: codigoProveedor, tipoDoc: z.enum(['1', '6']), numDoc: z.string().trim() })
  .refine((d) => (d.tipoDoc === '1' ? /^\d{8}$/ : /^\d{11}$/).test(d.numDoc), { message: 'El DNI tiene 8 dígitos y el RUC 11', path: ['numDoc'] });

export interface PruebaProveedorDocumentoDto {
  resultado: 'encontrado' | 'no_encontrado' | 'error';
  razonSocial: string | null;
  direccion: string | null;
  mensaje: string | null;
  duracionMs: number;
}
