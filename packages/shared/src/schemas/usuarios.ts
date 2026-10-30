import { z } from 'zod';

export const ROLES = ['admin', 'supervisor', 'cajero', 'almacen'] as const;
export type Rol = (typeof ROLES)[number];

export const crearUsuarioSchema = z.object({
  usuario: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._-]{3,40}$/, 'Usa de 3 a 40 letras, números, punto, guion o guion bajo'),
  nombre: z.string().trim().min(2, 'Ingresa el nombre').max(120),
  email: z.string().trim().email('Email inválido').max(160).optional().or(z.literal('').transform(() => undefined)),
  rol: z.enum(ROLES),
  sucursalIds: z.array(z.coerce.number().int().positive()).min(1, 'Asigna al menos una sucursal'),
});
export type CrearUsuarioInput = z.infer<typeof crearUsuarioSchema>;

export const editarUsuarioSchema = crearUsuarioSchema.omit({ usuario: true }).extend({
  activo: z.boolean(),
});
export type EditarUsuarioInput = z.infer<typeof editarUsuarioSchema>;

export interface UsuarioDto {
  id: number;
  usuario: string;
  nombre: string;
  email: string | null;
  rol: Rol;
  activo: boolean;
  tienePin: boolean;
  bloqueado: boolean;
  sucursalIds: number[];
}

export const crearDispositivoSchema = z.object({
  nombre: z.string().trim().min(2).max(80),
  sucursalId: z.coerce.number().int().positive(),
});
