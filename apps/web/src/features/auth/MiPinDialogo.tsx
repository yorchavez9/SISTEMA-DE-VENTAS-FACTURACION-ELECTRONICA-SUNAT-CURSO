import { fijarPinSchema } from '@sv/shared';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Boton, Campo, Dialogo, ui, useToast } from '../../components/ui';
import { useFormulario } from '../../lib/formulario';
import { mensajeError, pedir } from '../../lib/http';

export function MiPinDialogo({ abierto, alCerrar }: { abierto: boolean; alCerrar: () => void }) {
  const toast = useToast();
  const navegar = useNavigate();
  const f = useFormulario({ password: '', pinNuevo: '', repetir: '' });

  const guardar = async () => {
    if (f.valores.pinNuevo !== f.valores.repetir) return f.setErrores({ repetir: 'Los dos PIN nuevos no son iguales.' });
    const datos = f.validar(fijarPinSchema);
    if (!datos) return;
    try {
      await f.enviar(() => pedir('/auth/pin', { method: 'PUT', cuerpo: datos }));
      toast('PIN guardado.', 'ok');
      f.setValores({ password: '', pinNuevo: '', repetir: '' });
      alCerrar();
    } catch (err) {
      toast(mensajeError(err), 'error');
    }
  };

  return (
    <Dialogo
      titulo="Cambiar mi PIN"
      chico
      abierto={abierto}
      alCerrar={alCerrar}
      pie={
        <>
          <Button variant="link" className="mr-auto h-auto px-0 text-[0.8125rem] text-marca" onClick={() => (alCerrar(), navegar('/cambiar-password'))}>
            Cambiar contraseña
          </Button>
          <Boton onClick={alCerrar}>Cancelar</Boton>
          <Boton variante="primario" onClick={guardar} cargando={f.enviando}>
            Guardar PIN
          </Boton>
        </>
      }
    >
      <p className="m-0 mb-4 text-sm font-normal text-muted-foreground">Con tu PIN entras al sistema eligiendo tu usuario, cambias de cajero y autorizas acciones de supervisor.</p>
      <div className={ui.form}>
        <Campo etiqueta="Tu contraseña" type="password" autoComplete="current-password" {...f.texto('password')} />
        <Campo etiqueta="PIN nuevo" type="password" inputMode="numeric" maxLength={6} placeholder="4 a 6 dígitos" ayuda="Entre 4 y 6 dígitos." {...f.texto('pinNuevo')} />
        <Campo etiqueta="Repite el PIN nuevo" type="password" inputMode="numeric" maxLength={6} placeholder="El mismo PIN nuevo" {...f.texto('repetir')} />
      </div>
    </Dialogo>
  );
}
