import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Vacio } from '../components/ui';
import { useSesion } from '../lib/sesion';
import css from '../features/auth/auth.module.css';

/** Exige sesión; si la contraseña es temporal, obliga a cambiarla antes de seguir. */
export function RequiereSesion({ children }: { children: ReactNode }) {
  const { sesion, cargando } = useSesion();
  const { pathname } = useLocation();
  if (cargando) return <div className={css.cargando}>Cargando…</div>;
  if (!sesion) return <Navigate to="/login" replace state={{ desde: pathname }} />;
  if (sesion.debeCambiarPassword) return <Navigate to="/cambiar-password" replace />;
  return <>{children}</>;
}

export function RequierePermiso({ permiso, children }: { permiso: string; children: ReactNode }) {
  const { puede } = useSesion();
  if (!puede(permiso)) return <Vacio texto="No tienes permiso para ver esta sección." />;
  return <>{children}</>;
}
