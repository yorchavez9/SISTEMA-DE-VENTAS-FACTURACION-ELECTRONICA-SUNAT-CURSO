// Guardas obligatorias contra los bugs conocidos de API-PRO (docs/01-arquitectura.md §4.5).
// Cualquier llamada que no las cumpla se rechaza antes de salir a la red.

export class LlamadaProhibida extends Error {
  constructor(motivo: string) {
    super(`Llamada a API-PRO prohibida: ${motivo}`);
    this.name = 'LlamadaProhibida';
  }
}

const PROHIBIDAS: Array<{ metodo: string; patron: RegExp; motivo: string }> = [
  { metodo: 'DELETE', patron: /^\/empresa\/?$/, motivo: 'DELETE /empresa borra la empresa en API-PRO' },
  { metodo: 'GET', patron: /^\/anulaciones\/\d+\/estado$/, motivo: 'B1: marca como rechazada una baja en proceso; usa GET /anulaciones/{id}' },
  { metodo: 'GET', patron: /^\/guias-remision\/\d+\/estado$/, motivo: 'B1: marca como rechazada una guía en proceso; usa GET /guias-remision/{id}' },
  { metodo: 'POST', patron: /^\/consultar-cdr$/, motivo: 'B4: endpoint no fiable; usa GET /consultar-cpe' },
  { metodo: 'POST', patron: /^\/empresa\/credenciales\/regenerar$/, motivo: 'invalida las credenciales en uso' },
];

/** Campos de totales que API-PRO usaría en lugar de su propio cálculo (B7). */
const CAMPOS_TOTALES = [
  'mto_oper_gravadas', 'mto_oper_exoneradas', 'mto_oper_inafectas', 'mto_igv', 'mto_imp_venta',
  'total_impuestos', 'valor_venta', 'sub_total', 'mto_valor_venta', 'mto_base_igv', 'igv',
];

export function validarRuta(metodo: string, ruta: string): void {
  const [camino, query = ''] = ruta.split('?');
  if (!camino?.startsWith('/') || camino.startsWith('/api/')) {
    throw new LlamadaProhibida('las rutas deben ser relativas a /api/v1 (B9: los alias /api/sunat/* no se usan)');
  }
  for (const p of PROHIBIDAS) {
    if (p.metodo === metodo && p.patron.test(camino)) throw new LlamadaProhibida(p.motivo);
  }
  if (/\/pdf$/.test(camino) && /(^|&)formato=/.test(query)) {
    throw new LlamadaProhibida('usa ?format= en el PDF (boletas y notas ignoran ?formato=)');
  }
}

export function validarPayloadEmision(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const raiz = payload as Record<string, unknown>;
  const enRaiz = CAMPOS_TOTALES.filter((c) => c in raiz);
  const items = Array.isArray(raiz.items) ? (raiz.items as Record<string, unknown>[]) : [];
  const enItems = items.flatMap((it) => CAMPOS_TOTALES.filter((c) => c in it));
  if (enRaiz.length || enItems.length) {
    throw new LlamadaProhibida(`B7: el payload no debe incluir montos calculados (${[...new Set([...enRaiz, ...enItems])].join(', ')})`);
  }
}

/** B2: solo se puede (re)enviar un documento cuyo estado remoto, recién leído, lo permite. */
export function puedeEnviar(estadoRemoto: string): boolean {
  return estadoRemoto === 'pendiente' || estadoRemoto === 'rechazado';
}
