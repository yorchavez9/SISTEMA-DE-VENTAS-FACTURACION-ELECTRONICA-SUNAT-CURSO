import type { SesionDto } from '@sv/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { ErrorHttp, fijarContextoHttp, pedir } from './http';

const CLAVE_DISPOSITIVO = 'sv_dispositivo';

/** Token del dispositivo de caja guardado en este navegador (si fue registrado como POS). */
export function tokenDispositivo(): string | null {
  try {
    return localStorage.getItem(CLAVE_DISPOSITIVO);
  } catch {
    return null;
  }
}

export function guardarTokenDispositivo(token: string | null): void {
  try {
    if (token) localStorage.setItem(CLAVE_DISPOSITIVO, token);
    else localStorage.removeItem(CLAVE_DISPOSITIVO);
  } catch {
    /* sin almacenamiento: el navegador no quedará registrado */
  }
}

interface ContextoSesion {
  sesion: SesionDto | null;
  cargando: boolean;
  puede: (...permisos: string[]) => boolean;
  fijar: (s: SesionDto | null) => void;
  salir: () => Promise<void>;
  elegirSucursal: (id: number) => Promise<void>;
}

const Contexto = createContext<ContextoSesion | null>(null);

export function ProveedorSesion({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['sesion'],
    queryFn: async () => {
      try {
        return await pedir<SesionDto>('/auth/me');
      } catch (err) {
        if (err instanceof ErrorHttp && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
  const sesion = data ?? null;

  const fijar = useCallback((s: SesionDto | null) => {
    if (!s) qc.clear();
    qc.setQueryData(['sesion'], s);
  }, [qc]);

  useEffect(() => {
    fijarContextoHttp({
      csrf: sesion?.csrfToken ?? null,
      sucursal: sesion?.sucursalActiva?.id ?? null,
      alExpirar: () => fijar(null),
    });
  }, [sesion, fijar]);

  const valor = useMemo<ContextoSesion>(
    () => ({
      sesion,
      cargando: isLoading,
      puede: (...p) => Boolean(sesion && p.every((x) => sesion.permisos.includes(x))),
      fijar,
      salir: async () => {
        try {
          await pedir('/auth/logout', { method: 'POST' });
        } finally {
          fijar(null);
        }
      },
      elegirSucursal: async (id) => {
        const r = await pedir<{ sucursalActiva: SesionDto['sucursalActiva'] }>('/auth/sucursal', { cuerpo: { sucursalId: id } });
        if (sesion) {
          // Los datos en caché son de otra sucursal: se descartan.
          qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'sesion' });
          fijar({ ...sesion, sucursalActiva: r.sucursalActiva });
        }
      },
    }),
    [sesion, isLoading, fijar, qc],
  );

  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

export function useSesion(): ContextoSesion {
  const c = useContext(Contexto);
  if (!c) throw new Error('useSesion fuera de ProveedorSesion');
  return c;
}
