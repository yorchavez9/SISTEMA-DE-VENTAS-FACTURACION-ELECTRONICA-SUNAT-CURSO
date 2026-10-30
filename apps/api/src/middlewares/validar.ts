import type { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import { errores } from '../shared/errors.js';

/** Valida y normaliza `req.body` con el esquema; el error lo traduce manejarErrores (422). */
export function validarBody<T extends z.ZodType>(esquema: T) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.body = esquema.parse(req.body ?? {});
    next();
  };
}

/** Valida `req.query` y deja el resultado en `res.locals.query` (en Express 5 req.query es de solo lectura). */
export function validarQuery<T extends z.ZodType>(esquema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.locals.query = esquema.parse(req.query);
    next();
  };
}

export function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw errores.noEncontrado();
  return id;
}
