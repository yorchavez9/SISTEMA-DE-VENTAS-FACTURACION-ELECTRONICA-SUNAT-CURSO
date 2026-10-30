import path from 'node:path';
import { fileURLToPath } from 'node:url';
import knexFactory from 'knex';
import { env } from '../config/env.js';
import { configKnex, db } from '../database/db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'database');

/** true si el servidor MySQL responde. Las pruebas de integración se omiten si no. */
export async function hayBaseDatos(): Promise<boolean> {
  const servidor = knexFactory(configKnex(null));
  try {
    await servidor.raw('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await servidor.destroy();
  }
}

/** Recrea la base de pruebas desde cero, con migraciones y semillas. */
export async function prepararBdPrueba(): Promise<void> {
  if (!env.DB_NAME.endsWith('_test')) throw new Error(`Por seguridad, las pruebas solo usan bases *_test (actual: ${env.DB_NAME})`);
  const servidor = knexFactory(configKnex(null));
  try {
    await servidor.raw('DROP DATABASE IF EXISTS ??', [env.DB_NAME]);
    await servidor.raw('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci', [env.DB_NAME]);
  } finally {
    await servidor.destroy();
  }
  await db.migrate.latest({ directory: path.join(dir, 'migrations'), loadExtensions: ['.ts'], tableName: 'knex_migraciones' });
  await db.seed.run({ directory: path.join(dir, 'seeds'), loadExtensions: ['.ts'] });
}
