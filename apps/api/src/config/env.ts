import 'dotenv/config';
import { z } from 'zod';

const esquema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  /** Interfaz de escucha. En producción, por defecto solo 127.0.0.1 (detrás del proxy HTTPS). */
  HOST: z.string().optional(),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().default(3306),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default('sistema_ventas'),

  APP_ENC_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'APP_ENC_KEY debe ser 32 bytes en base64'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET debe tener al menos 32 caracteres'),

  APIPRO_BASE_URL: z.string().url(),
  APIPRO_KEY: z.string().default(''),
  APIPRO_SECRET: z.string().default(''),
  APIPRO_PRESUPUESTO_RPM: z.coerce.number().int().min(1).max(300).default(25),

  /** La API sirve la SPA compilada (apps/web/dist): un solo proceso detrás del proxy HTTPS. */
  SERVIR_WEB: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),

  // Respaldos (npm run respaldo -w @sv/api)
  MYSQL_BIN: z.string().default('C:/laragon/bin/mysql/mysql-8.4.3-winx64/bin'),
  RESPALDO_DIR: z.string().optional(),
  RESPALDO_DIAS: z.coerce.number().int().min(1).max(365).default(14),
});

/** En producción se rechazan configuraciones inseguras (se listan sin mostrar valores). */
function problemasProduccion(e: z.infer<typeof esquema>): string[] {
  if (e.NODE_ENV !== 'production') return [];
  const p: string[] = [];
  if (!e.WEB_ORIGIN.startsWith('https://')) p.push('WEB_ORIGIN: en producción debe ser https:// (la cookie de sesión es Secure)');
  if (e.DB_USER === 'root') p.push('DB_USER: usa un usuario de MySQL propio del sistema, no root');
  if (!e.DB_PASSWORD) p.push('DB_PASSWORD: el usuario de MySQL debe tener contraseña');
  if (['debug', 'trace'].includes(e.LOG_LEVEL)) p.push('LOG_LEVEL: debug/trace pueden registrar datos de clientes; usa info o warn');
  if (e.DB_NAME.endsWith('_test')) p.push('DB_NAME: no apuntes producción a una base de pruebas');
  return p;
}

const resultado = esquema.safeParse(process.env);
const enProduccion = resultado.success ? problemasProduccion(resultado.data) : [];
if (enProduccion.length) {
  console.error(`Configuración insegura para producción en apps/api/.env:\n${enProduccion.map((x) => `  - ${x}`).join('\n')}`);
  process.exit(1);
}

if (!resultado.success) {
  // Se listan solo los nombres de las variables con problemas, nunca sus valores.
  const problemas = resultado.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  console.error(`Configuración inválida en apps/api/.env:\n${problemas.join('\n')}`);
  process.exit(1);
}

export const env = resultado.data;
export type Env = typeof env;
