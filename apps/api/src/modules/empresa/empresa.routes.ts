import {
  ajustesSchema, credencialesApiSchema, editarEmpresaSchema, probarProveedorDocumentoSchema, proveedoresDocumentoSchema,
  type Ajustes, type EstadoIntegracionDto, type ProveedorDocumento, type ProveedoresDocumentoInput,
} from '@sv/shared';
import { contadores } from '../facturacion/comprobantes.service.js';
import { leerPausa, pausaActiva, reanudar } from '../facturacion/pausa.js';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { db } from '../../database/db.js';
import { requierePermiso } from '../../middlewares/sesion.js';
import { validarBody } from '../../middlewares/validar.js';
import { auditar } from '../../shared/auditoria.js';
import { leerAjuste } from '../configuracion/configuracion.service.js';
import { atascados } from '../facturacion/alertas.js';
import * as documentos from '../configuracion/proveedoresDocumento.js';
import * as empresa from './empresa.service.js';

export const empresaRouter = Router();

// Probar la conexión consume ~4 llamadas del presupuesto de API-PRO (30/min); se limita por ruta.
const limitePorMinuto = (limit: number) =>
  rateLimit({
    windowMs: 60_000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: 'Espera un minuto antes de volver a intentarlo.', codigo: 'DEMASIADAS_SOLICITUDES' });
    },
  });
const limiteProbar = limitePorMinuto(4);
const limiteCredenciales = limitePorMinuto(5);

empresaRouter.get('/empresa', requierePermiso('config.ver'), async (_req, res) => {
  res.json(await empresa.obtener());
});

empresaRouter.put('/empresa', requierePermiso('config.editar'), validarBody(editarEmpresaSchema), async (req, res) => {
  res.json(await empresa.editar(req, req.body));
});

empresaRouter.put('/empresa/credenciales-api', requierePermiso('config.editar'), limiteCredenciales, validarBody(credencialesApiSchema), async (req, res) => {
  res.json(await empresa.guardarCredenciales(req, req.body));
});

empresaRouter.post('/empresa/probar-conexion', requierePermiso('config.ver'), limiteProbar, async (req, res) => {
  res.json(await empresa.probarConexion(req));
});

/** Estado resumido para el chip del encabezado y el panel de comprobantes. */
empresaRouter.get('/estado-integracion', async (req, res) => {
  const sucursales = req.sesion!.sucursales.map((s) => s.id);
  const [e, pausa, cont, atasco] = await Promise.all([empresa.obtener(), pausaActiva(), contadores(sucursales), atascados(sucursales)]);
  const cuerpo: EstadoIntegracionDto = {
    modoEmision: e.modoEmision,
    entorno: e.api.entorno,
    credenciales: e.api.origen,
    verificadaEn: e.api.verificadaEn,
    colaPausada: Boolean(pausa),
    pausa,
    contadores: cont,
    atascados: atasco,
  };
  res.json(cuerpo);
});

/** Reanuda la emisión pausada (credenciales, licencia o cupo ya resueltos). */
empresaRouter.post('/estado-integracion/reanudar', requierePermiso('config.editar'), async (req, res) => {
  const antes = await leerPausa();
  await reanudar();
  // Los trabajos que esperaban la pausa se adelantan.
  await db('outbox_trabajos').where('estado', 'pendiente').update({ ejecutar_en: db.raw('CURRENT_TIMESTAMP(3)') });
  await auditar(req, { accion: 'integracion.reanudar', entidad: 'integracion', antes });
  res.status(204).end();
});

// ---------- Ajustes tipados ----------

const CLAVES = Object.keys(ajustesSchema.shape) as Array<keyof Ajustes>;
const POR_DEFECTO: Ajustes = {
  'sesion.inactividad_min': 30,
  'ticket.mensaje_pie': 'Gracias por su compra',
  'credito.limite_por_cliente': false,
  'credito.bloquear_vencidos': true,
  'alertas.comprobante_atascado_min': 30,
};

empresaRouter.get('/configuracion', requierePermiso('config.ver'), async (_req, res) => {
  const valores = await Promise.all(CLAVES.map(async (c) => [c, await leerAjuste(c, POR_DEFECTO[c])] as const));
  res.json(Object.fromEntries(valores));
});

empresaRouter.put('/configuracion', requierePermiso('config.editar'), validarBody(ajustesSchema.partial()), async (req, res) => {
  const cambios = req.body as Partial<Ajustes>;
  const antes: Record<string, unknown> = {};
  for (const [clave, valor] of Object.entries(cambios)) {
    antes[clave] = await leerAjuste(clave, null);
    await db('configuracion').insert({ clave, valor: JSON.stringify(valor) }).onConflict('clave').merge(['valor']);
  }
  await auditar(req, { accion: 'configuracion.editar', entidad: 'configuracion', antes, despues: cambios });
  res.status(204).end();
});

// ---------- Consulta de DNI y RUC (json.pe, MIGO) ----------

empresaRouter.get('/configuracion/consulta-documentos', requierePermiso('config.ver'), async (_req, res) => {
  res.json(await documentos.listar());
});

empresaRouter.put('/configuracion/consulta-documentos', requierePermiso('config.editar'), limiteCredenciales, validarBody(proveedoresDocumentoSchema), async (req, res) => {
  const d = req.body as ProveedoresDocumentoInput;
  const antes = await documentos.listar();
  await documentos.guardar(d);
  // En la auditoría no va el token, solo si cambió.
  const despues = { principal: d.principal, proveedores: d.proveedores.map((p) => ({ codigo: p.codigo, activo: p.activo, tokenNuevo: Boolean(p.token), tokenQuitado: Boolean(p.quitarToken) })) };
  await auditar(req, { accion: 'configuracion.consulta_documentos', entidad: 'configuracion', antes: antes.map(({ token, ...p }) => ({ ...p, conToken: Boolean(token) })), despues });
  res.json(await documentos.listar());
});

empresaRouter.post('/configuracion/consulta-documentos/probar', requierePermiso('config.editar'), limiteProbar, validarBody(probarProveedorDocumentoSchema), async (req, res) => {
  const { codigo, tipoDoc, numDoc } = req.body as { codigo: ProveedorDocumento; tipoDoc: '1' | '6'; numDoc: string };
  res.json(await documentos.probar(codigo, tipoDoc, numDoc));
});
