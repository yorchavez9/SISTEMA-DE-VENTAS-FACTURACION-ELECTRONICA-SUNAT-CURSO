import { instalacionSchema, loginSchema, type EstadoInstalacionDto, type SesionDto, type UsuarioIngresoDto } from '@sv/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, MonitorSmartphone, Moon, ShieldCheck, Store, Sun } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Boton, Campo, Franja, TecladoPin, ui } from '../../components/ui';
import { useFormulario } from '../../lib/formulario';
import { ErrorHttp, mensajeError, pedir } from '../../lib/http';
import { nombreRol } from '../../lib/roles';
import { tokenDispositivo, useSesion } from '../../lib/sesion';
import { useTema } from '../../lib/tema';
import css from './auth.module.css';

// Ingreso como ferretería: "¿Quién va a trabajar?" → se elige el usuario de la lista y se escribe
// su PIN. Quien no tiene PIN (o el primer administrador) entra con usuario y contraseña.

const NEGOCIO = 'CMA STORE';
const fechaLarga = () => {
  const t = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Mensaje de un fallo de PIN o contraseña (incorrecto, intentos restantes, bloqueo). */
function mensajeFallo(err: unknown): string {
  if (err instanceof ErrorHttp && err.codigo === 'BLOQUEADO') {
    const hasta = (err.cuerpo.detalle as { hasta?: string } | undefined)?.hasta;
    return `Bloqueado por intentos fallidos${hasta ? ` hasta las ${new Date(hasta).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}` : ''}.`;
  }
  if (err instanceof ErrorHttp && err.codigo === 'PIN_INVALIDO') {
    const restantes = (err.cuerpo.detalle as { intentosRestantes?: number } | undefined)?.intentosRestantes;
    return `PIN incorrecto${restantes !== undefined && restantes > 0 ? `. Te quedan ${restantes} intentos.` : '.'}`;
  }
  return mensajeError(err);
}

/** Armazón del ingreso: marca y fecha arriba, el panel y el botón de tema abajo. */
function Ingreso({ children }: { children: ReactNode }) {
  const { oscuro, alternar } = useTema();
  const dispositivo = tokenDispositivo();
  return (
    <div className={css.fondo}>
      <div className={css.tarjeta}>
        <div>
          <div className={css.marcaFila}>
            <span className={css.logo}>
              <Store aria-hidden />
            </span>
            <p className={css.nombre}>{NEGOCIO}</p>
          </div>
          <p className={css.fecha}>{fechaLarga()}</p>
        </div>
        <div>{children}</div>
        {dispositivo && (
          <span className={css.dispositivo}>
            <MonitorSmartphone className="inline size-3.5 align-[-2px]" aria-hidden /> Este navegador es una caja registrada
          </span>
        )}
        <Button variant="ghost" size="icon" className="justify-self-center" onClick={alternar} aria-label={oscuro ? 'Usar tema claro' : 'Usar tema oscuro'} title={oscuro ? 'Usar tema claro' : 'Usar tema oscuro'}>
          {oscuro ? <Sun /> : <Moon />}
        </Button>
      </div>
    </div>
  );
}

function Volver({ alHacer, texto }: { alHacer: () => void; texto: string }) {
  return (
    <Button variant="link" className={css.volver} onClick={alHacer}>
      <ChevronLeft className="size-4" aria-hidden />
      <span>{texto}</span>
    </Button>
  );
}

export function LoginPage() {
  const { sesion, fijar } = useSesion();
  const navegar = useNavigate();
  const destino = (useLocation().state as { desde?: string } | null)?.desde ?? '/';
  const dispositivo = tokenDispositivo();
  const { data: instalacion } = useQuery({ queryKey: ['instalacion'], queryFn: () => pedir<EstadoInstalacionDto>('/auth/instalacion'), enabled: !sesion, staleTime: Infinity });
  const { data: usuarios, isLoading } = useQuery({
    queryKey: ['ingreso-usuarios', dispositivo],
    queryFn: () => pedir<UsuarioIngresoDto[]>(`/auth/ingreso/usuarios${dispositivo ? `?dispositivo=${encodeURIComponent(dispositivo)}` : ''}`),
    enabled: !sesion && instalacion?.pendiente === false,
  });
  const [elegido, setElegido] = useState<UsuarioIngresoDto | null>(null);
  const [conClave, setConClave] = useState(false);
  const [fallo, setFallo] = useState<{ n: number; texto: string | null }>({ n: 0, texto: null });
  const [entrando, setEntrando] = useState(false);

  if (sesion) return <Navigate to={sesion.debeCambiarPassword ? '/cambiar-password' : destino} replace />;
  if (instalacion?.pendiente) return <ConfiguracionInicial requiereCodigo={instalacion.requiereCodigo} />;

  const entrar = (s: SesionDto) => {
    fijar(s);
    navegar(s.debeCambiarPassword ? '/cambiar-password' : destino, { replace: true });
  };

  const entrarConPin = async (pin: string) => {
    if (!elegido) return;
    setEntrando(true);
    try {
      entrar(await pedir<SesionDto>('/auth/ingreso/pin', { cuerpo: { usuarioId: elegido.id, pin, dispositivoToken: dispositivo ?? undefined } }));
    } catch (err) {
      setFallo((f) => ({ n: f.n + 1, texto: mensajeFallo(err) }));
    } finally {
      setEntrando(false);
    }
  };

  // Nadie tiene PIN todavía (p. ej. recién instalado): se entra con contraseña.
  const sinLista = !isLoading && (usuarios?.length ?? 0) === 0;

  if (conClave || sinLista) {
    return (
      <Ingreso>
        {!sinLista && <Volver alHacer={() => setConClave(false)} texto="Elegir otro usuario" />}
        <ConContrasena alEntrar={entrar} dispositivo={dispositivo} />
      </Ingreso>
    );
  }

  if (elegido) {
    return (
      <Ingreso>
        <Volver alHacer={() => (setElegido(null), setFallo({ n: 0, texto: null }))} texto="Elegir otro usuario" />
        <h2 className={css.titulo}>Hola, {elegido.nombre}</h2>
        <p className={css.ayuda}>Ingresa tu PIN.</p>
        <TecladoPin alCompletar={(pin) => void entrarConPin(pin)} deshabilitado={entrando} error={fallo.n} mensaje={fallo.texto} />
      </Ingreso>
    );
  }

  return (
    <Ingreso>
      <h2 className={css.titulo}>¿Quién va a trabajar?</h2>
      <p className={css.ayuda}>Elige tu usuario e ingresa tu PIN.</p>
      <div className={css.usuarios}>
        {(usuarios ?? []).map((u) => (
          <Button key={u.id} variant="ghost" className={css.usuario} onClick={() => setElegido(u)}>
            <span className={css.inicial} aria-hidden>
              {u.nombre.charAt(0).toUpperCase()}
            </span>
            <span className={css.usuarioNombre}>{u.nombre}</span>
            <span className={css.usuarioRol}>{nombreRol(u.rol)}</span>
            <ChevronRight className={css.flecha} aria-hidden />
          </Button>
        ))}
      </div>
      <Button variant="link" className={css.enlace} onClick={() => setConClave(true)}>
        Entrar con usuario y contraseña
      </Button>
    </Ingreso>
  );
}

/** Ingreso con usuario y contraseña (administración, o usuarios sin PIN). */
function ConContrasena({ alEntrar, dispositivo }: { alEntrar: (s: SesionDto) => void; dispositivo: string | null }) {
  const f = useFormulario({ usuario: '', password: '' });
  const [error, setError] = useState<string | null>(null);

  const alEnviar = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const datos = f.validar(loginSchema, { ...f.valores, dispositivoToken: dispositivo ?? undefined });
    if (!datos) return;
    try {
      await f.enviar(async () => alEntrar(await pedir<SesionDto>('/auth/login', { cuerpo: datos })));
    } catch (err) {
      setError(mensajeFallo(err));
      f.fijar('password', '');
    }
  };

  return (
    <form onSubmit={alEnviar} noValidate className="grid gap-4">
      <div>
        <h2 className={css.titulo}>Entrar con contraseña</h2>
        <p className={css.ayuda}>Escribe tu usuario y tu contraseña.</p>
      </div>
      {error && <Franja tono="alerta">{error}</Franja>}
      <div className={ui.form}>
        <Campo etiqueta="Usuario" autoComplete="username" autoCapitalize="none" autoFocus {...f.texto('usuario')} />
        <Campo etiqueta="Contraseña" type="password" autoComplete="current-password" {...f.texto('password')} />
      </div>
      <Boton variante="primario" type="submit" cargando={f.enviando}>
        Ingresar
      </Boton>
    </form>
  );
}

