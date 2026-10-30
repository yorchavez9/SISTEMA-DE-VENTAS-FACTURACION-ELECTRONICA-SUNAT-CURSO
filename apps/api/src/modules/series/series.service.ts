import { TIPOS_SERIE, type OperacionSerie, type ResultadoValidacionSerie, type SerieDto, type TipoSerie } from '@sv/shared';
import type { Request } from 'express';
import { db } from '../../database/db.js';
import { llamarJson } from '../../integrations/apiPro/llamada.js';
import { obtenerCliente } from '../../integrations/apiPro/proveedor.js';
import { auditar } from '../../shared/auditoria.js';
import { ErrorApp, errores } from '../../shared/errors.js';
import { evaluarOperacion, type ContextoSerie, type SerieEspejo, type SucursalDestino } from './series.reglas.js';

/** Nombre del tipo en API-PRO (Serie::TIPOS). */
const TIPO_API: Record<TipoSerie, string> = {
  '01': 'factura',
  '03': 'boleta',
  '07': 'nota_credito',
  '08': 'nota_debito',
  '09': 'guia_remision',
};

interface SerieApi {
  id: number;
  tipo_documento: string;
  serie: string;
  correlativo: number;
  activo: boolean;
  sucursal: { id: number; nombre: string; cod_local: string } | null;
}

/** Trae todas las series de API-PRO (incluidas las inactivas) y actualiza el espejo local. */
export async function sincronizar(): Promise<number> {
  const cliente = await obtenerCliente();
  const { datos } = await llamarJson<SerieApi[]>(cliente, 'GET', '/series?include_inactive=1', { operacion: 'series.sincronizar' });
  const locales = await db('sucursales').whereNotNull('api_sucursal_id').select('id', 'api_sucursal_id');
  const sucursalLocal = new Map(locales.map((s: { id: number; api_sucursal_id: number }) => [Number(s.api_sucursal_id), Number(s.id)]));

  const relevantes = datos.filter((s) => (TIPOS_SERIE as readonly string[]).includes(s.tipo_documento));
  for (const s of relevantes) {
    const apiSucursalId = s.sucursal?.id ?? null;
    const tipoDoc = s.tipo_documento as TipoSerie;
    await db('series')
      .insert({
        api_serie_id: s.id,
        tipo_doc: tipoDoc,
        serie: s.serie,
        aplica_a: tipoDoc === '07' || tipoDoc === '08' ? s.serie[0] : null,
        ultimo_correlativo: s.correlativo,
        activo: s.activo,
        api_sucursal_id: apiSucursalId,
        api_cod_local: s.sucursal?.cod_local ?? null,
        sucursal_id: apiSucursalId ? (sucursalLocal.get(apiSucursalId) ?? null) : null,
        sincronizado_en: db.raw('CURRENT_TIMESTAMP(3)'),
      })
      .onConflict('api_serie_id')
      .merge(['ultimo_correlativo', 'activo', 'api_sucursal_id', 'api_cod_local', 'sucursal_id', 'sincronizado_en']);
  }
  // Una serie que dejó de estar activa o cambió de sucursal no puede seguir como predeterminada.
  await db('series').where('predeterminada', true).andWhere((q) => q.where('activo', false).orWhereNull('sucursal_id')).update({ predeterminada: false });
  return relevantes.length;
}

interface FilaSerie {
  id: number | string;
  api_serie_id: number | string;
  tipo_doc: TipoSerie;
  serie: string;
  aplica_a: 'F' | 'B' | null;
  propia: number | boolean;
  activo: number | boolean;
  predeterminada: number | boolean;
  ultimo_correlativo: number;
  sucursal_id: number | string | null;
  api_sucursal_id: number | string | null;
  api_cod_local: string | null;
  sincronizado_en: Date | null;
  sucursal_nombre: string | null;
  sucursal_cod_local: string | null;
}

const consultaBase = () =>
  db('series as se')
    .leftJoin('sucursales as su', 'su.id', 'se.sucursal_id')
    .select('se.*', 'su.nombre as sucursal_nombre', 'su.cod_local as sucursal_cod_local')
    .orderBy([{ column: 'se.tipo_doc' }, { column: 'se.serie' }]);

function aEspejo(f: FilaSerie): SerieEspejo {
  return {
    id: Number(f.id),
    apiSerieId: Number(f.api_serie_id),
    tipoDoc: f.tipo_doc,
    serie: f.serie,
    propia: Boolean(f.propia),
    activo: Boolean(f.activo),
    predeterminada: Boolean(f.predeterminada),
    ultimoCorrelativo: Number(f.ultimo_correlativo),
    sucursalId: f.sucursal_id == null ? null : Number(f.sucursal_id),
  };
}

function aDto(f: FilaSerie): SerieDto {
  return {
    ...aEspejo(f),
    aplicaA: f.aplica_a,
    sucursal: f.sucursal_id == null ? null : { id: Number(f.sucursal_id), nombre: f.sucursal_nombre ?? '', codLocal: f.sucursal_cod_local ?? '' },
    apiSucursal: f.api_sucursal_id == null ? null : { id: Number(f.api_sucursal_id), codLocal: f.api_cod_local ?? '' },
    sincronizadoEn: f.sincronizado_en ? new Date(f.sincronizado_en).toISOString() : null,
  };
}

export async function listar(filtro: { sucursalId?: number; tipoDoc?: string; soloActivas?: boolean } = {}): Promise<SerieDto[]> {
  const q = consultaBase();
  if (filtro.sucursalId) q.where('se.sucursal_id', filtro.sucursalId);
  if (filtro.tipoDoc) q.where('se.tipo_doc', filtro.tipoDoc);
  if (filtro.soloActivas) q.where('se.activo', true);
  return ((await q) as FilaSerie[]).map(aDto);
}

