import { logger } from '../config/logger.js';
import type { Knex } from 'knex';
import { db } from '../database/db.js';

export interface Trabajo {
  id: number;
  tipo: string;
  entidad_tipo: string;
  entidad_id: number;
  intentos: number;
}

/** Resultado de un manejador: terminar, o reprogramar dentro de `reintentarEnSeg`. */
export type Resultado = { estado: 'hecho' } | { estado: 'reintentar'; reintentarEnSeg: number; error?: string } | { estado: 'fallido'; error: string };

export type Manejador = (trabajo: Trabajo) => Promise<Resultado>;

/** Registro de manejadores por tipo de trabajo (se completa en la fase 7). */
export const manejadores: Record<string, Manejador> = {};

const BLOQUEO_SEG = 120;
const LOTE = 5;

/** Encola un trabajo dentro de la transacción del llamador (patrón outbox). */
export async function encolar(
  trx: Knex,
  tipo: string,
  entidadTipo: string,
  entidadId: number,
  opciones: { prioridad?: number; ejecutarEn?: Date } = {},
): Promise<void> {
  await trx('outbox_trabajos')
    .insert({
      tipo,
      entidad_tipo: entidadTipo,
      entidad_id: entidadId,
      prioridad: opciones.prioridad ?? 5,
      ejecutar_en: opciones.ejecutarEn ?? trx.raw('CURRENT_TIMESTAMP(3)'),
    })
    .onConflict()
    .ignore(); // uq_outbox_activo: ya existe un trabajo activo igual
}

/** Toma hasta LOTE trabajos con SKIP LOCKED y los ejecuta. Devuelve cuántos procesó. */
export async function procesarLote(): Promise<number> {
  const tomados = await db.transaction(async (trx) => {
    const filas: Trabajo[] = await trx('outbox_trabajos')
      .select('id', 'tipo', 'entidad_tipo', 'entidad_id', 'intentos')
      .where('estado', 'pendiente')
      .andWhere('ejecutar_en', '<=', trx.raw('CURRENT_TIMESTAMP(3)'))
      .orWhere((q) => q.where('estado', 'en_proceso').andWhere('bloqueado_hasta', '<', trx.raw('CURRENT_TIMESTAMP(3)')))
      .orderBy([{ column: 'prioridad' }, { column: 'id' }])
      .limit(LOTE)
      .forUpdate()
      .skipLocked();
    if (filas.length) {
      await trx('outbox_trabajos')
        .whereIn('id', filas.map((f) => f.id))
        .update({
          estado: 'en_proceso',
          intentos: trx.raw('intentos + 1'),
          bloqueado_hasta: trx.raw('CURRENT_TIMESTAMP(3) + INTERVAL ? SECOND', [BLOQUEO_SEG]),
        });
    }
    return filas;
  });

  for (const trabajo of tomados) {
    const manejador = manejadores[trabajo.tipo];
    let resultado: Resultado;
    try {
      resultado = manejador
        ? await manejador(trabajo)
        : { estado: 'fallido', error: `Sin manejador para el tipo ${trabajo.tipo}` };
    } catch (err) {
      logger.error({ err, trabajoId: trabajo.id, tipo: trabajo.tipo }, 'El manejador lanzó una excepción');
      resultado = { estado: 'reintentar', reintentarEnSeg: 60, error: err instanceof Error ? err.message : String(err) };
    }
    await finalizar(trabajo.id, resultado);
  }
  return tomados.length;
}

async function finalizar(id: number, r: Resultado): Promise<void> {
  if (r.estado === 'hecho') {
    await db('outbox_trabajos').where({ id }).update({ estado: 'hecho', bloqueado_hasta: null, ultimo_error: null });
  } else if (r.estado === 'fallido') {
    await db('outbox_trabajos').where({ id }).update({ estado: 'fallido', bloqueado_hasta: null, ultimo_error: r.error });
  } else {
    await db('outbox_trabajos')
      .where({ id })
      .update({
        estado: 'pendiente',
        bloqueado_hasta: null,
        ultimo_error: r.error ?? null,
        ejecutar_en: db.raw('CURRENT_TIMESTAMP(3) + INTERVAL ? SECOND', [r.reintentarEnSeg]),
      });
  }
}