/** Primera vez: no hay usuarios. Se registra el super administrador y se entra directo. */
function ConfiguracionInicial({ requiereCodigo }: { requiereCodigo: boolean }) {
  const { fijar } = useSesion();
  const navegar = useNavigate();
  const f = useFormulario({ nombre: '', usuario: '', password: '', repetir: '', codigo: '' });
  const [error, setError] = useState<string | null>(null);

  const alEnviar = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const datos = f.validar(instalacionSchema, { ...f.valores, codigo: requiereCodigo ? f.valores.codigo : undefined });
    if (!datos) return;
    try {
      await f.enviar(async () => {
        const s = await pedir<SesionDto>('/auth/instalacion', { cuerpo: datos });
        fijar(s);
        navegar('/configuracion', { replace: true });
      });
    } catch (err) {
      setError(err instanceof ErrorHttp && err.codigo === 'YA_INSTALADO' ? 'El sistema ya tiene un administrador: recarga la página e inicia sesión.' : mensajeError(err));
    }
  };

  return (
    <Ingreso>
      <form onSubmit={alEnviar} noValidate className="grid gap-4">
        <div>
          <h2 className={`${css.titulo} flex items-center gap-2`}>
            <ShieldCheck className="size-4 text-primary" aria-hidden /> Configuración inicial
          </h2>
          <p className={css.ayuda}>Crea la cuenta del super administrador. Solo se puede hacer una vez.</p>
        </div>
        {error && <Franja tono="alerta">{error}</Franja>}
        <div className={ui.form}>
          <Campo etiqueta="Nombre completo" autoComplete="name" autoFocus {...f.texto('nombre')} />
          <Campo etiqueta="Usuario" autoComplete="username" autoCapitalize="none" ayuda="Con este nombre vas a ingresar" {...f.texto('usuario')} />
          <Campo etiqueta="Contraseña" type="password" autoComplete="new-password" ayuda="Mínimo 8 caracteres, con letras y números" {...f.texto('password')} />
          <Campo etiqueta="Repetir contraseña" type="password" autoComplete="new-password" {...f.texto('repetir')} />
          {requiereCodigo && <Campo etiqueta="Código de instalación" autoComplete="off" ayuda="Está en el log de la api (ventas-api) al iniciar" {...f.texto('codigo')} />}
        </div>
        <Boton variante="primario" type="submit" cargando={f.enviando}>
          Crear administrador e ingresar
        </Boton>
      </form>
    </Ingreso>
  );
}
