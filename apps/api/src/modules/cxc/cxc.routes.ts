import { anularCobroSchema, cobroSchema, MONEDAS } from '@sv/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { requierePermiso, requiereSucursal } from '../../middlewares/sesion.js';
import { idParam, validarBody, validarQuery } from '../../middlewares/validar.js';
import { auditar } from '../../shared/auditoria.js';
import { ErrorApp } from '../../shared/errors.js';
import * as cxc from './cxc.service.js';

export const cxcRouter = Router();

function claveIdempotencia(req: Request): string {
  const clave = req.get('Idempotency-Key');
  if (!clave || !/^[0-9a-f-]{36}$/i.test(clave)) throw new ErrorApp(400, 'IDEMPOTENCY_KEY_REQUERIDA', 'Falta la cabecera Idempotency-Key');
  return clave;
}

const sucursalesDe = (req: Request) => req.sesion!.sucursales.map((s) => s.id);

cxcRouter.get(
  '/cxc',
  requierePermiso('cxc.ver'),
  validarQuery(
    z.object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
      clienteId: z.coerce.number().int().positive().optional(),
      estado: z.enum(['pendiente', 'parcial', 'pagada', 'anulada']).optional(),
      moneda: z.enum(MONEDAS).optional(),
      vencidas: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
      q: z.string().trim().max(60).optional(),
    }),
  ),
  async (req, res) => {
    res.json(await cxc.listarCuentas(sucursalesDe(req), res.locals.query));
  },
);

cxcRouter.get('/cxc/antiguedad', requierePermiso('cxc.ver'), async (req, res) => {
  res.json(await cxc.antiguedad(sucursalesDe(req)));
});

cxcRouter.get('/clientes/:id/estado-cuenta', requierePermiso('cxc.ver'), async (req, res) => {
  res.json(await cxc.estadoCuenta(idParam(req)));
});

cxcRouter.post('/cobros', requierePermiso('cxc.cobrar'), validarBody(cobroSchema), async (req, res) => {
  const { cobro, repetido } = await cxc.registrarCobro(req.body, {
    sucursalId: requiereSucursal(req).id,
    operadorId: req.sesion!.operador.id,
    idempotencyKey: claveIdempotencia(req),
  });
  if (repetido) {
    res.setHeader('Idempotent-Replay', 'true');
    res.json(cobro);
    return;
  }
  await auditar(req, { accion: 'cobro.registrar', entidad: 'cobro', entidadId: cobro.id, despues: cobro });
  res.status(201).json(cobro);
});

cxcRouter.get('/cobros/:id', requierePermiso('cxc.ver'), async (req, res) => {
  res.json(await cxc.obtenerCobro(idParam(req)));
});

cxcRouter.post('/cobros/:id/anular', requierePermiso('cxc.cobrar'), validarBody(anularCobroSchema), async (req, res) => {
  const id = idParam(req);
  const s = req.sesion!;
  const cobro = await cxc.anularCobro(id, req.body, { sucursalId: requiereSucursal(req).id, operadorId: s.operador.id, permisos: s.permisos });
  await auditar(req, { accion: 'cobro.anular', entidad: 'cobro', entidadId: id, despues: { motivo: cobro.motivoAnulacion } });
  res.json(cobro);
});
