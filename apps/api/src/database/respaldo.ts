// Respaldos de MySQL (fase 10).
//   npm run respaldo -w @sv/api          → mysqldump comprimido + borra los de más de RESPALDO_DIAS días
//   npm run respaldo:probar -w @sv/api   → restaura el último respaldo en una base temporal,
//                                          compara el conteo de filas y la borra
// La contraseña de MySQL va por la variable MYSQL_PWD (nunca en la línea de comandos).
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import knexFactory from 'knex';
import { env } from '../config/env.js';
import { configKnex } from './db.js';

const DIR = env.RESPALDO_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../storage/respaldos');
const exe = (nombre: string) => path.join(env.MYSQL_BIN, process.platform === 'win32' ? `${nombre}.exe` : nombre);
const conexion = ['--host', env.DB_HOST, '--port', String(env.DB_PORT), '--user', env.DB_USER, '--default-character-set=utf8mb4'];
const entorno = { ...process.env, MYSQL_PWD: env.DB_PASSWORD };
/** Tablas que la prueba de restauración compara (las de dinero, stock y comprobantes). */
const TABLAS_CLAVE = ['ventas', 'venta_items', 'pagos', 'comprobantes', 'movimientos_caja', 'stock', 'movimientos_stock', 'cuentas_por_cobrar', 'cobros', 'guias', 'auditoria'];

function marca(): string {
  const f = new Date(Date.now() - 5 * 3_600_000).toISOString(); // hora de Lima
  return `${f.slice(0, 10).replaceAll('-', '')}-${f.slice(11, 16).replace(':', '')}`;
}

async function respaldar(): Promise<string> {
  await mkdir(DIR, { recursive: true });
  const destino = path.join(DIR, `${env.DB_NAME}-${marca()}.sql.gz`);
  // --single-transaction: copia coherente sin bloquear las ventas (InnoDB).
  const dump = spawn(exe('mysqldump'), [...conexion, '--single-transaction', '--routines', '--triggers', '--events', '--hex-blob', '--no-tablespaces', '--set-gtid-purged=OFF', env.DB_NAME], { env: entorno });
  let errores = '';
  dump.stderr.on('data', (d) => (errores += String(d)));
  const fin = new Promise<number>((ok, mal) => {
    dump.on('error', mal);
    dump.on('close', ok);
  });
  await pipeline(dump.stdout, createGzip({ level: 6 }), createWriteStream(destino));
  const codigo = await fin;
  if (codigo !== 0) {
    await rm(destino, { force: true });
    throw new Error(`mysqldump terminó con código ${codigo}: ${errores.trim().slice(0, 500)}`);
  }
  const { size } = await stat(destino);
  console.log(`Respaldo creado: ${destino} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  return destino;
}

async function limpiar(): Promise<void> {
  const limite = Date.now() - env.RESPALDO_DIAS * 86_400_000;
  for (const f of await readdir(DIR)) {
    if (!f.startsWith(`${env.DB_NAME}-`) || !f.endsWith('.sql.gz')) continue;
    const ruta = path.join(DIR, f);
    if ((await stat(ruta)).mtimeMs < limite) {
      await rm(ruta);
      console.log(`Respaldo antiguo eliminado: ${f}`);
    }
  }
}

async function ultimo(): Promise<string> {
  const archivos = (await readdir(DIR)).filter((f) => f.startsWith(`${env.DB_NAME}-`) && f.endsWith('.sql.gz')).sort();
  if (!archivos.length) throw new Error(`No hay respaldos en ${DIR}`);
  return path.join(DIR, archivos.at(-1)!);
}

async function conteos(base: string): Promise<Record<string, number>> {
  const k = knexFactory(configKnex(base));
  try {
    const r: Record<string, number> = {};
    for (const t of TABLAS_CLAVE) r[t] = Number(((await k(t).count({ n: '*' })) as [{ n: number }])[0].n);
    return r;
  } finally {
    await k.destroy();
  }
}

/** Restaura el último respaldo en <DB_NAME>_restauracion, compara y la elimina. */
async function probar(): Promise<void> {
  const archivo = await ultimo();
  const temporal = `${env.DB_NAME}_restauracion`;
  const servidor = knexFactory(configKnex(null));
  try {
    await servidor.raw('DROP DATABASE IF EXISTS ??', [temporal]);
    await servidor.raw('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci', [temporal]);
    console.log(`Restaurando ${path.basename(archivo)} en ${temporal}…`);
    const mysql = spawn(exe('mysql'), [...conexion, temporal], { env: entorno });
    let errores = '';
    mysql.stderr.on('data', (d) => (errores += String(d)));
    const fin = new Promise<number>((ok, mal) => {
      mysql.on('error', mal);
      mysql.on('close', ok);
    });
    await pipeline(createReadStream(archivo), createGunzip(), mysql.stdin);
    const codigo = await fin;
    if (codigo !== 0) throw new Error(`mysql terminó con código ${codigo}: ${errores.trim().slice(0, 500)}`);

    const [restaurada, actual] = await Promise.all([conteos(temporal), conteos(env.DB_NAME)]);
    const filas = TABLAS_CLAVE.map((t) => ({ tabla: t, respaldo: restaurada[t], actual: actual[t] }));
    console.table(filas);
    // La base viva puede haber crecido desde el respaldo, pero nunca tener menos filas en estas tablas.
    const raras = filas.filter((f) => f.respaldo! > f.actual!);
    const [{ migraciones }] = (await servidor.raw('SELECT COUNT(*) AS migraciones FROM ??.knex_migraciones', [temporal]))[0] as [{ migraciones: number }];
    console.log(`Migraciones en el respaldo: ${migraciones}`);
    if (raras.length) throw new Error(`El respaldo tiene más filas que la base actual en: ${raras.map((r) => r.tabla).join(', ')}`);
    console.log('Prueba de restauración correcta.');
  } finally {
    await servidor.raw('DROP DATABASE IF EXISTS ??', [temporal]).catch(() => undefined);
    await servidor.destroy();
  }
}

const comando = process.argv[2] ?? 'respaldar';
try {
  if (comando === 'respaldar') {
    await respaldar();
    await limpiar();
  } else if (comando === 'probar') await probar();
  else throw new Error(`Comando desconocido: ${comando} (usa respaldar o probar)`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
