import type { CrearSucursalInput, SucursalDto } from '@sv/shared';
import type { Request } from 'express';
import { db } from '../../database/db.js';
import { llamarJson } from '../../integrations/apiPro/llamada.js';
import { obtenerCliente } from '../../integrations/apiPro/proveedor.js';
import { auditar } from '../../shared/auditoria.js';
import { ErrorApp, errores } from '../../shared/errors.js';
import { sincronizar as sincronizarSeries } from '../series/series.service.js';

interface FilaSucursal {
  id: number | string;
  nombre: string;
  cod_local: string;
  api_sucursal_id: number | string | null;
  direccion: string | null;
  ubigeo: string | null;
  telefono: string | null;
  modo_boletas: 'individual' | 'resumen';
  hora_resumen: string;
  activo: number | boolean;
}

interface SucursalApi {
  id: number;
  nombre: string;
  cod_local: string;
  direccion?: string | null;
  ubigeo?: string | null;
  telefono?: string | null;
  activo: boolean;
}

function aDto(f: FilaSucursal): SucursalDto {
  return {
    id: Number(f.id),
    nombre: f.nombre,
    codLocal: f.cod_local,
    apiSucursalId: f.api_sucursal_id == null ? null : Number(f.api_sucursal_id),
    direccion: f.direccion,
    ubigeo: f.ubigeo,
    telefono: f.telefono,
    modoBoletas: f.modo_boletas,
    horaResumen: String(f.hora_resumen).slice(0, 5),
    activo: Boolean(f.activo),
  };
}

export async function listar(ids?: number[]): Promise<SucursalDto[]> {
  const q = db('sucursales').orderBy('nombre');
  if (ids) q.whereIn('id', ids);
  return ((await q) as FilaSucursal[]).map(aDto);
}

export async function obtener(id: number): Promise<SucursalDto> {
  const f = (await db('sucursales').where('id', id).first()) as FilaSucursal | undefined;
  if (!f) throw errores.noEncontrado('Sucursal');
  return aDto(f);
}

/** Sucursales de API-PRO con la sucursal local a la que están vinculadas (solo lectura). */
export async function listarApi(): Promise<Array<{ id: number; nombre: string; codLocal: string; activo: boolean; vinculadaA: number | null }>> {
  const [api, locales] = await Promise.all([sucursalesApi(), db('sucursales').whereNotNull('api_sucursal_id').select('id', 'api_sucursal_id')]);
  const porApi = new Map(locales.map((l: { id: number; api_sucursal_id: number }) => [Number(l.api_sucursal_id), Number(l.id)]));
  return api.map((s) => ({ id: s.id, nombre: s.nombre, codLocal: s.cod_local, activo: s.activo, vinculadaA: porApi.get(s.id) ?? null }));
}

async function sucursalesApi(): Promise<SucursalApi[]> {
  const { datos } = await llamarJson<SucursalApi[]>(await obtenerCliente(), 'GET', '/sucursales', { operacion: 'sucursales.leer' });
  return datos;
}

export async function crear(req: Request, datos: CrearSucursalInput): Promise<SucursalDto> {
  if (await db('sucursales').where('cod_local', datos.codLocal).first('id')) {
    throw new ErrorApp(409, 'DUPLICADO', `Ya existe una sucursal local con el código ${datos.codLocal}`);
  }
  let apiSucursalId: number | null = null;
  if (datos.crearEnApi) {
    const existente = (await sucursalesApi()).find((s) => s.cod_local === datos.codLocal);
    if (existente) {
      throw new ErrorApp(409, 'SUCURSAL_EXISTE_EN_API', `API-PRO ya tiene la sucursal ${datos.codLocal} (${existente.nombre}). Créala sin marcar "crear en API-PRO" y vincúlala.`, undefined, { apiSucursalId: existente.id });
    }
    const { datos: creada } = await llamarJson<{ id: number }>(
      await obtenerCliente(), 'POST', '/sucursales', { operacion: 'sucursales.crear' },
      {
        cuerpo: { nombre: datos.nombre, cod_local: datos.codLocal, direccion: datos.direccion, ubigeo: datos.ubigeo, telefono: datos.telefono },
        idempotencyKey: req.get('Idempotency-Key') ?? undefined,
      },
    );
    apiSucursalId = creada.id;
  }
  const [id] = await db('sucursales').insert({
    nombre: datos.nombre,
    cod_local: datos.codLocal,
    api_sucursal_id: apiSucursalId,
    direccion: datos.direccion,
    ubigeo: datos.ubigeo,
    telefono: datos.telefono ?? null,
    modo_boletas: datos.modoBoletas,
    hora_resumen: `${datos.horaResumen}:00`,
  });
  const dto = await obtener(Number(id));
  await auditar(req, { accion: 'sucursal.crear', entidad: 'sucursal', entidadId: dto.id, despues: { ...dto, creadaEnApi: datos.crearEnApi } });
  return dto;
}

