import type { Request } from 'express';
import type { Knex } from 'knex';
import { db } from '../database/db.js';

export interface EventoAuditoria {
  accion: string;
  entidad: string;
  entidadId?: string | number | null;
  antes?: unknown;
  despues?: unknown;
}

/** Registra una acción relevante. Usa `trx` para que quede en la misma transacción que el cambio. */
export async function auditar(req: Request | null, evento: EventoAuditoria, trx: Knex | Knex.Transaction = db): Promise<void> {
  await trx('auditoria').insert({
    usuario_id: req?.sesion?.usuario.id ?? null,
    operador_id: req?.sesion?.operador.id ?? null,
    sucursal_id: req?.sesion?.sucursalActiva?.id ?? null,
    accion: evento.accion,
    entidad: evento.entidad,
    entidad_id: evento.entidadId == null ? null : String(evento.entidadId),
    antes: evento.antes === undefined ? null : JSON.stringify(evento.antes),
    despues: evento.despues === undefined ? null : JSON.stringify(evento.despues),
    ip: req?.ip ?? null,
    request_id: (req?.id as string | undefined) ?? null,
  });
}
