import { crearApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { db } from './database/db.js';
import { anunciarSiPendiente } from './modules/auth/instalacion.js';

const host = env.HOST ?? (env.NODE_ENV === 'production' ? '127.0.0.1' : undefined);
const servidor = crearApp().listen(env.PORT, host as string, () => {
  logger.info(`API escuchando en http://${host ?? 'localhost'}:${env.PORT}`);
  void anunciarSiPendiente().catch((err) => logger.error({ err }, 'No se pudo revisar la instalación'));
});

async function apagar(senal: string): Promise<void> {
  logger.info(`${senal} recibido, cerrando...`);
  servidor.close();
  await db.destroy();
  process.exit(0);
}

process.on('SIGINT', () => void apagar('SIGINT'));
process.on('SIGTERM', () => void apagar('SIGTERM'));
