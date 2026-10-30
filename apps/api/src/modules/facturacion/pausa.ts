import { db } from '../../database/db.js';
import { leerAjuste } from '../configuracion/configuracion.service.js';

// Pausa de la emisión ante errores que afectan a todos los comprobantes (credenciales inválidas,
// licencia, cupo agotado). Se reintenta sola cada 15 minutos; también se puede reanudar a mano.

const CLAVE = 'integracion.pausa';
const REVISION_MIN = 15;

export interface Pausa {
  motivo: string;
  codigo: string;
  desde: string;
  hasta: string;
}

export async function pausaActiva(): Promise<Pausa | null> {
  const p = await leerAjuste<Pausa | null>(CLAVE, null);
  if (!p) return null;
  return new Date(p.hasta) > new Date() ? p : null;
}

export async function leerPausa(): Promise<Pausa | null> {
  return leerAjuste<Pausa | null>(CLAVE, null);
}

export async function pausar(codigo: string, motivo: string): Promise<void> {
  const ahora = new Date();
  const valor: Pausa = { codigo, motivo, desde: ahora.toISOString(), hasta: new Date(ahora.getTime() + REVISION_MIN * 60_000).toISOString() };
  await db('configuracion').insert({ clave: CLAVE, valor: JSON.stringify(valor) }).onConflict('clave').merge(['valor']);
}

export async function reanudar(): Promise<void> {
  await db('configuracion').where('clave', CLAVE).delete();
}
