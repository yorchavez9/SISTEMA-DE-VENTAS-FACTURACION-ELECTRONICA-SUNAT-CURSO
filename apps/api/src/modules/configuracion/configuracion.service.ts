import { db } from '../../database/db.js';

/** Lee un ajuste de la tabla configuracion (columna JSON, que mysql2 ya entrega convertida). */
export async function leerAjuste<T>(clave: string, porDefecto: T): Promise<T> {
  const fila = await db('configuracion').where({ clave }).first('valor');
  return fila ? ((fila.valor ?? porDefecto) as T) : porDefecto;
}
