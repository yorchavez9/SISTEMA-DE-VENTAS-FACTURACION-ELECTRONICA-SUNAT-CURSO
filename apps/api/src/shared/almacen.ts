import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../storage');

/**
 * Carpeta de archivos del sistema (apps/api/storage/<sub>). Las pruebas usan storage/test/<sub>:
 * sus ids se repiten con los de la base real y no deben pisar imágenes ni PDF/XML/CDR reales.
 */
export const carpeta = (sub: string) => path.join(RAIZ, env.NODE_ENV === 'test' ? 'test' : '', sub);
