// Uso: tsx src/database/cli.ts migrate | rollback | seed
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import knexFactory from 'knex';
import { env } from '../config/env.js';
import { configKnex } from './db.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const migraciones = { directory: path.join(dir, 'migrations'), loadExtensions: ['.ts'], tableName: 'knex_migraciones' };
const semillas = { directory: path.join(dir, 'seeds'), loadExtensions: ['.ts'] };

async function crearBaseSiNoExiste(): Promise<void> {
  const servidor = knexFactory(configKnex(null));
  try {
    await servidor.raw(
      'CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci',
      [env.DB_NAME],
    );
  } finally {
    await servidor.destroy();
  }
}

async function main(): Promise<void> {
  const comando = process.argv[2];
  if (comando === 'migrate') await crearBaseSiNoExiste();

  const db = knexFactory(configKnex());
  try {
    if (comando === 'migrate') {
      const [lote, archivos] = await db.migrate.latest(migraciones);
      console.log(archivos.length ? `Lote ${lote}: ${archivos.join(', ')}` : 'Base de datos al día.');
    } else if (comando === 'rollback') {
      const [lote, archivos] = await db.migrate.rollback(migraciones);
      console.log(archivos.length ? `Revertido lote ${lote}: ${archivos.join(', ')}` : 'Nada que revertir.');
    } else if (comando === 'seed') {
      const [archivos] = await db.seed.run(semillas);
      console.log(`Semillas ejecutadas: ${archivos.map((a) => path.basename(a)).join(', ')}`);
    } else {
      console.error('Comando desconocido. Usa: migrate | rollback | seed');
      process.exitCode = 1;
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
