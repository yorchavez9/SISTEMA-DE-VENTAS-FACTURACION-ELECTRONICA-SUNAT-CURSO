/** Nombre de cada rol para mostrar (los códigos vienen de la semilla de roles). */
export const NOMBRE_ROL: Record<string, string> = { admin: 'Administrador', supervisor: 'Supervisor', cajero: 'Cajero', almacen: 'Almacén' };

export const nombreRol = (codigo: string) => NOMBRE_ROL[codigo] ?? codigo;
