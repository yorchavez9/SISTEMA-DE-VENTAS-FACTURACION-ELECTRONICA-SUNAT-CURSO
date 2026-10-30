import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

// AES-256-GCM para secretos en reposo (ADR-14). Formato: iv(12) | tag(16) | cifrado.
const clave = Buffer.from(env.APP_ENC_KEY, 'base64');

export function cifrar(texto: string, con: Buffer = clave): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', con, iv);
  const cifrado = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), cifrado]);
}

export function descifrar(dato: Buffer, con: Buffer = clave): string {
  const iv = dato.subarray(0, 12);
  const tag = dato.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', con, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(dato.subarray(28)), decipher.final()]).toString('utf8');
}

/**
 * Rotación de APP_ENC_KEY: vuelve a cifrar con la clave nueva cada secreto guardado (credenciales
 * de API-PRO). Falla sin cambiar nada si algún valor no se puede descifrar con la clave actual.
 */
export function recifrar(dato: Buffer, nueva: Buffer): Buffer {
  const nuevo = cifrar(descifrar(dato), nueva);
  if (descifrar(nuevo, nueva) !== descifrar(dato)) throw new Error('Verificación del recifrado fallida');
  return nuevo;
}

export function sha256(texto: string): string {
  return createHash('sha256').update(texto).digest('hex');
}

/** Muestra solo los últimos 4 caracteres de un secreto. */
export function enmascarar(secreto: string): string {
  return secreto.length <= 4 ? '••••' : `••••${secreto.slice(-4)}`;
}
