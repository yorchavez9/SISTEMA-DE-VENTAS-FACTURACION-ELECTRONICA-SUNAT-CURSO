import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';

// argon2id con los parámetros recomendados por OWASP (m=19 MiB, t=2, p=1).
const OPCIONES = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashClave(texto: string): Promise<string> {
  return hash(texto, OPCIONES);
}

export async function verificarClave(hashGuardado: string, texto: string): Promise<boolean> {
  try {
    return await verify(hashGuardado, texto);
  } catch {
    return false;
  }
}

/** Hash ficticio para igualar el tiempo de respuesta cuando el usuario no existe. */
let hashFicticio: Promise<string> | undefined;
export async function verificarFicticio(texto: string): Promise<false> {
  hashFicticio ??= hashClave('usuario-inexistente');
  await verificarClave(await hashFicticio, texto);
  return false;
}

export function tokenAleatorio(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Contraseña temporal legible: 12 caracteres sin ambiguos (0/O, 1/l). */
export function passwordTemporal(): string {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(12);
  let s = '';
  for (const b of bytes) s += alfabeto[b % alfabeto.length];
  // Garantiza letra y número para cumplir la política.
  return `${s.slice(0, 10)}${alfabeto[(bytes[0] ?? 0) % 24]}${(bytes[1] ?? 0) % 10}`;
}

/** Minutos de bloqueo tras `intentos` fallidos (progresivo, con tope). */
export function minutosBloqueo(intentos: number, umbral: number, tope: number): number {
  if (intentos < umbral) return 0;
  return Math.min(tope, 2 ** (intentos - umbral));
}
