import type { EmpresaDto, ProbarConexionDto } from '@sv/shared';
import type { Request } from 'express';
import { env } from '../../config/env.js';
import { db } from '../../database/db.js';
import type { ClienteApiPro, Credenciales } from '../../integrations/apiPro/cliente.js';
import { llamarJson } from '../../integrations/apiPro/llamada.js';
import { credencialesVigentes, crearCliente, obtenerCliente } from '../../integrations/apiPro/proveedor.js';
import { auditar } from '../../shared/auditoria.js';
import { verificarClave } from '../../shared/claves.js';
import { cifrar, enmascarar } from '../../shared/crypto.js';
import { ErrorApp } from '../../shared/errors.js';
import { sincronizar as sincronizarSeries } from '../series/series.service.js';

interface EmpresaApi {
  ruc: string;
  razon_social: string;
  nombre_comercial: string | null;
  direccion: string | null;
  entorno: 'beta' | 'production';
  tax_regime: string | null;
  tasa_igv_vigente: number;
  tiene_certificado: boolean;
  tiene_sol_pass: boolean;
  tiene_client_secret: boolean;
  activo: boolean;
}

interface SucursalApi {
  id: number;
  nombre: string;
  cod_local: string;
  total_series: number;
  activo: boolean;
}

export async function obtener(): Promise<EmpresaDto> {
  const e = await db('empresa').first();
  const { cred, origen } = await credencialesVigentes();
  return {
    ruc: e?.ruc ?? null,
    razonSocial: e?.razon_social ?? null,
    nombreComercial: e?.nombre_comercial ?? null,
    direccionFiscal: e?.direccion_fiscal ?? null,
    tasaIgv: e?.tasa_igv ?? '18.00',
    taxRegime: e?.tax_regime ?? null,
    modoEmision: e?.modo_emision ?? 'simulacion',
    api: {
      baseUrl: cred?.baseUrl ?? env.APIPRO_BASE_URL,
      origen,
      apiKey: cred ? enmascarar(cred.apiKey) : null,
      entorno: e?.apipro_entorno ?? null,
      verificadaEn: e?.conexion_verificada_en ? new Date(e.conexion_verificada_en).toISOString() : null,
    },
  };
}

async function leerEmpresaApi(cliente: ClienteApiPro): Promise<{ empresa: EmpresaApi; rateLimit: number | null }> {
  const { datos, respuesta } = await llamarJson<EmpresaApi>(cliente, 'GET', '/empresa', { operacion: 'empresa.leer' });
  const limite = Number(respuesta.cabeceras.get('x-ratelimit-limit'));
  return { empresa: datos, rateLimit: Number.isFinite(limite) && limite > 0 ? limite : null };
}

/** Prueba la conexión (solo lecturas), actualiza los datos de la empresa y sincroniza las series. */
export async function probarConexion(req: Request): Promise<ProbarConexionDto> {
  const cliente = await obtenerCliente();
  const { empresa, rateLimit } = await leerEmpresaApi(cliente);
  const { datos: sucursalesApi } = await llamarJson<SucursalApi[]>(cliente, 'GET', '/sucursales', { operacion: 'sucursales.leer' });
  const estado = await cliente.llamar<{ sunat?: { disponible: boolean } }>('GET', '/sunat/estado');
  const sunatDisponible = estado.tipo === 'json' && Boolean(estado.cuerpo?.sunat?.disponible);

  const actual = await db('empresa').first('id', 'ruc');
  if (actual && actual.ruc !== empresa.ruc) {
    throw new ErrorApp(409, 'EMPRESA_DISTINTA', `Las credenciales son del RUC ${empresa.ruc}, pero el sistema está configurado para ${actual.ruc}`);
  }
  const datosEmpresa = {
    razon_social: empresa.razon_social,
    direccion_fiscal: empresa.direccion,
    tasa_igv: empresa.tasa_igv_vigente,
    tax_regime: empresa.tax_regime,
    apipro_entorno: empresa.entorno,
    conexion_verificada_en: db.raw('CURRENT_TIMESTAMP(3)'),
  };
  if (actual) await db('empresa').where('id', actual.id).update(datosEmpresa);
  else await db('empresa').insert({ ruc: empresa.ruc, nombre_comercial: empresa.nombre_comercial ?? empresa.razon_social, ...datosEmpresa });

  const seriesSincronizadas = await sincronizarSeries();

  const vinculadas = await db('sucursales').whereNotNull('api_sucursal_id').select('id', 'api_sucursal_id');
  const porApi = new Map(vinculadas.map((v: { id: number; api_sucursal_id: number }) => [Number(v.api_sucursal_id), Number(v.id)]));

  const avisos: string[] = [];
  if (empresa.entorno === 'beta') avisos.push('La empresa está en el entorno beta de SUNAT: los comprobantes no tienen validez tributaria.');
  if (!empresa.tiene_certificado) avisos.push('La empresa no tiene certificado digital cargado en API-PRO.');
  if (!empresa.tiene_client_secret) avisos.push('Faltan las credenciales GRE (client_id/secret): no se podrán emitir guías de remisión.');
  if (!sunatDisponible) avisos.push('API-PRO informa que SUNAT no está disponible en este momento.');
  if (rateLimit && rateLimit < env.APIPRO_PRESUPUESTO_RPM) {
    avisos.push(`El límite de API-PRO (${rateLimit}/min) es menor que el presupuesto configurado (${env.APIPRO_PRESUPUESTO_RPM}/min).`);
  }
  if (!vinculadas.length) avisos.push('Ninguna sucursal del sistema está vinculada con una sucursal de API-PRO.');

  await auditar(req, { accion: 'empresa.probar_conexion', entidad: 'empresa', entidadId: empresa.ruc, despues: { entorno: empresa.entorno, sunatDisponible } });

  return {
    ok: true,
    ruc: empresa.ruc,
    razonSocial: empresa.razon_social,
    entorno: empresa.entorno,
    tasaIgv: empresa.tasa_igv_vigente,
    sunatDisponible,
    rateLimitPorMinuto: rateLimit,
    sucursalesApi: sucursalesApi.map((s) => ({
      id: s.id,
      codLocal: s.cod_local,
      nombre: s.nombre,
      totalSeries: s.total_series,
      vinculadaA: porApi.get(s.id) ?? null,
    })),
    seriesSincronizadas,
    avisos,
  };
}

