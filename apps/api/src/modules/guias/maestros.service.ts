import type { ConductorDto, ConductorInput, TransportistaDto, TransportistaInput, UbigeoDto, VehiculoDto, VehiculoInput } from '@sv/shared';
import { db } from '../../database/db.js';
import { llamarJson } from '../../integrations/apiPro/llamada.js';
import { obtenerCliente } from '../../integrations/apiPro/proveedor.js';
import { ErrorApp, errores } from '../../shared/errors.js';

// Datos maestros de la guía de remisión: transportistas (transporte público), vehículos y
// conductores (transporte privado). La guía guarda una copia, así que editarlos no cambia guías emitidas.

const duplicado = (err: unknown, mensaje: string): never => {
  if ((err as { code?: string }).code === 'ER_DUP_ENTRY') throw new ErrorApp(409, 'DUPLICADO', mensaje);
  throw err;
};

export const aTransportista = (t: Record<string, unknown>): TransportistaDto => ({ id: Number(t.id), ruc: String(t.ruc), razonSocial: String(t.razon_social), nroMtc: (t.nro_mtc as string | null) ?? null, activo: Boolean(t.activo) });
export const aVehiculo = (v: Record<string, unknown>): VehiculoDto => ({ id: Number(v.id), placa: String(v.placa), nroCirculacion: (v.nro_circulacion as string | null) ?? null, descripcion: (v.descripcion as string | null) ?? null, activo: Boolean(v.activo) });
export const aConductor = (c: Record<string, unknown>): ConductorDto => ({ id: Number(c.id), tipoDoc: String(c.tipo_doc), numDoc: String(c.num_doc), nombres: String(c.nombres), apellidos: String(c.apellidos), licencia: String(c.licencia), activo: Boolean(c.activo) });

export const listarTransportistas = async () => (await db('transportistas').orderBy('razon_social')).map(aTransportista);
export const listarVehiculos = async () => (await db('vehiculos').orderBy('placa')).map(aVehiculo);
export const listarConductores = async () => (await db('conductores').orderBy(['apellidos', 'nombres'])).map(aConductor);

export async function guardarTransportista(d: TransportistaInput, id?: number): Promise<TransportistaDto> {
  const fila = { ruc: d.ruc, razon_social: d.razonSocial, nro_mtc: d.nroMtc ?? null, activo: d.activo };
  try {
    if (id) {
      if (!(await db('transportistas').where('id', id).update(fila))) throw errores.noEncontrado('Transportista');
    } else [id] = await db('transportistas').insert(fila);
  } catch (err) {
    duplicado(err, 'Ya existe un transportista con ese RUC');
  }
  return aTransportista(await db('transportistas').where('id', id).first());
}

export async function guardarVehiculo(d: VehiculoInput, id?: number): Promise<VehiculoDto> {
  const fila = { placa: d.placa, nro_circulacion: d.nroCirculacion ?? null, descripcion: d.descripcion ?? null, activo: d.activo };
  try {
    if (id) {
      if (!(await db('vehiculos').where('id', id).update(fila))) throw errores.noEncontrado('Vehículo');
    } else [id] = await db('vehiculos').insert(fila);
  } catch (err) {
    duplicado(err, 'Ya existe un vehículo con esa placa');
  }
  return aVehiculo(await db('vehiculos').where('id', id).first());
}

export async function guardarConductor(d: ConductorInput, id?: number): Promise<ConductorDto> {
  const fila = { tipo_doc: d.tipoDoc, num_doc: d.numDoc, nombres: d.nombres, apellidos: d.apellidos, licencia: d.licencia, activo: d.activo };
  try {
    if (id) {
      if (!(await db('conductores').where('id', id).update(fila))) throw errores.noEncontrado('Conductor');
    } else [id] = await db('conductores').insert(fila);
  } catch (err) {
    duplicado(err, 'Ya existe un conductor con ese documento');
  }
  return aConductor(await db('conductores').where('id', id).first());
}

// ---------- Ubigeos (caché local de GET /catalogos/ubigeo/*) ----------

type Nivel = 'region' | 'provincia' | 'distrito';
const RUTA: Record<Nivel, (padre?: string) => string> = {
  region: () => '/catalogos/ubigeo/regiones',
  provincia: (p) => `/catalogos/ubigeo/provincias?region_id=${p}`,
  distrito: (p) => `/catalogos/ubigeo/distritos?provincia_id=${p}`,
};

/**
 * Lista un nivel del ubigeo. Se consulta a API-PRO solo la primera vez: después se lee la caché
 * (el catálogo casi no cambia y cada consulta gasta del límite de 30 solicitudes por minuto).
 */
export async function ubigeos(nivel: Nivel, padre?: string): Promise<UbigeoDto[]> {
  const enCache = async () => (await db('ubigeos').where({ nivel, padre: padre ?? null }).orderBy('nombre').select('codigo', 'nombre')) as UbigeoDto[];
  const cache = await enCache();
  if (cache.length) return cache;
  const { datos } = await llamarJson<Array<{ id: string | number; nombre: string }>>(await obtenerCliente(), 'GET', RUTA[nivel](padre), { operacion: 'catalogo.ubigeo' });
  if (datos.length) {
    await db('ubigeos')
      .insert(datos.map((u) => ({ codigo: String(u.id).padStart(nivel === 'region' ? 2 : nivel === 'provincia' ? 4 : 6, '0'), nivel, nombre: u.nombre, padre: padre ?? null })))
      .onConflict('codigo')
      .merge(['nombre']);
  }
  return enCache();
}

/** "Lima / Lima / Rímac" para un ubigeo de distrito, si está en la caché. */
export async function nombreLugar(codigo: string): Promise<string | null> {
  const filas = await db('ubigeos').whereIn('codigo', [codigo.slice(0, 2), codigo.slice(0, 4), codigo]).select('codigo', 'nombre');
  if (filas.length < 3) return null;
  return [2, 4, 6].map((n) => filas.find((f: { codigo: string }) => f.codigo.length === n)?.nombre).join(' / ');
}
