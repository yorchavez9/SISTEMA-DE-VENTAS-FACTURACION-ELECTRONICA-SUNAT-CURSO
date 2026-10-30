import { NOMBRE_TIPO_SERIE, PREFIJOS_SERIE, type OperacionSerie, type ResultadoValidacionSerie, type TipoSerie } from '@sv/shared';

// Reglas de bloqueo y advertencia para operar series en API-PRO
// (docs/00-plan-implementacion.md §0.10-c). Funciones puras: el servicio aporta el contexto.

export interface SerieEspejo {
  id: number;
  apiSerieId: number;
  tipoDoc: TipoSerie;
  serie: string;
  propia: boolean;
  activo: boolean;
  predeterminada: boolean;
  ultimoCorrelativo: number;
  sucursalId: number | null;
}

export interface SucursalDestino {
  id: number;
  nombre: string;
  apiSucursalId: number | null;
  activo: boolean;
}

export interface ContextoSerie {
  /** Espejo completo (activas e inactivas), recién sincronizado con API-PRO. */
  series: SerieEspejo[];
  /** Serie sobre la que se opera (no aplica a 'crear'). */
  serie?: SerieEspejo;
  /** Sucursal local de destino ('crear' y 'mover'). */
  sucursal?: SucursalDestino;
  /** Documentos de esta serie que aún esperan un resultado (pendientes, en curso, para resumen). */
  documentosEnCurso: number;
}

export function evaluarOperacion(op: OperacionSerie, ctx: ContextoSerie): ResultadoValidacionSerie {
  const bloqueos: string[] = [];
  const advertencias: string[] = [];
  let confirmacionRequerida = '';
  let requiereConfirmacionReforzada = false;

  const validarSucursal = (s: SucursalDestino | undefined) => {
    if (!s) bloqueos.push('La sucursal no existe.');
    else if (!s.activo) bloqueos.push(`La sucursal ${s.nombre} está desactivada.`);
    else if (!s.apiSucursalId) bloqueos.push(`La sucursal ${s.nombre} no está vinculada con una sucursal de API-PRO.`);
  };

  if (op.operacion === 'crear') {
    confirmacionRequerida = op.serie;
    const prefijos = PREFIJOS_SERIE[op.tipoDoc];
    if (!prefijos.includes(op.serie[0] ?? '')) {
      bloqueos.push(`Para ${NOMBRE_TIPO_SERIE[op.tipoDoc]} la serie debe empezar con ${prefijos.join(' o ')}.`);
    }
    const existente = ctx.series.find((s) => s.tipoDoc === op.tipoDoc && s.serie === op.serie);
    if (existente?.activo) {
      bloqueos.push(`La serie ${op.serie} ya existe en API-PRO para ${NOMBRE_TIPO_SERIE[op.tipoDoc]}.`);
    } else if (existente) {
      // API-PRO reactivaría la serie y reiniciaría su correlativo: se prohíbe "crear" encima.
      bloqueos.push(
        `La serie ${op.serie} existe desactivada (último número ${existente.ultimoCorrelativo}). ` +
          'Usa "Reactivar" para conservar su numeración; crearla de nuevo reiniciaría el correlativo y generaría números duplicados.',
      );
    }
    validarSucursal(ctx.sucursal);
    if (op.correlativoInicial > 0) {
      advertencias.push(`La numeración empezará en ${op.correlativoInicial + 1}; los números 1 a ${op.correlativoInicial} no se usarán.`);
    }
    if ((op.tipoDoc === '07' || op.tipoDoc === '08') && op.serie[0] === 'F') {
      advertencias.push('Esta serie solo servirá para notas sobre facturas (prefijo F).');
    }
    if ((op.tipoDoc === '07' || op.tipoDoc === '08') && op.serie[0] === 'B') {
      advertencias.push('Esta serie solo servirá para notas sobre boletas (prefijo B).');
    }
    advertencias.push('La serie se creará en API-PRO y quedará marcada como propia de este sistema.');
    return { permitido: bloqueos.length === 0, bloqueos, advertencias, confirmacionRequerida, requiereConfirmacionReforzada };
  }

  const serie = ctx.serie;
  if (!serie) {
    return { permitido: false, bloqueos: ['La serie no existe en el espejo local. Sincroniza las series.'], advertencias, confirmacionRequerida, requiereConfirmacionReforzada };
  }
  confirmacionRequerida = serie.serie;

  if (!serie.propia && op.operacion !== 'predeterminada') {
    requiereConfirmacionReforzada = true;
    advertencias.push(`${serie.serie} es una serie externa: la usan otros sistemas del mismo RUC. Modificarla puede afectarlos.`);
  }

  switch (op.operacion) {
    case 'correlativo': {
      if (op.correlativo <= serie.ultimoCorrelativo) {
        bloqueos.push(
          `No se permite bajar ni repetir el correlativo: el último usado es ${serie.ultimoCorrelativo}. ` +
            'API-PRO lo aceptaría y generaría números duplicados.',
        );
      } else if (op.correlativo > serie.ultimoCorrelativo + 1) {
        advertencias.push(
          `Se saltarán los números ${serie.ultimoCorrelativo + 1} a ${op.correlativo} (el próximo será ${op.correlativo + 1}). ` +
            'SUNAT no exige continuidad, pero el salto quedará en la auditoría.',
        );
      } else {
        advertencias.push(`Se saltará el número ${op.correlativo}; el próximo será ${op.correlativo + 1}.`);
      }
      if (ctx.documentosEnCurso > 0) bloqueos.push(`Hay ${ctx.documentosEnCurso} documento(s) de esta serie en curso; espera a que terminen.`);
      break;
    }
    case 'mover': {
      validarSucursal(ctx.sucursal);
      if (ctx.sucursal && ctx.sucursal.id === serie.sucursalId) bloqueos.push('La serie ya pertenece a esa sucursal.');
      if (ctx.documentosEnCurso > 0) bloqueos.push(`Hay ${ctx.documentosEnCurso} documento(s) de esta serie en curso o pendientes de resumen.`);
      advertencias.push('Los documentos ya emitidos conservan el código de local de la sucursal anterior.');
      if (serie.predeterminada) advertencias.push('Dejará de ser la serie predeterminada de la sucursal actual.');
      break;
    }
    case 'activar': {
      if (op.activo === serie.activo) bloqueos.push(op.activo ? 'La serie ya está activa.' : 'La serie ya está desactivada.');
      if (!op.activo) {
        if (ctx.documentosEnCurso > 0) bloqueos.push(`Hay ${ctx.documentosEnCurso} documento(s) de esta serie en curso o pendientes de resumen.`);
        advertencias.push('El punto de venta dejará de ofrecer esta serie.');
        if (serie.predeterminada) advertencias.push('Era la serie predeterminada: elige otra para la sucursal.');
      } else {
        advertencias.push(`Se reactivará conservando su numeración (próximo número ${serie.ultimoCorrelativo + 1}).`);
      }
      break;
    }
    case 'predeterminada': {
      if (!serie.propia) bloqueos.push('Solo una serie propia puede ser la predeterminada del punto de venta.');
      if (!serie.activo) bloqueos.push('La serie está desactivada.');
      if (!serie.sucursalId) bloqueos.push('La serie no pertenece a una sucursal de este sistema.');
      if (serie.predeterminada) bloqueos.push('Ya es la serie predeterminada.');
      break;
    }
  }

  return { permitido: bloqueos.length === 0, bloqueos, advertencias, confirmacionRequerida, requiereConfirmacionReforzada };
}