export async function guardarCredenciales(
  req: Request,
  datos: { baseUrl: string; apiKey: string; apiSecret: string; password: string; confirmarCambioRuc?: boolean },
): Promise<EmpresaDto> {
  const u = await db('usuarios').where('id', req.sesion!.usuario.id).first('password_hash');
  if (!u || !(await verificarClave(u.password_hash, datos.password))) {
    throw new ErrorApp(422, 'VALIDACION', 'La contraseña no es correcta', { password: 'Contraseña incorrecta' });
  }
  const cred: Credenciales = { baseUrl: datos.baseUrl, apiKey: datos.apiKey, apiSecret: datos.apiSecret };
  // Se prueban antes de guardarlas: unas credenciales inválidas nunca reemplazan a las vigentes.
  const { empresa } = await leerEmpresaApi(crearCliente(cred));

  const actual = await db('empresa').first('id', 'ruc');
  if (actual && actual.ruc !== empresa.ruc && !datos.confirmarCambioRuc) {
    throw new ErrorApp(409, 'EMPRESA_DISTINTA', `Las credenciales son del RUC ${empresa.ruc}, distinto del configurado (${actual.ruc}).`, undefined, { rucNuevo: empresa.ruc });
  }
  const valores = {
    ruc: empresa.ruc,
    razon_social: empresa.razon_social,
    apipro_base_url: datos.baseUrl,
    apipro_key_enc: cifrar(datos.apiKey),
    apipro_secret_enc: cifrar(datos.apiSecret),
    apipro_entorno: empresa.entorno,
    conexion_verificada_en: db.raw('CURRENT_TIMESTAMP(3)'),
  };
  if (actual) await db('empresa').where('id', actual.id).update(valores);
  else await db('empresa').insert({ ...valores, nombre_comercial: empresa.nombre_comercial ?? empresa.razon_social, tasa_igv: empresa.tasa_igv_vigente });

  // Nunca se auditan los valores, solo el hecho y la parte visible de la key.
  await auditar(req, {
    accion: 'empresa.credenciales_api',
    entidad: 'empresa',
    entidadId: empresa.ruc,
    antes: { ruc: actual?.ruc ?? null },
    despues: { ruc: empresa.ruc, baseUrl: datos.baseUrl, apiKey: enmascarar(datos.apiKey) },
  });
  return obtener();
}

export async function editar(req: Request, datos: { nombreComercial: string; modoEmision: 'simulacion' | 'real' }): Promise<EmpresaDto> {
  const actual = await db('empresa').first();
  if (!actual) throw new ErrorApp(409, 'EMPRESA_NO_CONFIGURADA', 'Primero prueba la conexión con API-PRO para registrar la empresa');
  if (datos.modoEmision === 'real' && !actual.conexion_verificada_en) {
    throw new ErrorApp(409, 'CONEXION_NO_VERIFICADA', 'Prueba la conexión con API-PRO antes de activar la emisión real');
  }
  await db('empresa').where('id', actual.id).update({ nombre_comercial: datos.nombreComercial, modo_emision: datos.modoEmision });
  await auditar(req, {
    accion: 'empresa.editar',
    entidad: 'empresa',
    entidadId: actual.ruc,
    antes: { nombreComercial: actual.nombre_comercial, modoEmision: actual.modo_emision },
    despues: datos,
  });
  return obtener();
}
