import type { Moneda, ProductoDto } from '@sv/shared';
import { useEffect, useState } from 'react';

export interface LineaCarrito {
  producto: ProductoDto;
  cantidad: string;
}

export interface Carrito {
  /** Clave de idempotencia de la venta: se conserva hasta que la venta se registra. */
  clave: string;
  moneda: Moneda;
  lineas: LineaCarrito[];
}

const nuevo = (): Carrito => ({ clave: crypto.randomUUID(), moneda: 'PEN', lineas: [] });

/**
 * Carrito persistido en sessionStorage por sucursal: si el navegador se recarga o falla la red,
 * la venta conserva su clave y reintentarla no la duplica.
 */
export function useCarrito(sucursalId: number) {
  const clave = `sv_carrito_${sucursalId}`;
  const [carrito, setCarrito] = useState<Carrito>(() => {
    try {
      const guardado = sessionStorage.getItem(clave);
      return guardado ? (JSON.parse(guardado) as Carrito) : nuevo();
    } catch {
      return nuevo();
    }
  });

  useEffect(() => {
    try {
      sessionStorage.setItem(clave, JSON.stringify(carrito));
    } catch {
      /* sin almacenamiento: el carrito vive solo en memoria */
    }
  }, [carrito, clave]);

  const agregar = (p: ProductoDto, cantidad = '1') =>
    setCarrito((c) => {
      const existe = c.lineas.find((l) => l.producto.id === p.id);
      if (existe) return { ...c, lineas: c.lineas.map((l) => (l.producto.id === p.id ? { ...l, cantidad: String(Number(l.cantidad) + Number(cantidad)) } : l)) };
      return { ...c, lineas: [...c.lineas, { producto: p, cantidad }] };
    });

  return {
    carrito,
    agregar,
    fijarCantidad: (id: number, cantidad: string) => setCarrito((c) => ({ ...c, lineas: c.lineas.map((l) => (l.producto.id === id ? { ...l, cantidad } : l)) })),
    quitar: (id: number) => setCarrito((c) => ({ ...c, lineas: c.lineas.filter((l) => l.producto.id !== id) })),
    fijarMoneda: (moneda: Moneda) => setCarrito((c) => ({ ...c, moneda })),
    vaciar: () => setCarrito((c) => ({ ...c, lineas: [] })),
    /** Tras registrar la venta: carrito vacío con una clave nueva. */
    reiniciar: () => setCarrito(nuevo()),
  };
}

/** Cantidad disponible para agregar (null = sin control de stock). */
export function disponible(p: ProductoDto, enCarrito: string | undefined): number | null {
  if (!p.inventariable) return null;
  return Number(p.stock ?? 0) - Number(enCarrito ?? 0);
}
