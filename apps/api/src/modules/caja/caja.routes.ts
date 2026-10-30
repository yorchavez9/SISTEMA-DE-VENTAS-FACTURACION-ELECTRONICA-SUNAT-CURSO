import { abrirTurnoSchema, cajaSchema, cerrarTurnoSchema, movimientoCajaSchema, type MetodoPagoDto } from '@sv/shared';
import { Router, type Request } from 'express';
import { db } from '../../database/db.js';
import { requierePermiso, requiereSucursal } from '../../middlewares/sesion.js';
import { idParam, validarBody } from '../../middlewares/validar.js';
import { auditar } from '../../shared/auditoria.js';
import { ErrorApp, errores } from '../../shared/errors.js';
import * as caja from './caja.service.js';

export const cajaRouter = Router();

function claveIdempotencia(req: Request): string {
  const clave = req.get('Idempotency-Key');
  if (!clave || !/^[0-9a-f-]{36}$/i.test(clave)) throw new ErrorApp(400, 'IDEMPOTENCY_KEY_REQUERIDA', 'Falta la cabecera Idempotency-Key');
  return clave;
}

/** El turno debe ser de una caja de una sucursal a la que el usuario tiene acceso. */
async function verificarAcceso(req: Request, turnoId: number): Promise<void> {
  const t = await db('turnos_caja as t').join('cajas as c', 'c.id', 't.caja_id').where('t.id', turnoId).first('c.sucursal_id');
  if (!t) throw errores.noEncontrado('Turno de caja');
  if (!req.sesion!.sucursales.some((s) => s.id === Number(t.sucursal_id))) throw new ErrorApp(403, 'SUCURSAL_NO_PERMITIDA', 'No tienes acceso a esa caja');
}

cajaRouter.get('/metodos-pago', async (_req, res) => {
  const filas = await db('metodos_pago').where('activo', true).orderBy('orden').select('id', 'codigo', 'nombre', 'tipo', 'requiere_referencia');
  res.json(filas.map((m: Record<string, unknown>): MetodoPagoDto => ({ id: Number(m.id), codigo: String(m.codigo), nombre: String(m.nombre), tipo: m.tipo as MetodoPagoDto['tipo'], requiereReferencia: Boolean(m.requiere_referencia) })));
});

cajaRouter.get('/cajas', requierePermiso('caja.ver'), async (req, res) => {
  res.json(await caja.listarCajas(requiereSucursal(req).id));
});

cajaRouter.post('/cajas', requierePermiso('config.editar'), validarBody(cajaSchema), async (req, res) => {
  const sucursal = requiereSucursal(req);
  const { nombre, activo } = req.body as { nombre: string; activo: boolean };
  if (await db('cajas').where({ sucursal_id: sucursal.id, nombre }).first('id')) throw errores.validacion({ nombre: 'Ya existe una caja con ese nombre en la sucursal' });
  const [id] = await db('cajas').insert({ sucursal_id: sucursal.id, nombre, activo });
  await auditar(req, { accion: 'caja.crear', entidad: 'caja', entidadId: Number(id), despues: { nombre, sucursalId: sucursal.id } });
  res.status(201).json({ id: Number(id), nombre, sucursalId: sucursal.id, activo, turnoAbierto: null });
});

cajaRouter.put('/cajas/:id', requierePermiso('config.editar'), validarBody(cajaSchema), async (req, res) => {
  const id = idParam(req);
  const actual = await db('cajas').where('id', id).first();
  if (!actual || !req.sesion!.sucursales.some((s) => s.id === Number(actual.sucursal_id))) throw errores.noEncontrado('Caja');
  const { nombre, activo } = req.body as { nombre: string; activo: boolean };
  if (!activo && (await db('turnos_caja').where({ caja_id: id, estado: 'abierto' }).first('id'))) {
    throw new ErrorApp(409, 'ESTADO_NO_PERMITE', 'Cierra el turno abierto antes de desactivar la caja');
  }
  await db('cajas').where('id', id).update({ nombre, activo });
  await auditar(req, { accion: 'caja.editar', entidad: 'caja', entidadId: id, antes: actual, despues: { nombre, activo } });
  res.json({ id, nombre, activo });
});

cajaRouter.post('/turnos/abrir', requierePermiso('caja.abrir'), validarBody(abrirTurnoSchema), async (req, res) => {
  const { turnoId, repetido } = await caja.abrirTurno(req.body, {
    sucursalId: requiereSucursal(req).id,
    usuarioId: req.sesion!.operador.id,
    idempotencyKey: claveIdempotencia(req),
  });
  const r = await caja.resumen(turnoId);
  if (!repetido) await auditar(req, { accion: 'turno.abrir', entidad: 'turno', entidadId: turnoId, despues: r.efectivo });
  res.status(repetido ? 200 : 201).json(r);
});

cajaRouter.get('/turnos/:id', requierePermiso('caja.ver'), async (req, res) => {
  const id = idParam(req);
  await verificarAcceso(req, id);
  res.json(await caja.resumen(id));
});

cajaRouter.post('/turnos/:id/movimientos', requierePermiso('caja.movimientos'), validarBody(movimientoCajaSchema), async (req, res) => {
  const id = idParam(req);
  await verificarAcceso(req, id);
  const clave = claveIdempotencia(req);
  const previo = await db('movimientos_caja').where('idempotency_key', clave).first('id');
  if (!previo) {
    const d = req.body as { tipo: 'ingreso' | 'egreso'; metodoPagoId: number; moneda: 'PEN' | 'USD'; monto: string; concepto: string; referencia?: string };
    const movId = await db.transaction((trx) =>
      caja.registrarMovimiento(trx, {
        turnoId: id,
        tipo: d.tipo,
        metodoPagoId: d.metodoPagoId,
        moneda: d.moneda,
        monto: d.tipo === 'egreso' ? `-${d.monto}` : d.monto,
        concepto: d.concepto,
        referencia: d.referencia,
        origenTipo: 'manual',
        idempotencyKey: clave,
        usuarioId: req.sesion!.operador.id,
      }),
    );
    await auditar(req, { accion: `caja.${d.tipo}`, entidad: 'movimiento_caja', entidadId: movId, despues: d });
  }
  res.status(previo ? 200 : 201).json(await caja.resumen(id));
});

cajaRouter.post('/turnos/:id/cerrar', requierePermiso('caja.cerrar'), validarBody(cerrarTurnoSchema), async (req, res) => {
  const id = idParam(req);
  await verificarAcceso(req, id);
  const r = await caja.cerrarTurno(id, req.body, { usuarioId: req.sesion!.operador.id });
  await auditar(req, { accion: 'turno.cerrar', entidad: 'turno', entidadId: id, despues: r.efectivo });
  res.json(r);
});