let hayTablaComprobantes: boolean | undefined;
/** Documentos de la serie que aún esperan resultado. La tabla comprobantes llega en la fase 6/7. */
async function documentosEnCurso(serieId: number): Promise<number> {
  hayTablaComprobantes ??= await db.schema.hasTable('comprobantes');
  if (!hayTablaComprobantes) return 0;
  const [{ n }] = (await db('comprobantes')
    .where('serie_id', serieId)
    .whereIn('estado', ['pendiente', 'enviando', 'en_proceso', 'pendiente_resumen', 'en_resumen', 'por_verificar', 'anulacion_en_proceso'])
    .count({ n: '*' })) as [{ n: number }];
  return Number(n);
}

async function sucursalDestino(id: number): Promise<SucursalDestino | undefined> {
  const s = await db('sucursales').where('id', id).first('id', 'nombre', 'api_sucursal_id', 'activo');
  return s ? { id: Number(s.id), nombre: s.nombre, apiSucursalId: s.api_sucursal_id == null ? null : Number(s.api_sucursal_id), activo: Boolean(s.activo) } : undefined;
}

async function contexto(op: OperacionSerie): Promise<ContextoSerie> {
  const filas = (await consultaBase()) as FilaSerie[];
  const series = filas.map(aEspejo);
  const serie = 'serieId' in op ? series.find((s) => s.id === op.serieId) : undefined;
  if ('serieId' in op && !serie) throw errores.noEncontrado('Serie');
  const sucursalId = op.operacion === 'crear' || op.operacion === 'mover' ? op.sucursalId : undefined;
  return {
    series,
    serie,
    sucursal: sucursalId ? await sucursalDestino(sucursalId) : undefined,
    documentosEnCurso: serie ? await documentosEnCurso(serie.id) : 0,
  };
}

/** Previsualización sin efectos. Sincroniza antes para evaluar con el correlativo real de API-PRO. */
export async function validar(op: OperacionSerie): Promise<ResultadoValidacionSerie> {
  if (op.operacion !== 'predeterminada') await sincronizar();
  return evaluarOperacion(op, await contexto(op));
}

export async function aplicar(
  req: Request,
  op: OperacionSerie & { confirmacion: string; confirmacionReforzada?: boolean },
): Promise<SerieDto> {
  const resultado = await validar(op);
  if (!resultado.permitido) {
    throw new ErrorApp(409, 'SERIE_BLOQUEADA', resultado.bloqueos[0] ?? 'Operación no permitida', undefined, resultado);
  }
  if (op.confirmacion !== resultado.confirmacionRequerida) {
    throw new ErrorApp(422, 'VALIDACION', `Escribe ${resultado.confirmacionRequerida} para confirmar`, { confirmacion: 'No coincide' });
  }
  if (resultado.requiereConfirmacionReforzada && !op.confirmacionReforzada) {
    throw new ErrorApp(422, 'VALIDACION', 'Confirma que entiendes que la serie la usan otros sistemas', { confirmacionReforzada: 'Requerido' });
  }

  const ctx = await contexto(op);
  const antes = ctx.serie ?? null;
  const idempotencyKey = req.get('Idempotency-Key') ?? undefined;
  let apiSerieId: number | undefined = ctx.serie?.apiSerieId;

  if (op.operacion === 'predeterminada') {
    const s = ctx.serie!;
    await db.transaction(async (trx) => {
      await trx('series')
        .where({ sucursal_id: s.sucursalId, tipo_doc: s.tipoDoc })
        .modify((q) => (s.tipoDoc === '07' || s.tipoDoc === '08' ? q.where('aplica_a', s.serie[0]) : q))
        .update({ predeterminada: false });
      await trx('series').where('id', s.id).update({ predeterminada: true });
    });
  } else {
    const cliente = await obtenerCliente();
    const contextoLog = { operacion: `series.${op.operacion}`, entidadTipo: 'serie', entidadId: ctx.serie?.id };
    if (op.operacion === 'crear') {
      const { datos } = await llamarJson<{ creadas: Array<{ id: number }>; errores?: string[] }>(
        cliente, 'POST', '/series', contextoLog,
        {
          cuerpo: { tipo: TIPO_API[op.tipoDoc], serie: op.serie, sucursal_id: ctx.sucursal!.apiSucursalId, correlativo_inicial: op.correlativoInicial },
          idempotencyKey,
        },
      );
      apiSerieId = datos.creadas[0]?.id;
      if (!apiSerieId) throw new ErrorApp(422, 'APIPRO_VALIDACION', `API-PRO no creó la serie: ${(datos.errores ?? []).join(' · ')}`);
    } else {
      const cuerpo =
        op.operacion === 'correlativo' ? { correlativo: op.correlativo }
        : op.operacion === 'mover' ? { sucursal_id: ctx.sucursal!.apiSucursalId }
        : { activo: op.activo };
      await llamarJson(cliente, 'PUT', `/series/${apiSerieId}`, contextoLog, { cuerpo, idempotencyKey });
    }
    await sincronizar();
    if (op.operacion === 'crear') await db('series').where('api_serie_id', apiSerieId).update({ propia: true });
  }

  const fila = (await consultaBase().where('se.api_serie_id', apiSerieId).first()) as FilaSerie;
  const despues = aDto(fila);
  await auditar(req, { accion: `serie.${op.operacion}`, entidad: 'serie', entidadId: despues.id, antes, despues: { ...despues, advertencias: resultado.advertencias } });
  return despues;
}
