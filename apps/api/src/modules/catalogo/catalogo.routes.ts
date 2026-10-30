import { categoriaSchema, filtroProductosSchema, productoSchema, type CategoriaDto, type UnidadDto } from '@sv/shared';
import express, { Router } from 'express';
import { z } from 'zod';
import { db } from '../../database/db.js';
import { requierePermiso, requiereSucursal } from '../../middlewares/sesion.js';
import { idParam, validarBody, validarQuery } from '../../middlewares/validar.js';
import { auditar } from '../../shared/auditoria.js';
import { errores } from '../../shared/errors.js';
import * as productos from './productos.service.js';
import * as imagenes from './imagenes.js';

export const catalogoRouter = Router();

// ---------- Unidades (catálogo 03) ----------

catalogoRouter.get('/unidades', async (_req, res) => {
  const filas = await db('unidades').where('activo', true).orderBy('nombre').select('id', 'codigo_sunat', 'nombre', 'fraccionable');
  res.json(
    filas.map((u: { id: number | string; codigo_sunat: string; nombre: string; fraccionable: number }): UnidadDto => ({
      id: Number(u.id),
      codigoSunat: u.codigo_sunat,
      nombre: u.nombre,
      fraccionable: Boolean(u.fraccionable),
    })),
  );
});

// ---------- Categorías ----------

catalogoRouter.get('/categorias', requierePermiso('productos.ver'), async (_req, res) => {
  const filas = await db('categorias as c')
    .leftJoin('productos as p', function () {
      this.on('p.categoria_id', 'c.id').andOnVal('p.activo', true);
    })
    .groupBy('c.id')
    .orderBy('c.nombre')
    .select('c.id', 'c.nombre', 'c.activo', db.raw('COUNT(p.id) as productos'));
  res.json(
    filas.map((c: { id: number | string; nombre: string; activo: number; productos: number | string }): CategoriaDto => ({
      id: Number(c.id),
      nombre: c.nombre,
      activo: Boolean(c.activo),
      productos: Number(c.productos),
    })),
  );
});

catalogoRouter.post('/categorias', requierePermiso('productos.editar'), validarBody(categoriaSchema), async (req, res) => {
  const { nombre, activo } = req.body as { nombre: string; activo: boolean };
  if (await db('categorias').where('nombre', nombre).first('id')) throw errores.validacion({ nombre: 'Ya existe esa categoría' });
  const [id] = await db('categorias').insert({ nombre, activo });
  await auditar(req, { accion: 'categoria.crear', entidad: 'categoria', entidadId: Number(id), despues: { nombre } });
  res.status(201).json({ id: Number(id), nombre, activo, productos: 0 });
});

catalogoRouter.put('/categorias/:id', requierePermiso('productos.editar'), validarBody(categoriaSchema), async (req, res) => {
  const id = idParam(req);
  const { nombre, activo } = req.body as { nombre: string; activo: boolean };
  const antes = await db('categorias').where('id', id).first();
  if (!antes) throw errores.noEncontrado('Categoría');
  if (await db('categorias').where('nombre', nombre).whereNot('id', id).first('id')) throw errores.validacion({ nombre: 'Ya existe esa categoría' });
  await db('categorias').where('id', id).update({ nombre, activo });
  await auditar(req, { accion: 'categoria.editar', entidad: 'categoria', entidadId: id, antes, despues: { nombre, activo } });
  res.json({ id, nombre, activo });
});

// ---------- Productos ----------

catalogoRouter.get('/productos', requierePermiso('productos.ver'), validarQuery(filtroProductosSchema), async (req, res) => {
  const f = res.locals.query as z.infer<typeof filtroProductosSchema>;
  const sucursalId = f.sucursalId && req.sesion!.sucursales.some((s) => s.id === f.sucursalId) ? f.sucursalId : (req.sesion!.sucursalActiva?.id ?? null);
  res.json(await productos.listar(sucursalId, f));
});

catalogoRouter.get('/productos/buscar-pos', requierePermiso('ventas.crear'), validarQuery(z.object({ q: z.string().trim().max(100).default('') })), async (req, res) => {
  const sucursal = requiereSucursal(req);
  res.json(await productos.buscarPos(sucursal.id, (res.locals.query as { q: string }).q));
});

catalogoRouter.get('/productos/:id', requierePermiso('productos.ver'), async (req, res) => {
  res.json(await productos.obtener(idParam(req), req.sesion!.sucursalActiva?.id ?? null));
});

catalogoRouter.post('/productos', requierePermiso('productos.editar'), validarBody(productoSchema), async (req, res) => {
  const p = await productos.crear(req.body, { sucursalId: req.sesion!.sucursalActiva?.id ?? null, usuarioId: req.sesion!.operador.id });
  await auditar(req, { accion: 'producto.crear', entidad: 'producto', entidadId: p.id, despues: p });
  res.status(201).json(p);
});

catalogoRouter.put('/productos/:id', requierePermiso('productos.editar'), validarBody(productoSchema), async (req, res) => {
  const id = idParam(req);
  const { antes, despues } = await productos.editar(id, req.body, req.sesion!.sucursalActiva?.id ?? null);
  await auditar(req, { accion: 'producto.editar', entidad: 'producto', entidadId: id, antes, despues });
  res.json(despues);
});

// ---------- Imagen del producto (opcional) ----------

/** El cuerpo es el archivo tal cual (JPG, PNG o WebP); el tipo real se verifica por su contenido. */
catalogoRouter.put(
  '/productos/:id/imagen',
  requierePermiso('productos.editar'),
  express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: imagenes.MAX_BYTES }),
  async (req, res) => {
    const id = idParam(req);
    if (!Buffer.isBuffer(req.body)) throw errores.validacion({ imagen: 'Envía una imagen JPG, PNG o WebP' });
    const imagenUrl = await imagenes.guardar(id, req.body);
    await auditar(req, { accion: 'producto.imagen', entidad: 'producto', entidadId: id, despues: { imagenUrl } });
    res.json({ imagenUrl });
  },
);

catalogoRouter.delete('/productos/:id/imagen', requierePermiso('productos.editar'), async (req, res) => {
  const id = idParam(req);
  await imagenes.eliminar(id);
  await auditar(req, { accion: 'producto.imagen_quitar', entidad: 'producto', entidadId: id });
  res.status(204).end();
});

/** Cualquier usuario con sesión (el cajero la ve en el POS). La URL lleva la versión: caché larga. */
catalogoRouter.get('/productos/:id/imagen', async (req, res) => {
  const { datos, mime } = await imagenes.leer(idParam(req));
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.send(datos);
});
