import type { CajaDto, MetodoPagoDto } from '@sv/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { pedir } from './http';
import { useSesion } from './sesion';

const clave = (sucursalId: number) => `sv_caja_${sucursalId}`;

/** Caja elegida en este navegador para la sucursal activa (se recuerda entre sesiones). */
export function useCajaActiva() {
  const { sesion, puede } = useSesion();
  const sucursalId = sesion?.sucursalActiva?.id ?? 0;
  const consulta = useQuery({ queryKey: ['cajas', sucursalId], queryFn: () => pedir<CajaDto[]>('/cajas'), enabled: Boolean(sucursalId) && puede('caja.ver'), refetchInterval: 60_000 });
  const cajas = (consulta.data ?? []).filter((c) => c.activo);
  const [elegida, setElegida] = useState<number | null>(() => {
    try {
      return Number(localStorage.getItem(clave(sucursalId))) || null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (!cajas.length) return;
    if (!elegida || !cajas.some((c) => c.id === elegida)) setElegida(cajas[0]!.id);
  }, [cajas, elegida]);

  const elegir = (id: number) => {
    setElegida(id);
    try {
      localStorage.setItem(clave(sucursalId), String(id));
    } catch {
      /* sin almacenamiento: solo esta pestaña */
    }
  };

  return { cajas, caja: cajas.find((c) => c.id === elegida) ?? null, elegir, cargando: consulta.isLoading, refrescar: consulta.refetch };
}

export const useMetodosPago = () => useQuery({ queryKey: ['metodos-pago'], queryFn: () => pedir<MetodoPagoDto[]>('/metodos-pago'), staleTime: Infinity });
