// Proceso worker: toma trabajos del outbox y los ejecuta (ADR-10).
import { logger } from './config/logger.js';
import { db } from './database/db.js';
import { manejadores, procesarLote } from './jobs/outbox.js';
import { registrarManejadoresEmision } from './modules/facturacion/emision.service.js';
import { atascados } from './modules/facturacion/alertas.js';
import { envioProgramado } from './modules/facturacion/resumenes.service.js';

registrarManejadoresEmision();

const INTERVALO_MS = 2000;
let detener = false;
let ultimoProgramado = 0;
const PROGRAMADO_MS = 60_000;
let ultimaAlerta = 0;
const ALERTA_MS = 15 * 60_000;

/** Deja en el log (nivel warn) los documentos atascados, para el monitoreo de operación. */
async function revisarAtascados(): Promise<void> {
  const a = await atascados(null);
  if (a.total === 0) return;
  logger.warn(
    { atascados: a.items.length, boletasSinResumen: a.boletasSinResumen, trabajosFallidos: a.trabajosFallidos, ejemplos: a.items.slice(0, 5).map((i) => `${i.tipo} ${i.numero} (${i.estado})`) },
    `Hay ${a.total} documento(s) o trabajo(s) que requieren revisión`,
  );
}

async function bucle(): Promise<void> {
  logger.info(`Worker iniciado (${Object.keys(manejadores).length} tipos de trabajo registrados)`);
  while (!detener) {
    try {
      // Tareas programadas (resumen diario automático), como mucho una vez por minuto.
      if (Date.now() - ultimoProgramado > PROGRAMADO_MS) {
        ultimoProgramado = Date.now();
        await envioProgramado().catch((err) => logger.error({ err }, 'Fallo en el envío programado de resúmenes'));
      }
      if (Date.now() - ultimaAlerta > ALERTA_MS) {
        ultimaAlerta = Date.now();
        await revisarAtascados().catch((err) => logger.error({ err }, 'Fallo al revisar documentos atascados'));
      }
      const procesados = await procesarLote();
      if (procesados === 0) await new Promise((r) => setTimeout(r, INTERVALO_MS));
    } catch (err) {
      logger.error({ err }, 'Fallo en el ciclo del worker');
      await new Promise((r) => setTimeout(r, INTERVALO_MS * 5));
    }
  }
  await db.destroy();
  logger.info('Worker detenido');
}

for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(senal, () => {
    detener = true;
  });
}

void bucle();
