import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { logger } from './config/logger.js';
import { db } from './database/db.js';
import { manejarErrores, noEncontrado } from './middlewares/errorHandler.js';
import { aplicarSucursal, cargarSesion, requiereSesion, verificarCsrf } from './middlewares/sesion.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { usuariosRouter } from './modules/usuarios/usuarios.routes.js';
import { empresaRouter } from './modules/empresa/empresa.routes.js';
import { seriesRouter } from './modules/series/series.routes.js';
import { sucursalesRouter } from './modules/sucursales/sucursales.routes.js';
import { tiposCambioRouter } from './modules/tipos-cambio/tipos-cambio.routes.js';
import { catalogoRouter } from './modules/catalogo/catalogo.routes.js';
import { inventarioRouter } from './modules/inventario/inventario.routes.js';
import { tercerosRouter } from './modules/terceros/terceros.routes.js';
import { comprasRouter } from './modules/compras/compras.routes.js';
import { cajaRouter } from './modules/caja/caja.routes.js';
import { ventasRouter } from './modules/ventas/ventas.routes.js';
import { cxcRouter } from './modules/cxc/cxc.routes.js';
import { comprobantesRouter } from './modules/facturacion/comprobantes.routes.js';
import { resumenesRouter } from './modules/facturacion/resumenes.routes.js';
import { notasRouter } from './modules/facturacion/notas.routes.js';
import { anulacionesRouter } from './modules/facturacion/anulaciones.routes.js';
import { guiasRouter } from './modules/guias/guias.routes.js';
import { reportesRouter } from './modules/reportes/reportes.routes.js';
import { env } from './config/env.js';

const DIR_WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

/**
 * Producción con SERVIR_WEB=true: la API entrega la SPA compilada. Los archivos con hash se cachean
 * un año; index.html nunca (así cada despliegue se ve al recargar). Cualquier ruta que no sea /api
 * devuelve index.html para que funcione el enrutado del navegador.
 */
function servirWeb(app: express.Express): void {
  if (!existsSync(path.join(DIR_WEB, 'index.html'))) {
    logger.error(`SERVIR_WEB=true pero no existe ${DIR_WEB}/index.html: ejecuta npm run build`);
    return;
  }
  app.use('/assets', express.static(path.join(DIR_WEB, 'assets'), { immutable: true, maxAge: '1y', index: false }), (_req, res) => {
    res.status(404).end(); // un archivo de una versión anterior: no se devuelve index.html en su lugar
  });
  app.use(express.static(DIR_WEB, { index: false, maxAge: 0 }));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(DIR_WEB, 'index.html'));
  });
}

export function crearApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/api/health' },
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // La SPA y la API comparten origen (proxy de Vite en desarrollo, reverse proxy en
  // producción), por eso no se habilita CORS.

  app.get('/api/health', async (_req, res) => {
    let baseDatos = 'ok';
    try {
      await db.raw('SELECT 1');
    } catch {
      baseDatos = 'sin_conexion';
    }
    res.status(baseDatos === 'ok' ? 200 : 503).json({ estado: baseDatos === 'ok' ? 'ok' : 'degradado', baseDatos });
  });

  app.use('/api', cargarSesion);
  // El login (contraseña o PIN) y la instalación quedan fuera del CSRF: aún no hay token y la cookie es SameSite=Strict.
  app.use('/api', (req, res, next) => (['/auth/login', '/auth/ingreso/pin', '/auth/instalacion'].includes(req.path) ? next() : verificarCsrf(req, res, next)));
  app.use('/api', aplicarSucursal);

  app.use('/api/auth', authRouter);
  app.use('/api', requiereSesion, usuariosRouter, empresaRouter, sucursalesRouter, seriesRouter, tiposCambioRouter, catalogoRouter, inventarioRouter, tercerosRouter, comprasRouter, cajaRouter, ventasRouter, cxcRouter, comprobantesRouter, resumenesRouter, notasRouter, anulacionesRouter, guiasRouter, reportesRouter);

  app.use('/api', noEncontrado);
  if (env.SERVIR_WEB) servirWeb(app);
  app.use(manejarErrores);
  return app;
}
