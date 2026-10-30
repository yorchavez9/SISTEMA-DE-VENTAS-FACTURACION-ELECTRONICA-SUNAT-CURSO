import type { SesionCargada } from '../modules/auth/sesiones.js';

declare global {
  namespace Express {
    interface Request {
      /** Sesión autenticada (la carga el middleware `cargarSesion`). */
      sesion?: SesionCargada;
    }
  }
}

export {};
