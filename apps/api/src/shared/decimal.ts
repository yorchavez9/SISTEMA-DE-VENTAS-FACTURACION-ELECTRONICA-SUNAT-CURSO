import { Decimal } from 'decimal.js';

// Aritmética decimal exacta para importes y cantidades (ADR-12). Nunca usar `number`.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };

export const dec = (v: Decimal.Value | null | undefined): Decimal => new Decimal(v ?? 0);

/** Cantidad con 3 decimales como string, igual que DECIMAL(14,3). */
export const aCantidad = (v: Decimal.Value): string => dec(v).toFixed(3);

/** Precio con 6 decimales como string, igual que DECIMAL(16,6). */
export const aPrecio = (v: Decimal.Value): string => dec(v).toFixed(6);

/** Importe con 2 decimales como string, igual que DECIMAL(14,2). */
export const aImporte = (v: Decimal.Value): string => dec(v).toFixed(2);

/** Quita ceros finales para mostrar: "2.500" → "2.5", "3.000" → "3". */
export const compacto = (v: Decimal.Value): string => dec(v).toString();
