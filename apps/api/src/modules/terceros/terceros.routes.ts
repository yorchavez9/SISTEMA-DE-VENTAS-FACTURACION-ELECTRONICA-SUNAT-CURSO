import { buscarDocumentoSchema, clienteSchema, proveedorSchema, type TipoDocTercero } from '@sv/shared';
import { Router } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { requierePermiso } from '../../middlewares/sesion.js';
import { idParam, validarBody, validarQuery } from '../../middlewares/validar.js';
import { auditar } from '../../shared/auditoria.js';
import { clientes, proveedores } from './terceros.service.js';

export const tercerosRouter = Router();

const filtro = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(100).optional(),
  activo: z.enum(['true', 'false', 'todos']).default('true'),
});

// Cada búsqueda externa gasta presupuesto de API-PRO (30 solicitudes/min para toda la empresa).
const limiteBusqueda = rateLimit({
  windowMs: 60_000,
  limit: 15,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `buscar:${req.sesion?.operador.id ?? ipKeyGenerator(req.ip ?? '')}`,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Demasiadas búsquedas. Espera un momento.', codigo: 'DEMASIADAS_SOLICITUDES' });
  },
});

const registrar = (
  base: string,
  servicio: typeof clientes | typeof proveedores,
  esquema: typeof clienteSchema | typeof proveedorSchema,
  permisos: { ver: string; editar: string; buscar: string[] },
  entidad: string,
) => {
  tercerosRouter.get(base, requierePermiso(permisos.ver), validarQuery(filtro), async (_req, res) => {
    res.json(await servicio.listar(res.locals.query));
  });

  /** Ruta "buscar" antes de ":id" para que no se interprete como id. */
  tercerosRouter.get(`${base}/buscar`, (req, res, next) => {
    // Basta con uno de los permisos (p. ej. el POS busca clientes con ventas.crear).
    if (!permisos.buscar.some((p) => req.sesion?.permisos.has(p))) return requierePermiso(permisos.buscar[0]!)(req, res, next);
    next();
  }, limiteBusqueda, validarQuery(buscarDocumentoSchema), async (_req, res) => {
    const { tipoDoc, numDoc } = res.locals.query as { tipoDoc: TipoDocTercero; numDoc: string };
    res.json(await servicio.buscar(tipoDoc, numDoc));
  });

  tercerosRouter.get(`${base}/:id`, requierePermiso(permisos.ver), async (req, res) => {
    res.json(await servicio.obtener(idParam(req)));
  });

  tercerosRouter.post(base, requierePermiso(permisos.editar), validarBody(esquema), async (req, res) => {
    const creado = await servicio.crear(req.body);
    await auditar(req, { accion: `${entidad}.crear`, entidad, entidadId: (creado as { id: number }).id, despues: creado });
    res.status(201).json(creado);
  });

  tercerosRouter.put(`${base}/:id`, requierePermiso(permisos.editar), validarBody(esquema), async (req, res) => {
    const id = idParam(req);
    const { antes, despues } = await servicio.editar(id, req.body);
    await auditar(req, { accion: `${entidad}.editar`, entidad, entidadId: id, antes, despues });
    res.json(despues);
  });
};

registrar('/clientes', clientes, clienteSchema, { ver: 'clientes.ver', editar: 'clientes.editar', buscar: ['clientes.ver', 'ventas.crear'] }, 'cliente');
registrar('/proveedores', proveedores, proveedorSchema, { ver: 'proveedores.ver', editar: 'proveedores.editar', buscar: ['proveedores.ver', 'compras.crear'] }, 'proveedor');
