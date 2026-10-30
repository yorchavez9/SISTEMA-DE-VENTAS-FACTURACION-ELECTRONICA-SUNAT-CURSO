import { useState } from 'react';
import type { z } from 'zod';
import { ErrorHttp } from './http';

/**
 * Estado mínimo de formulario con validación zod (los mismos esquemas que usa el backend)
 * y errores por campo que también llegan del servidor ({ campos }).
 */
export function useFormulario<T extends Record<string, unknown>>(inicial: T) {
  const [valores, setValores] = useState<T>(inicial);
  const [errores, setErrores] = useState<Record<string, string>>({});
  const [enviando, setEnviando] = useState(false);

  const fijar = <K extends keyof T>(campo: K, valor: T[K]) => {
    setValores((v) => ({ ...v, [campo]: valor }));
    setErrores((e) => {
      if (!e[campo as string]) return e;
      const { [campo as string]: _, ...resto } = e;
      return resto;
    });
  };

  /** Props para un <input> de texto controlado. */
  const texto = (campo: keyof T) => ({
    value: String(valores[campo] ?? ''),
    onChange: (e: { target: { value: string } }) => fijar(campo, e.target.value as T[keyof T]),
    error: errores[campo as string],
  });

  function validar<S extends z.ZodType>(esquema: S, datos: unknown = valores): z.infer<S> | null {
    const r = esquema.safeParse(datos);
    if (r.success) return r.data;
    setErrores(Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message])));
    return null;
  }

  /** Ejecuta el envío; si el servidor devuelve errores por campo, los marca. Devuelve false si falló. */
  async function enviar(fn: () => Promise<void>): Promise<boolean> {
    setEnviando(true);
    try {
      await fn();
      return true;
    } catch (err) {
      if (err instanceof ErrorHttp && Object.keys(err.campos).length) setErrores(err.campos);
      throw err;
    } finally {
      setEnviando(false);
    }
  }

  return { valores, setValores, fijar, texto, errores, setErrores, validar, enviar, enviando };
}
