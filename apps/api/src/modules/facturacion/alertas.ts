import type { AtascadosDto } from '@sv/shared';
import { db } from '../../database/db.js';
import { fechaLima } from '../../shared/fechas.js';
import { leerAjuste } from '../configuracion/configuracion.service.js';

// Alerta de documentos atascados (fase 10): algo que debería haberse resuelto solo y no lo hizo.
// Se muestra en la franja global de la app y el worker lo deja en el log cada 15 minutos.

const EN_CURSO_CPE = ['pendiente', 'enviando', 'por_verificar', 'en_proceso', 'anulacion_en_proceso'];
const EN_CURSO_GUIA = ['pendiente', 'enviando', 'por_verificar', 'en_proceso'];

export async function atascados(sucursalIds: number[] | null): Promise<AtascadosDto> {
  const minutos = await leerAjuste('alertas.comprobante_atascado_min', 30);
  const limite = db.raw('CURRENT_TIMESTAMP(3) - INTERVAL ? MINUTE', [minutos]);
  const ayer = new Date(`${fechaLima()}T12:00:00Z`);
  ayer.setUTCDate(ayer.getUTCDate() - 1);
  const suc = <T extends { whereIn: (c: string, v: number[]) => T }>(q: T, col = 'sucursal_id') => (sucursalIds ? q.whereIn(col, sucursalIds) : q);

  const [cpe, resumen, guias, fallidos] = await Promise.all([
    suc(db('comprobantes').whereIn('estado', EN_CURSO_CPE).where('updated_at', '<', limite))
      .orderBy('updated_at')
      .limit(20)
      .select('id', 'numero_completo', 'serie', 'estado', 'updated_at'),
    // Boletas que debían ir en el resumen diario de ayer o antes y siguen sin declararse.
    suc(db('comprobantes').where('estado', 'pendiente_resumen').where('fecha_emision', '<', ayer.toISOString().slice(0, 10))).count({ n: '*' }),
    suc(db('guias').where((w) => w.where((x) => x.whereIn('estado', EN_CURSO_GUIA).where('updated_at', '<', limite)).orWhere('estado', 'sin_respuesta_sunat')))
      .orderBy('updated_at')
      .limit(20)
      .select('id', 'numero_completo', 'serie', 'estado', 'updated_at'),
    db('outbox_trabajos').where('estado', 'fallido').where('updated_at', '>', db.raw('CURRENT_TIMESTAMP(3) - INTERVAL 7 DAY')).count({ n: '*' }),
  ]);
  const aItem = (tipo: 'comprobante' | 'guia') => (f: Record<string, unknown>) => ({
    tipo,
    id: Number(f.id),
    numero: (f.numero_completo as string | null) ?? `${f.serie}-…`,
    estado: String(f.estado),
    desde: new Date(f.updated_at as string).toISOString(),
  });
  const boletasSinResumen = Number((resumen[0] as { n: number }).n);
  const trabajosFallidos = Number((fallidos[0] as { n: number }).n);
  const items = [...cpe.map(aItem('comprobante')), ...guias.map(aItem('guia'))];
  return { minutos, total: items.length + boletasSinResumen + trabajosFallidos, items, boletasSinResumen, trabajosFallidos };
}
