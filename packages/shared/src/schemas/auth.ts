import { z } from 'zod';

export const password = z
  .string()
  .min(8, 'Mínimo 8 caracteres')
  .max(128, 'Máximo 128 caracteres')
  .regex(/[A-Za-z]/, 'Debe incluir al menos una letra')
  .regex(/\d/, 'Debe incluir al menos un número');

export const pin = z.string().regex(/^\d{4,6}$/, 'El PIN debe tener de 4 a 6 dígitos');

export const loginSchema = z.object({
  usuario: z.string().trim().toLowerCase().min(1, 'Ingresa tu usuario').max(40),
  password: z.string().min(1, 'Ingresa tu contraseña').max(128),
  dispositivoToken: z.string().max(100).optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const cambiarPasswordSchema = z.object({
  actual: z.string().min(1, 'Ingresa tu contraseña actual'),
  nueva: password,
});

export const fijarPinSchema = z.object({
  password: z.string().min(1, 'Ingresa tu contraseña'),
  pinNuevo: pin,
});

export const cambiarOperadorSchema = z.object({
  usuarioId: z.coerce.number().int().positive(),
  pin,
});

export const ACCIONES_AUTORIZABLES = ['descuento', 'anular', 'abrir_cajon', 'credito_excedido', 'credenciales_api'] as const;
export type AccionAutorizable = (typeof ACCIONES_AUTORIZABLES)[number];

export const autorizarSchema = z.object({
  usuarioId: z.coerce.number().int().positive(),
  pin,
  accion: z.enum(ACCIONES_AUTORIZABLES),
});

export const elegirSucursalSchema = z.object({ sucursalId: z.coerce.number().int().positive() });

export interface SucursalResumen {
  id: number;
  nombre: string;
  codLocal: string;
}

export interface UsuarioSesion {
  id: number;
  usuario: string;
  nombre: string;
  rol: string;
}

export interface SesionDto {
  usuario: UsuarioSesion;
  /** Cajero activo en el POS (cambiado por PIN); igual al usuario si no hubo cambio. */
  operador: UsuarioSesion;
  permisos: string[];
  sucursales: SucursalResumen[];
  sucursalActiva: SucursalResumen | null;
  dispositivo: { id: number; nombre: string } | null;
  debeCambiarPassword: boolean;
  csrfToken: string;
}

// ---------- Primera instalación ----------

/** Registro del super administrador cuando la base aún no tiene usuarios. */
export const instalacionSchema = z
  .object({
    usuario: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/, 'De 3 a 40 letras, números, punto, guion o guion bajo'),
    nombre: z.string().trim().min(3, 'Escribe tu nombre').max(120),
    password,
    repetir: z.string(),
    /** Código de un solo uso que la api escribe en su log (exigido solo en producción). */
    codigo: z.string().trim().max(20).optional(),
  })
  .refine((d) => d.password === d.repetir, { message: 'Las contraseñas no coinciden', path: ['repetir'] });
export type InstalacionInput = z.infer<typeof instalacionSchema>;

export interface EstadoInstalacionDto {
  /** true si todavía no existe ningún usuario: se muestra la configuración inicial. */
  pendiente: boolean;
  requiereCodigo: boolean;
}

// ---------- Ingreso con PIN (como ferretería: se elige el usuario de una lista y se escribe el PIN) ----------

export const ingresoPinSchema = z.object({
  usuarioId: z.coerce.number().int().positive(),
  pin,
  dispositivoToken: z.string().max(100).optional(),
});
export type IngresoPinInput = z.infer<typeof ingresoPinSchema>;

export interface UsuarioIngresoDto {
  id: number;
  nombre: string;
  rol: string;
}
