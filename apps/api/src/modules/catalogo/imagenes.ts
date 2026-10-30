import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../../database/db.js';
import { ErrorApp, errores } from '../../shared/errors.js';
import { carpeta } from '../../shared/almacen.js';

// Imagen opcional del producto. El navegador la reduce antes de subirla; aquí se valida por su
// contenido (firma del archivo), no por la extensión ni por el Content-Type que declara el cliente.

const DIR = carpeta('productos');
export const MAX_BYTES = 2 * 1024 * 1024;

const FORMATOS = [
  { ext: 'jpg', mime: 'image/jpeg', es: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', mime: 'image/png', es: (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'webp', mime: 'image/webp', es: (b: Buffer) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
] as const;

/** URL pública (con sesión) de la imagen; el nombre lleva el hash, así que sirve de versión. */
export const urlImagen = (productoId: number, archivo: string | null) => (archivo ? `/api/productos/${productoId}/imagen?v=${archivo.split('-')[1]?.split('.')[0] ?? ''}` : null);

const nombreSeguro = (archivo: string) => /^\d+-[0-9a-f]{12}\.(jpg|png|webp)$/.test(archivo);

export async function guardar(productoId: number, datos: Buffer): Promise<string | null> {
  const p = await db('productos').where('id', productoId).first('id', 'imagen');
  if (!p) throw errores.noEncontrado('Producto');
  if (!datos.length) throw errores.validacion({ imagen: 'El archivo está vacío' });
  if (datos.length > MAX_BYTES) throw new ErrorApp(413, 'IMAGEN_GRANDE', 'La imagen supera 2 MB', { imagen: 'Máximo 2 MB' });
  const formato = FORMATOS.find((f) => f.es(datos));
  if (!formato) throw errores.validacion({ imagen: 'Formato no admitido: usa JPG, PNG o WebP' });

  const archivo = `${productoId}-${createHash('sha256').update(datos).digest('hex').slice(0, 12)}.${formato.ext}`;
  await mkdir(DIR, { recursive: true });
  await writeFile(path.join(DIR, archivo), datos);
  await db('productos').where('id', productoId).update({ imagen: archivo });
  if (p.imagen && p.imagen !== archivo && nombreSeguro(p.imagen)) await rm(path.join(DIR, p.imagen), { force: true });
  return urlImagen(productoId, archivo);
}

export async function eliminar(productoId: number): Promise<void> {
  const p = await db('productos').where('id', productoId).first('imagen');
  if (!p) throw errores.noEncontrado('Producto');
  await db('productos').where('id', productoId).update({ imagen: null });
  if (p.imagen && nombreSeguro(p.imagen)) await rm(path.join(DIR, p.imagen), { force: true });
}

export async function leer(productoId: number): Promise<{ datos: Buffer; mime: string }> {
  const p = await db('productos').where('id', productoId).first('imagen');
  if (!p?.imagen || !nombreSeguro(p.imagen)) throw errores.noEncontrado('Imagen');
  const datos = await readFile(path.join(DIR, p.imagen)).catch(() => null);
  if (!datos) throw errores.noEncontrado('Imagen');
  const formato = FORMATOS.find((f) => f.es(datos));
  return { datos, mime: formato?.mime ?? 'application/octet-stream' };
}
