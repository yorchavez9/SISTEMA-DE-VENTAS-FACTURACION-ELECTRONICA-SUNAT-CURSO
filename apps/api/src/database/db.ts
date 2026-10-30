import knexFactory, { type Knex } from 'knex';
import { env } from '../config/env.js';

/** `database: null` conecta al servidor sin seleccionar base (para crearla o eliminarla). */
export function configKnex(database: string | null = env.DB_NAME): Knex.Config {
  return {
    client: 'mysql2',
    connection: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: database ?? undefined,
      // Todas las fechas en UTC (ADR-13). DATE se devuelve como string 'YYYY-MM-DD'.
      timezone: 'Z',
      dateStrings: ['DATE'],
      // DECIMAL llega como string para no perder precisión (ADR-12).
      decimalNumbers: false,
      supportBigNumbers: true,
      bigNumberStrings: false,
      charset: 'utf8mb4',
      // mysql2 acepta una lista de tipos en dateStrings; los tipos de Knex solo admiten boolean.
    } as unknown as Knex.MySql2ConnectionConfig,
    pool: {
      min: 0,
      max: 10,
      afterCreate(conn: { query: (sql: string, cb: (err: Error | null) => void) => void }, done: (err: Error | null, conn: unknown) => void) {
        conn.query("SET time_zone = '+00:00'", (err) => done(err, conn));
      },
    },
  };
}

export const db = knexFactory(configKnex());

export type Trx = Knex.Transaction;
