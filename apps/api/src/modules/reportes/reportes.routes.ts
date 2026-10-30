import { filtroAuditoriaSchema, filtroIntentosSchema, filtroReporteSchema, REPORTES, type FiltroReporte, type ReporteDto, type TipoReporte } from '@sv/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { requierePermiso } from '../../middlewares/sesion.js';
import { validarQuery } from '../../middlewares/validar.js';
import { ErrorApp } from '../../shared/errors.js';
import { fechaLima } from '../../shared/fechas.js';
import * as reportes from './reportes.service.js';

export const reportesRouter = Router();

/** Sucursales consultadas: una de las permitidas, o todas las de la sesión. */
function sucursales(req: Request, sucursalId?: number): number[] {
  const permitidas = req.sesion!.sucursales.map((s) => s.id);
  if (!sucursalId) return permitidas;
  if (!permitidas.includes(sucursalId)) throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'No tienes acceso a esa sucursal');
  return [sucursalId];
}

const alcance = z.object({ sucursalId: z.coerce.number().int().positive().optional() });

reportesRouter.get('/dashboard', requierePermiso('dashboard.ver'), validarQuery(alcance), async (req, res) => {
  const { sucursalId } = res.locals.query as z.infer<typeof alcance>;
  // Por defecto, la sucursal activa (es lo que ve el cajero en el inicio).
  res.json(await reportes.dashboard(sucursales(req, sucursalId ?? req.sesion!.sucursalActiva?.id)));
});

const GENERADORES: Record<TipoReporte, (ids: number[], f: FiltroReporte & { desde: string; hasta: string }) => Promise<ReporteDto>> = {
  ventas: reportes.reporteVentas,
  comprobantes: reportes.reporteComprobantes,
  inventario: (ids) => reportes.reporteInventario(ids),
  compras: reportes.reporteCompras,
  caja: reportes.reporteCaja,
  cxc: (ids) => reportes.reporteCxc(ids),
};

for (const tipo of Object.keys(REPORTES) as TipoReporte[]) {
  reportesRouter.get(`/reportes/${tipo}`, requierePermiso('reportes.ver'), validarQuery(filtroReporteSchema), async (req, res) => {
    const f = res.locals.query as FiltroReporte;
    const hoy = fechaLima();
    const r = await GENERADORES[tipo](sucursales(req, f.sucursalId), { ...f, desde: f.desde ?? hoy, hasta: f.hasta ?? f.desde ?? hoy });
    if (f.formato === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="reporte-${tipo}${tipo === 'ventas' ? `-${f.agrupar}` : ''}-${f.desde ?? hoy}.csv"`);
      res.send(reportes.aCsv(r));
      return;
    }
    res.json(r);
  });
}

reportesRouter.get('/auditoria', requierePermiso('auditoria.ver'), validarQuery(filtroAuditoriaSchema), async (_req, res) => {
  res.json(await reportes.auditoria(res.locals.query));
});

reportesRouter.get('/integracion/intentos', requierePermiso('auditoria.ver'), validarQuery(filtroIntentosSchema), async (_req, res) => {
  res.json(await reportes.intentos(res.locals.query));
});
