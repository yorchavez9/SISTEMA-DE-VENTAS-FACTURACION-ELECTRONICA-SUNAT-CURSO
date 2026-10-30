import { conductorSchema, filtroGuiasSchema, FORMATOS_PDF, guiaSchema, MOTIVOS_TRASLADO, transportistaSchema, vehiculoSchema, type FormatoPdf, type GuiaInput } from '@sv/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { db } from '../../database/db.js';
import { requierePermiso, requiereSucursal } from '../../middlewares/sesion.js';
import { idParam, validarBody, validarQuery } from '../../middlewares/validar.js';
import { auditar } from '../../shared/auditoria.js';
import { ErrorApp } from '../../shared/errors.js';
import * as guias from './guias.service.js';
import * as maestros from './maestros.service.js';

export const guiasRouter = Router();

const sucursalesDe = (req: Request) => req.sesion!.sucursales.map((s) => s.id);

async function verificarAcceso(req: Request, id: number): Promise<void> {
  const g = await db('guias').where('id', id).first('sucursal_id');
  if (g && !sucursalesDe(req).includes(Number(g.sucursal_id))) throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'La guía es de otra sucursal');
}

// ---------- Datos maestros ----------

const MAESTROS = [
  { ruta: 'transportistas', esquema: transportistaSchema, listar: maestros.listarTransportistas, guardar: maestros.guardarTransportista },
  { ruta: 'vehiculos', esquema: vehiculoSchema, listar: maestros.listarVehiculos, guardar: maestros.guardarVehiculo },
  { ruta: 'conductores', esquema: conductorSchema, listar: maestros.listarConductores, guardar: maestros.guardarConductor },
] as const;

for (const m of MAESTROS) {
  const guardar = m.guardar as (d: unknown, id?: number) => Promise<{ id: number }>;
  guiasRouter.get(`/${m.ruta}`, requierePermiso('guias.ver'), async (_req, res) => {
    res.json(await m.listar());
  });
  guiasRouter.post(`/${m.ruta}`, requierePermiso('guias.maestros'), validarBody(m.esquema), async (req, res) => {
    const r = await guardar(req.body);
    await auditar(req, { accion: `${m.ruta}.crear`, entidad: m.ruta, entidadId: r.id, despues: r });
    res.status(201).json(r);
  });
  guiasRouter.put(`/${m.ruta}/:id`, requierePermiso('guias.maestros'), validarBody(m.esquema), async (req, res) => {
    const r = await guardar(req.body, idParam(req));
    await auditar(req, { accion: `${m.ruta}.editar`, entidad: m.ruta, entidadId: r.id, despues: r });
    res.json(r);
  });
}

guiasRouter.get('/ubigeos/regiones', requierePermiso('guias.ver'), async (_req, res) => {
  res.json(await maestros.ubigeos('region'));
});
guiasRouter.get('/ubigeos/provincias', requierePermiso('guias.ver'), validarQuery(z.object({ region: z.string().regex(/^\d{2}$/) })), async (_req, res) => {
  res.json(await maestros.ubigeos('provincia', (res.locals.query as { region: string }).region));
});
guiasRouter.get('/ubigeos/distritos', requierePermiso('guias.ver'), validarQuery(z.object({ provincia: z.string().regex(/^\d{4}$/) })), async (_req, res) => {
  res.json(await maestros.ubigeos('distrito', (res.locals.query as { provincia: string }).provincia));
});

// ---------- Guías ----------

guiasRouter.get('/guias/motivos', requierePermiso('guias.ver'), (_req, res) => {
  res.json(Object.entries(MOTIVOS_TRASLADO).map(([codigo, nombre]) => ({ codigo, nombre })));
});

guiasRouter.get('/guias/series', requierePermiso('guias.crear'), async (req, res) => {
  res.json(await guias.seriesGuia(requiereSucursal(req).id));
});

const origenQuery = z.object({ comprobanteId: z.coerce.number().int().positive().optional(), trasladoId: z.coerce.number().int().positive().optional() });

guiasRouter.get('/guias/borrador', requierePermiso('guias.crear'), validarQuery(origenQuery), async (req, res) => {
  const q = res.locals.query as z.infer<typeof origenQuery>;
  const origen: GuiaInput['origen'] = q.comprobanteId ? { tipo: 'venta', comprobanteId: q.comprobanteId } : q.trasladoId ? { tipo: 'traslado', trasladoId: q.trasladoId } : { tipo: 'manual' };
  res.json(await guias.borrador(origen, requiereSucursal(req).id));
});

guiasRouter.get('/guias', requierePermiso('guias.ver'), validarQuery(filtroGuiasSchema), async (req, res) => {
  res.json(await guias.listar(sucursalesDe(req), res.locals.query));
});

guiasRouter.get('/guias/:id', requierePermiso('guias.ver'), async (req, res) => {
  const id = idParam(req);
  await verificarAcceso(req, id);
  res.json(await guias.obtener(id));
});

guiasRouter.post('/guias', requierePermiso('guias.crear'), validarBody(guiaSchema), async (req, res) => {
  const clave = req.get('Idempotency-Key');
  if (!clave || !/^[0-9a-f-]{36}$/i.test(clave)) throw new ErrorApp(400, 'IDEMPOTENCY_KEY_REQUERIDA', 'Falta la cabecera Idempotency-Key');
  const r = await guias.crear(req.body as GuiaInput, { sucursalId: requiereSucursal(req).id, usuarioId: req.sesion!.operador.id, idempotencyKey: clave });
  if (!r.repetida) await auditar(req, { accion: 'guia.crear', entidad: 'guia', entidadId: r.guia.id, despues: { serie: r.guia.serie, motivo: r.guia.codTraslado, origen: r.guia.origen } });
  res.status(r.repetida ? 200 : 201).json(r.guia);
});

guiasRouter.put('/guias/:id', requierePermiso('guias.crear'), validarBody(guiaSchema), async (req, res) => {
  const id = idParam(req);
  await verificarAcceso(req, id);
  const d = await guias.corregir(id, req.body as GuiaInput);
  await auditar(req, { accion: 'guia.corregir', entidad: 'guia', entidadId: id, despues: { estado: d.estado } });
  res.json(d);
});

guiasRouter.post('/guias/:id/reintentar', requierePermiso('guias.crear'), async (req, res) => {
  const id = idParam(req);
  await verificarAcceso(req, id);
  const d = await guias.reintentar(id);
  await auditar(req, { accion: 'guia.reintentar', entidad: 'guia', entidadId: id, despues: { estado: d.estado } });
  res.json(d);
});

guiasRouter.post('/guias/:id/consultar', requierePermiso('guias.ver'), async (req, res) => {
  const id = idParam(req);
  await verificarAcceso(req, id);
  res.json(await guias.consultar(id));
});

const formato = z.object({ formato: z.enum(FORMATOS_PDF).default('a4') });

for (const que of ['pdf', 'xml', 'cdr'] as const) {
  guiasRouter.get(`/guias/:id/${que}`, requierePermiso('guias.ver'), validarQuery(formato), async (req, res) => {
    const id = idParam(req);
    await verificarAcceso(req, id);
    const r = await guias.archivo(id, que, (res.locals.query as { formato: FormatoPdf }).formato);
    res.setHeader('Content-Type', r.contentType);
    res.setHeader('Content-Disposition', `${que === 'pdf' ? 'inline' : 'attachment'}; filename="${r.nombre}"`);
    res.send(r.datos);
  });
}
