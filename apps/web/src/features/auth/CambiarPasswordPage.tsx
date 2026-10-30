import { cambiarPasswordSchema } from '@sv/shared';
import { KeyRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Boton, Campo, Franja, ui, useToast } from '../../components/ui';
import { useFormulario } from '../../lib/formulario';
import { mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';
import css from './auth.module.css';
import { Card } from '@/components/ui/card';

/** Cambio de contraseña. Obligatorio tras recibir una contraseña temporal. */
export function CambiarPasswordPage() {
  const { sesion, fijar, salir } = useSesion();
  const navegar = useNavigate();
  const toast = useToast();
  const f = useFormulario({ actual: '', nueva: '', repetir: '' });
  const [error, setError] = useState<string | null>(null);

  if (!sesion) return <Navigate to="/login" replace />;
  const obligatorio = sesion.debeCambiarPassword;

  const alEnviar = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (f.valores.nueva !== f.valores.repetir) {
      f.setErrores({ repetir: 'No coincide con la nueva contraseña' });
      return;
    }
    const datos = f.validar(cambiarPasswordSchema);
    if (!datos) return;
    try {
      await f.enviar(async () => {
        await pedir('/auth/password', { cuerpo: datos });
        fijar({ ...sesion, debeCambiarPassword: false });
        toast('Contraseña actualizada. Se cerraron tus otras sesiones.', 'ok');
        navegar('/', { replace: true });
      });
    } catch (err) {
      setError(mensajeError(err));
    }
  };

  return (
    <div className={css.fondo}>
      <Card className={css.tarjeta}>
<form className="contents" onSubmit={alEnviar} noValidate>
        <div className={css.marca}>
          <span className={css.logo}>
            <KeyRound size={20} strokeWidth={2.5} />
          </span>
          <h1>{obligatorio ? 'Crea tu contraseña' : 'Cambiar contraseña'}</h1>
          {obligatorio && <span className="muted">Tu contraseña es temporal: elige una nueva para continuar.</span>}
        </div>
        {error && <Franja tono="alerta">{error}</Franja>}
        <div className={ui.form}>
          <Campo etiqueta={obligatorio ? 'Contraseña temporal' : 'Contraseña actual'} type="password" autoComplete="current-password" autoFocus {...f.texto('actual')} />
          <Campo etiqueta="Nueva contraseña" type="password" autoComplete="new-password" ayuda="Mínimo 8 caracteres, con letras y números." {...f.texto('nueva')} />
          <Campo etiqueta="Repite la nueva contraseña" type="password" autoComplete="new-password" {...f.texto('repetir')} />
        </div>
        <Boton variante="primario" type="submit" cargando={f.enviando}>
          Guardar contraseña
        </Boton>
        {obligatorio ? (
          <Boton variante="plano" onClick={() => void salir()}>
            Salir
          </Boton>
        ) : (
          <Boton variante="plano" onClick={() => navegar(-1)}>
            Cancelar
          </Boton>
        )}
      </form>
</Card>
    </div>
  );
}
