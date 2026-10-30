import { useCallback, useState } from 'react';

export function useTema() {
  const [oscuro, setOscuro] = useState(() => document.documentElement.classList.contains('dark'));

  const alternar = useCallback(() => {
    setOscuro((o) => {
      const nuevo = !o;
      document.documentElement.classList.toggle('dark', nuevo);
      try {
        localStorage.setItem('sv_tema', nuevo ? 'dark' : 'light');
      } catch {
        /* sin almacenamiento: se mantiene solo en esta pestaña */
      }
      return nuevo;
    });
  }, []);

  return { oscuro, alternar };
}
