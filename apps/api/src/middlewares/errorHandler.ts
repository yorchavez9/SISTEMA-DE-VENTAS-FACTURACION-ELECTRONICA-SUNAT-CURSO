import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ErrorApi } from '@sv/shared';
import { logger } from '../config/logger.js';
import { ErrorApp } from '../shared/errors.js';

export const noEncontrado: RequestHandler = (req, res) => {
  const cuerpo: ErrorApi = { error: 'Ruta no encontrada', codigo: 'NO_ENCONTRADO', requestId: req.id as string };
  res.status(404).json(cuerpo);
};

export const manejarErrores: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.id as string;

  if (err instanceof ErrorApp) {
    const cuerpo: ErrorApi = { error: err.message, codigo: err.codigo, campos: err.campos, detalle: err.detalle, requestId };
    res.status(err.status).json(cuerpo);
    return;
  }

  if (err instanceof ZodError) {
    const campos = Object.fromEntries(err.issues.map((i) => [i.path.join('.'), i.message]));
    res.status(422).json({ error: 'Hay datos inválidos', codigo: 'VALIDACION', campos, requestId } satisfies ErrorApi);
    return;
  }

  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'JSON mal formado', codigo: 'SOLICITUD_INVALIDA', requestId } satisfies ErrorApi);
    return;
  }

  // body-parser: cuerpo por encima del límite (JSON de 1 MB o imagen de 2 MB).
  if ((err as { type?: string }).type === 'entity.too.large') {
    res.status(413).json({ error: 'El archivo o los datos enviados son demasiado grandes', codigo: 'DEMASIADO_GRANDE', requestId } satisfies ErrorApi);
    return;
  }

  logger.error({ err, requestId }, 'Error no controlado');
  res.status(500).json({ error: 'Error interno del servidor', codigo: 'ERROR_INTERNO', requestId } satisfies ErrorApi);
};
