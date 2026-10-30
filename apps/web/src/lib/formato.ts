// Formato para mostrar. Los cálculos oficiales los hace el servidor; aquí solo se presenta.

const soles = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function dinero(valor: string | number | null | undefined, moneda: 'PEN' | 'USD' = 'PEN'): string {
  if (valor == null || valor === '') return '—';
  return `${moneda === 'USD' ? 'US$' : 'S/'} ${soles.format(Number(valor))}`;
}

/** "2.500" → "2.5"; "3.000" → "3". */
export function cantidad(valor: string | number | null | undefined): string {
  if (valor == null || valor === '') return '—';
  return String(Number(valor));
}

export function fechaHora(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

export function hoyLima(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
}

export const TIPO_MOVIMIENTO: Record<string, string> = {
  stock_inicial: 'Stock inicial',
  compra: 'Compra',
  venta: 'Venta',
  devolucion_nc: 'Devolución (NC)',
  anulacion: 'Anulación de venta',
  ajuste_entrada: 'Ajuste (entrada)',
  ajuste_salida: 'Ajuste (salida)',
  traslado_salida: 'Traslado enviado',
  traslado_entrada: 'Traslado recibido',
  anulacion_compra: 'Anulación de compra',
  anulacion_traslado: 'Traslado anulado',
};
