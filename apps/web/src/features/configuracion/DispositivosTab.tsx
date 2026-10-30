import { crearDispositivoSchema, type SucursalDto } from '@sv/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MonitorSmartphone, Plus } from 'lucide-react';
import { useState } from 'react';
import { Boton, Campo, Casilla, Chip, Dialogo, Franja, Selector, Tabla, ui, useToast } from '../../components/ui';
import { useFormulario } from '../../lib/formulario';
import { mensajeError, pedir } from '../../lib/http';
import { guardarTokenDispositivo, tokenDispositivo, useSesion } from '../../lib/sesion';

interface Dispositivo {
  id: number;
  nombre: string;
  activo: boolean;
  ultimoUso: string | null;
  sucursalId: number;
  sucursal: string;
}

export function DispositivosTab() {
  const { puede, sesion } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const editable = puede('config.editar');
  const [nuevo, setNuevo] = useState(false);
  const { data: dispositivos = [] } = useQuery({ queryKey: ['dispositivos'], queryFn: () => pedir<Dispositivo[]>('/dispositivos') });
  const registrado = Boolean(tokenDispositivo());

  const desactivar = async (d: Dispositivo) => {
    try {
      await pedir(`/dispositivos/${d.id}`, { method: 'DELETE' });
      if (sesion?.dispositivo?.id === d.id) guardarTokenDispositivo(null);
      await qc.invalidateQueries({ queryKey: ['dispositivos'] });
      toast(`${d.nombre} desactivado`, 'ok');
    } catch (err) {
      toast(mensajeError(err), 'error');
    }
  };

  return (
    <div className={ui.pila}>
      <Franja>
        Un dispositivo de caja es un navegador autorizado para usar PIN (cambio rápido de cajero y autorizaciones de supervisor).
        {registrado ? ' Este navegador está registrado como caja.' : ' Este navegador no está registrado.'}
      </Franja>
      {registrado && (
        <div>
          <Boton
            variante="plano"
            onClick={() => {
              guardarTokenDispositivo(null);
              toast('Este navegador dejó de ser una caja. Vuelve a ingresar para que se aplique.', 'ok');
              qc.invalidateQueries({ queryKey: ['dispositivos'] });
            }}
          >
            Quitar el registro de este navegador
          </Boton>
        </div>
      )}
      <div className={ui.encabezado}>
        <span />
        {editable && (
          <Boton variante="primario" icono={Plus} onClick={() => setNuevo(true)}>
            Registrar dispositivo
          </Boton>
        )}
      </div>
      <Tabla
        filas={dispositivos}
        clave={(d) => d.id}
        vacio="No hay dispositivos de caja registrados."
        columnas={[
          { titulo: 'Dispositivo', celda: (d) => <>{d.nombre}{sesion?.dispositivo?.id === d.id && <span className={ui.sub}>este navegador</span>}</> },
          { titulo: 'Sucursal', celda: (d) => d.sucursal },
          { titulo: 'Último uso', celda: (d) => (d.ultimoUso ? new Date(d.ultimoUso).toLocaleString('es-PE') : 'Nunca') },
          { titulo: 'Estado', celda: (d) => (d.activo ? <Chip tono="ok">Activo</Chip> : <Chip>Inactivo</Chip>) },
          {
            titulo: '',
            celda: (d) =>
              editable && d.activo && (
                <div className={ui.acciones}>
                  <Boton chico variante="plano" onClick={() => void desactivar(d)}>
                    Desactivar
                  </Boton>
                </div>
              ),
          },
        ]}
      />
      {nuevo && <NuevoDispositivo alCerrar={() => setNuevo(false)} />}
    </div>
  );
}

function NuevoDispositivo({ alCerrar }: { alCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: sucursales = [] } = useQuery({ queryKey: ['sucursales'], queryFn: () => pedir<SucursalDto[]>('/sucursales') });
  const f = useFormulario({ nombre: 'Caja 1', sucursalId: sucursales[0]?.id ?? 0, esteNavegador: true });

  const guardar = async () => {
    const datos = f.validar(crearDispositivoSchema, { ...f.valores, sucursalId: f.valores.sucursalId || sucursales[0]?.id });
    if (!datos) return;
    try {
      await f.enviar(async () => {
        const r = await pedir<{ dispositivoToken: string }>('/dispositivos', { cuerpo: datos });
        if (f.valores.esteNavegador) guardarTokenDispositivo(r.dispositivoToken);
        await qc.invalidateQueries({ queryKey: ['dispositivos'] });
      });
      toast(f.valores.esteNavegador ? 'Registrado. Cierra sesión y vuelve a ingresar en este navegador para activar el PIN.' : 'Dispositivo registrado', 'ok');
      alCerrar();
    } catch (err) {
      toast(mensajeError(err), 'error');
    }
  };

  return (
    <Dialogo
      titulo="Registrar dispositivo de caja"
      abierto
      alCerrar={alCerrar}
      pie={
        <>
          <Boton onClick={alCerrar}>Cancelar</Boton>
          <Boton variante="primario" icono={MonitorSmartphone} onClick={guardar} cargando={f.enviando}>
            Registrar
          </Boton>
        </>
      }
    >
      <div className={ui.pila}>
        <div className={ui.form}>
          <Campo etiqueta="Nombre" ancho="mitad" {...f.texto('nombre')} />
          <Selector
            etiqueta="Sucursal"
            ancho="mitad"
            value={String(f.valores.sucursalId || sucursales[0]?.id || '')}
            onChange={(e) => f.fijar('sucursalId', Number(e.target.value))}
            opciones={sucursales.filter((s) => s.activo).map((s) => ({ valor: String(s.id), texto: s.nombre }))}
            error={f.errores.sucursalId}
          />
        </div>
        <Casilla etiqueta="Registrar este navegador como esta caja" checked={f.valores.esteNavegador} onChange={(e) => f.fijar('esteNavegador', e.target.checked)} />
        <Franja tono="aviso">El código del dispositivo se guarda solo en el navegador elegido y no se vuelve a mostrar. Para otra computadora, regístrala desde esa computadora.</Franja>
      </div>
    </Dialogo>
  );
}
