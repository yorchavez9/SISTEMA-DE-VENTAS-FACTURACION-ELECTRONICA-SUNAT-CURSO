import { crearUsuarioSchema, editarUsuarioSchema, ROLES, type Pagina, type Rol, type SucursalDto, type UsuarioDto } from '@sv/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { Boton, Campo, Casilla, Chip, Dialogo, Franja, Selector, Tabla, ui, useToast } from '../../components/ui';
import { useFormulario } from '../../lib/formulario';
import { mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';

export const NOMBRE_ROL: Record<Rol, string> = { admin: 'Administrador', supervisor: 'Supervisor', cajero: 'Cajero', almacen: 'Almacén' };

export function UsuariosTab() {
  const { puede } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const editable = puede('usuarios.editar');
  const [buscar, setBuscar] = useState('');
  const [editando, setEditando] = useState<UsuarioDto | 'nuevo' | null>(null);
  const [temporal, setTemporal] = useState<{ usuario: string; password: string } | null>(null);

  const { data } = useQuery({
    queryKey: ['usuarios', buscar],
    queryFn: () => pedir<Pagina<UsuarioDto>>(`/usuarios?pageSize=100${buscar ? `&q=${encodeURIComponent(buscar)}` : ''}`),
  });
  const { data: sucursales = [] } = useQuery({ queryKey: ['sucursales'], queryFn: () => pedir<SucursalDto[]>('/sucursales') });
  const nombreSucursal = new Map(sucursales.map((s) => [s.id, s.nombre]));

  const accion = async (u: UsuarioDto, que: 'password' | 'pin') => {
    try {
      if (que === 'password') {
        const r = await pedir<{ passwordTemporal: string }>(`/usuarios/${u.id}/restablecer-password`, { method: 'POST' });
        setTemporal({ usuario: u.usuario, password: r.passwordTemporal });
      } else {
        await pedir(`/usuarios/${u.id}/restablecer-pin`, { method: 'POST' });
        toast(`PIN de ${u.nombre} eliminado: deberá crear uno nuevo`, 'ok');
      }
      await qc.invalidateQueries({ queryKey: ['usuarios'] });
    } catch (err) {
      toast(mensajeError(err), 'error');
    }
  };

  return (
    <div className={ui.pila}>
      <div className={ui.encabezado}>
        <Input style={{ maxWidth: '20rem' }} placeholder="Buscar por nombre o usuario" value={buscar} onChange={(e) => setBuscar(e.target.value)} aria-label="Buscar usuarios" />
        {editable && (
          <Boton variante="primario" icono={Plus} onClick={() => setEditando('nuevo')}>
            Nuevo usuario
          </Boton>
        )}
      </div>
      <Tabla
        filas={data?.data ?? []}
        clave={(u) => u.id}
        columnas={[
          { titulo: 'Usuario', celda: (u) => <>{u.nombre}<span className={`${ui.sub} font-id`}>{u.usuario}</span></> },
          { titulo: 'Rol', celda: (u) => NOMBRE_ROL[u.rol] },
          { titulo: 'Sucursales', celda: (u) => (u.rol === 'admin' ? 'Todas' : u.sucursalIds.map((id) => nombreSucursal.get(id) ?? id).join(', ')) },
          { titulo: 'PIN', celda: (u) => (u.tienePin ? <Chip tono="ok">Sí</Chip> : <Chip>No</Chip>) },
          { titulo: 'Estado', celda: (u) => (!u.activo ? <Chip>Inactivo</Chip> : u.bloqueado ? <Chip tono="alerta">Bloqueado</Chip> : <Chip tono="ok">Activo</Chip>) },
          {
            titulo: '',
            celda: (u) =>
              editable && (
                <div className={ui.acciones}>
                  <Boton chico icono={Pencil} onClick={() => setEditando(u)}>
                    Editar
                  </Boton>
                  <Boton chico onClick={() => void accion(u, 'password')}>
                    Nueva contraseña
                  </Boton>
                  {u.tienePin && (
                    <Boton chico variante="plano" onClick={() => void accion(u, 'pin')}>
                      Quitar PIN
                    </Boton>
                  )}
                </div>
              ),
          },
        ]}
      />
      {editando && (
        <UsuarioDialogo
          usuario={editando === 'nuevo' ? null : editando}
          sucursales={sucursales}
          alCerrar={() => setEditando(null)}
          alCrear={(usuario, password) => setTemporal({ usuario, password })}
        />
      )}
      {temporal && (
        <Dialogo titulo="Contraseña temporal" abierto alCerrar={() => setTemporal(null)} fijo pie={<Boton variante="primario" onClick={() => setTemporal(null)}>Ya la anoté</Boton>}>
          <div className={ui.pila}>
            <span>
              Entrega esta contraseña a <strong>{temporal.usuario}</strong>. Se muestra una sola vez y deberá cambiarla al ingresar.
            </span>
            <Card className="gap-3 font-id" style={{ fontSize: '1.25rem', textAlign: 'center', letterSpacing: '0.05em' }}>
              {temporal.password}
            </Card>
          </div>
        </Dialogo>
      )}
    </div>
  );
}

function UsuarioDialogo({
  usuario, sucursales, alCerrar, alCrear,
}: { usuario: UsuarioDto | null; sucursales: SucursalDto[]; alCerrar: () => void; alCrear: (usuario: string, password: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const f = useFormulario({
    usuario: usuario?.usuario ?? '',
    nombre: usuario?.nombre ?? '',
    email: usuario?.email ?? '',
    rol: (usuario?.rol ?? 'cajero') as Rol,
    sucursalIds: usuario?.sucursalIds ?? (sucursales.length === 1 ? [sucursales[0]!.id] : []),
    activo: usuario?.activo ?? true,
  });

  const alternarSucursal = (id: number) =>
    f.fijar('sucursalIds', f.valores.sucursalIds.includes(id) ? f.valores.sucursalIds.filter((x) => x !== id) : [...f.valores.sucursalIds, id]);

  const guardar = async () => {
    const datos = usuario ? f.validar(editarUsuarioSchema) : f.validar(crearUsuarioSchema);
    if (!datos) return;
    try {
      await f.enviar(async () => {
        if (usuario) {
          await pedir(`/usuarios/${usuario.id}`, { method: 'PUT', cuerpo: datos });
          toast('Usuario actualizado', 'ok');
        } else {
          const r = await pedir<{ usuario: UsuarioDto; passwordTemporal: string }>('/usuarios', { cuerpo: datos });
          alCrear(r.usuario.usuario, r.passwordTemporal);
        }
        await qc.invalidateQueries({ queryKey: ['usuarios'] });
      });
      alCerrar();
    } catch (err) {
      toast(mensajeError(err), 'error');
    }
  };

  return (
    <Dialogo
      titulo={usuario ? `Editar ${usuario.nombre}` : 'Nuevo usuario'}
      abierto
      alCerrar={alCerrar}
      pie={
        <>
          <Boton onClick={alCerrar}>Cancelar</Boton>
          <Boton variante="primario" onClick={guardar} cargando={f.enviando}>
            Guardar
          </Boton>
        </>
      }
    >
      <div className={ui.pila}>
        <div className={ui.form}>
          <Campo etiqueta="Usuario" className="font-id" autoCapitalize="none" disabled={Boolean(usuario)} ancho="mitad" {...f.texto('usuario')} />
          <Selector etiqueta="Rol" ancho="mitad" value={f.valores.rol} onChange={(e) => f.fijar('rol', e.target.value as Rol)} opciones={ROLES.map((r) => ({ valor: r, texto: NOMBRE_ROL[r] }))} />
          <Campo etiqueta="Nombre completo" {...f.texto('nombre')} />
          <Campo etiqueta="Email" type="email" opcional {...f.texto('email')} />
        </div>
        <div>
          <div style={{ marginBottom: '0.375rem' }}>Sucursales</div>
          {sucursales.length === 0 && <Franja tono="aviso">Crea primero una sucursal.</Franja>}
          {sucursales.map((s) => (
            <Casilla key={s.id} etiqueta={s.nombre} checked={f.valores.sucursalIds.includes(s.id)} onChange={() => alternarSucursal(s.id)} />
          ))}
          {f.errores.sucursalIds && <span className={ui.error}>{f.errores.sucursalIds}</span>}
          {f.valores.rol === 'admin' && <span className={ui.ayuda}>El administrador accede a todas las sucursales.</span>}
        </div>
        {usuario && <Casilla etiqueta="Usuario activo" checked={f.valores.activo} onChange={(e) => f.fijar('activo', e.target.checked)} />}
        {!usuario && <Franja>Se generará una contraseña temporal que deberá cambiar al ingresar.</Franja>}
      </div>
    </Dialogo>
  );
}