/** Edita solo los datos locales: la sucursal de API-PRO puede ser compartida con otros sistemas. */
export async function editar(
  req: Request,
  id: number,
  datos: Omit<CrearSucursalInput, 'codLocal' | 'crearEnApi'> & { activo: boolean },
): Promise<SucursalDto> {
  const antes = await obtener(id);
  if (!datos.activo && antes.activo) {
    const [{ n }] = (await db('dispositivos').where({ sucursal_id: id, activo: true }).count({ n: '*' })) as [{ n: number }];
    if (Number(n) > 0) throw new ErrorApp(409, 'ESTADO_NO_PERMITE', 'Desactiva primero los dispositivos de caja de esta sucursal');
  }
  await db('sucursales').where('id', id).update({
    nombre: datos.nombre,
    direccion: datos.direccion,
    ubigeo: datos.ubigeo,
    telefono: datos.telefono ?? null,
    modo_boletas: datos.modoBoletas,
    hora_resumen: `${datos.horaResumen}:00`,
    activo: datos.activo,
  });
  const despues = await obtener(id);
  await auditar(req, { accion: 'sucursal.editar', entidad: 'sucursal', entidadId: id, antes, despues });
  return despues;
}

/** Vincula la sucursal local con una sucursal existente de API-PRO y adopta su código de local. */
export async function vincular(req: Request, id: number, apiSucursalId: number): Promise<SucursalDto> {
  const antes = await obtener(id);
  const api = (await sucursalesApi()).find((s) => s.id === apiSucursalId);
  if (!api) throw new ErrorApp(404, 'NO_ENCONTRADO', 'Esa sucursal no existe en API-PRO');
  if (!api.activo) throw new ErrorApp(409, 'ESTADO_NO_PERMITE', 'La sucursal de API-PRO está desactivada');

  const otra = await db('sucursales').where('api_sucursal_id', apiSucursalId).whereNot('id', id).first('nombre');
  if (otra) throw new ErrorApp(409, 'DUPLICADO', `Esa sucursal de API-PRO ya está vinculada a ${otra.nombre}`);
  const mismoCodigo = await db('sucursales').where('cod_local', api.cod_local).whereNot('id', id).first('nombre');
  if (mismoCodigo) throw new ErrorApp(409, 'DUPLICADO', `El código ${api.cod_local} ya lo usa la sucursal local ${mismoCodigo.nombre}`);

  // El código de local que se envía a SUNAT es el de API-PRO.
  await db('sucursales').where('id', id).update({ api_sucursal_id: apiSucursalId, cod_local: api.cod_local });
  await sincronizarSeries();
  const despues = await obtener(id);
  await auditar(req, { accion: 'sucursal.vincular', entidad: 'sucursal', entidadId: id, antes, despues });
  return despues;
}

/**
 * Importa las sucursales activas de API-PRO que aún no existen aquí: crea cada una ya vinculada,
 * con su nombre, código de local, dirección, ubigeo y teléfono, y vuelve a sincronizar las series
 * para que queden asignadas. Solo lee de API-PRO.
 */
export async function importar(req: Request, apiIds?: number[]): Promise<{ creadas: SucursalDto[]; omitidas: Array<{ nombre: string; motivo: string }> }> {
  const api = (await sucursalesApi()).filter((s) => !apiIds || apiIds.includes(s.id));
  const locales = (await db('sucursales').select('id', 'nombre', 'cod_local', 'api_sucursal_id')) as Array<{ id: number; nombre: string; cod_local: string; api_sucursal_id: number | null }>;
  const creadas: SucursalDto[] = [];
  const omitidas: Array<{ nombre: string; motivo: string }> = [];
  for (const s of api) {
    if (!s.activo) {
      omitidas.push({ nombre: s.nombre, motivo: 'desactivada en API-PRO' });
      continue;
    }
    if (locales.some((l) => Number(l.api_sucursal_id) === s.id)) continue; // ya vinculada
    const mismoCodigo = locales.find((l) => l.cod_local === s.cod_local);
    if (mismoCodigo) {
      omitidas.push({ nombre: s.nombre, motivo: `el código ${s.cod_local} ya lo usa ${mismoCodigo.nombre}: vincúlala desde esa sucursal` });
      continue;
    }
    const [id] = await db('sucursales').insert({
      nombre: s.nombre.slice(0, 120),
      cod_local: s.cod_local,
      api_sucursal_id: s.id,
      direccion: s.direccion?.slice(0, 255) ?? null,
      ubigeo: s.ubigeo && /^\d{6}$/.test(s.ubigeo) ? s.ubigeo : null,
      telefono: s.telefono?.slice(0, 30) ?? null,
    });
    locales.push({ id: Number(id), nombre: s.nombre, cod_local: s.cod_local, api_sucursal_id: s.id });
    const dto = await obtener(Number(id));
    creadas.push(dto);
    await auditar(req, { accion: 'sucursal.importar', entidad: 'sucursal', entidadId: dto.id, despues: dto });
  }
  if (creadas.length) await sincronizarSeries();
  return { creadas, omitidas };
}
