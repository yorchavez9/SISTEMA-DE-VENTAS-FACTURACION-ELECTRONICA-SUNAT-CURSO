import type { AccionAutorizable, SesionDto } from '@sv/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorHttp, mensajeError, pedir } from '../lib/http';
import { useSesion } from '../lib/sesion';
import { Boton, Dialogo, Franja, TecladoPin, ui } from './ui';
import { Button } from './ui/button';

interface UsuarioPin {
  id: number;
  nombre: string;
  rol: string;
}

const TEXTO_ACCION: Record<AccionAutorizable, string> = {
  descuento: 'aplicar el descuento',
  anular: 'anular',
  abrir_cajon: 'abrir el cajón',
  credito_excedido: 'vender al crédito a este cliente',
  credenciales_api: 'cambiar las credenciales',
};

/** Píldoras para elegir quién autoriza (como pedirPin de ferretería): la elegida en primario. */
function ElegirUsuario({ usuarios, elegido, alElegir }: { usuarios: UsuarioPin[]; elegido: number | null; alElegir: (id: number) => void }) {
  return (
    <div className="mb-[0.9rem] flex flex-wrap gap-[0.4rem]" role="group" aria-label="Usuario">
      {usuarios.map((u) => (
        <Button
          key={u.id}
          variant={u.id === elegido ? 'default' : 'ghost'}
          aria-pressed={u.id === elegido}
          className={u.id === elegido ? 'h-8 rounded-full px-3 text-[0.8125rem] font-semibold' : 'h-8 rounded-full bg-campo px-3 text-[0.8125rem] font-semibold '}
          onClick={() => alElegir(u.id)}
        >
          {u.nombre}
        </Button>
      ))}
    </div>
  );
}

/** Intentos del PIN: muestra el error y sacude el teclado. */
function usePin() {
  const [error, setError] = useState<string | null>(null);
  const [intento, setIntento] = useState(0);
  const fallar = (err: unknown) => {
    if (err instanceof ErrorHttp && err.codigo === 'PIN_INVALIDO') {
      const restantes = (err.cuerpo.detalle as { intentosRestantes?: number } | undefined)?.intentosRestantes;
      setError(`PIN incorrecto${restantes !== undefined ? ` · quedan ${restantes} intentos` : ''}`);
    } else if (err instanceof ErrorHttp && err.codigo === 'BLOQUEADO') {
      const hasta = (err.cuerpo.detalle as { hasta?: string } | undefined)?.hasta;
      setError(`Bloqueado${hasta ? ` hasta las ${new Date(hasta).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}` : ''}`);
    } else setError(mensajeError(err));
    setIntento((n) => n + 1);
  };
  return { error, setError, intento, fallar };
}

/**
 * Pide el PIN de un supervisor y devuelve un token de autorización de un solo uso.
 * Solo funciona en un dispositivo de caja registrado.
 */
export function AutorizacionDialogo({ accion, alAutorizar, alCerrar }: { accion: AccionAutorizable; alAutorizar: (token: string) => void; alCerrar: () => void }) {
  const { sesion } = useSesion();
  const { data: usuarios = [] } = useQuery({ queryKey: ['pin-usuarios'], queryFn: () => pedir<UsuarioPin[]>('/auth/pin/usuarios'), enabled: Boolean(sesion?.dispositivo) });
  const supervisores = usuarios.filter((u) => u.rol === 'admin' || u.rol === 'supervisor');
  const [elegido, setElegido] = useState<number | null>(null);
  const [enviando, setEnviando] = useState(false);
  const pin = usePin();

  const autorizar = async (valor: string) => {
    if (!elegido) return;
    setEnviando(true);
    pin.setError(null);
    try {
      const r = await pedir<{ autorizacionToken: string }>('/auth/pin/autorizar', { cuerpo: { usuarioId: elegido, pin: valor, accion } });
      alAutorizar(r.autorizacionToken);
    } catch (err) {
      pin.fallar(err);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialogo titulo="Autorización de supervisor" abierto alCerrar={alCerrar} pie={<Boton onClick={alCerrar}>Cancelar</Boton>}>
      <div className={ui.pila}>
        <span>Se necesita un supervisor para {TEXTO_ACCION[accion]}.</span>
        {!sesion?.dispositivo ? (
          <Franja tono="aviso">El PIN solo funciona en una caja registrada (Configuración → Dispositivos de caja). Pide a un supervisor que realice la acción con su usuario.</Franja>
        ) : supervisores.length === 0 ? (
          <Franja tono="aviso">No hay supervisores con PIN en esta sucursal.</Franja>
        ) : (
          <>
            <ElegirUsuario usuarios={supervisores} elegido={elegido} alElegir={(id) => (setElegido(id), pin.setError(null))} />
            {elegido && <TecladoPin alCompletar={autorizar} deshabilitado={enviando} error={pin.intento} mensaje={pin.error} textoEntrar="Autorizar" />}
          </>
        )}
      </div>
    </Dialogo>
  );
}

/** Cambia el cajero activo del dispositivo con su PIN, sin cerrar la sesión. */
export function CambiarCajeroDialogo({ alCerrar }: { alCerrar: () => void }) {
  const { sesion, fijar } = useSesion();
  const { data: usuarios = [] } = useQuery({ queryKey: ['pin-usuarios'], queryFn: () => pedir<UsuarioPin[]>('/auth/pin/usuarios'), enabled: Boolean(sesion?.dispositivo) });
  const [elegido, setElegido] = useState<number | null>(null);
  const [enviando, setEnviando] = useState(false);
  const pin = usePin();

  const cambiar = async (valor: string) => {
    if (!elegido) return;
    setEnviando(true);
    try {
      fijar(await pedir<SesionDto>('/auth/pin/cambiar-operador', { cuerpo: { usuarioId: elegido, pin: valor } }));
      alCerrar();
    } catch (err) {
      pin.fallar(err);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialogo titulo="Cambiar cajero" abierto alCerrar={alCerrar} pie={<Boton onClick={alCerrar}>Cancelar</Boton>}>
      <div className={ui.pila}>
        {!sesion?.dispositivo ? (
          <Franja tono="aviso">Este navegador no es una caja registrada.</Franja>
        ) : (
          <>
            <ElegirUsuario usuarios={usuarios.filter((u) => u.id !== sesion.operador.id)} elegido={elegido} alElegir={(id) => (setElegido(id), pin.setError(null))} />
            {elegido && <TecladoPin alCompletar={cambiar} deshabilitado={enviando} error={pin.intento} mensaje={pin.error} />}
          </>
        )}
      </div>
    </Dialogo>
  );
}
