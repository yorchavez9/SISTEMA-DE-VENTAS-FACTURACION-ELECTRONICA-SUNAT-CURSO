import {
  conductorSchema, transportistaSchema, vehiculoSchema, type ConductorDto, type TransportistaDto, type VehiculoDto,
} from '@sv/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { Boton, Campo, Casilla, Chip, Dialogo, Selector, Tabla, ui, useToast } from '../../components/ui';
import { useFormulario } from '../../lib/formulario';
import { mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';

export const useTransportistas = () => useQuery({ queryKey: ['transportistas'], queryFn: () => pedir<TransportistaDto[]>('/transportistas') });
export const useVehiculos = () => useQuery({ queryKey: ['vehiculos'], queryFn: () => pedir<VehiculoDto[]>('/vehiculos') });
export const useConductores = () => useQuery({ queryKey: ['conductores'], queryFn: () => pedir<ConductorDto[]>('/conductores') });

const estado = (activo: boolean) => <Chip tono={activo ? 'ok' : 'neutro'}>{activo ? 'Activo' : 'Inactivo'}</Chip>;

/** Transportistas, vehículos y conductores que se usan en las guías de remisión. */
export function MaestrosTransporte() {
  const { puede } = useSesion();
  const editable = puede('guias.maestros');
  const { data: transportistas = [] } = useTransportistas();
  const { data: vehiculos = [] } = useVehiculos();
  const { data: conductores = [] } = useConductores();
  const [editando, setEditando] = useState<
    { tipo: 'transportista'; fila: TransportistaDto | null } | { tipo: 'vehiculo'; fila: VehiculoDto | null } | { tipo: 'conductor'; fila: ConductorDto | null } | null
  >(null);
  const editar = (onClick: () => void) => (editable ? <div className={ui.acciones}><Boton chico icono={Pencil} onClick={onClick}>Editar</Boton></div> : null);

  return (
    <div className={ui.pila}>
      <section className={ui.pila}>
        <div className={ui.acciones} style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Transportistas <span className="muted">(transporte público)</span></h3>
          {editable && <Boton icono={Plus} onClick={() => setEditando({ tipo: 'transportista', fila: null })}>Nuevo transportista</Boton>}
        </div>
        <Tabla
          filas={transportistas}
          clave={(t) => t.id}
          vacio="Aún no hay transportistas."
          columnas={[
            { titulo: 'Razón social', celda: (t) => <>{t.razonSocial}<span className={`${ui.sub} font-id`}>RUC {t.ruc}</span></> },
            { titulo: 'Registro MTC', celda: (t) => t.nroMtc ?? '—' },
            { titulo: 'Estado', celda: (t) => estado(t.activo) },
            { titulo: '', celda: (t) => editar(() => setEditando({ tipo: 'transportista', fila: t })) },
          ]}
        />
      </section>
      <section className={ui.pila}>
        <div className={ui.acciones} style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Vehículos <span className="muted">(transporte privado)</span></h3>
          {editable && <Boton icono={Plus} onClick={() => setEditando({ tipo: 'vehiculo', fila: null })}>Nuevo vehículo</Boton>}
        </div>
        <Tabla
          filas={vehiculos}
          clave={(v) => v.id}
          vacio="Aún no hay vehículos."
          columnas={[
            { titulo: 'Placa', celda: (v) => <strong className="font-id">{v.placa}</strong> },
            { titulo: 'Descripción', celda: (v) => v.descripcion ?? '—' },
            { titulo: 'Cert. circulación', celda: (v) => v.nroCirculacion ?? '—' },
            { titulo: 'Estado', celda: (v) => estado(v.activo) },
            { titulo: '', celda: (v) => editar(() => setEditando({ tipo: 'vehiculo', fila: v })) },
          ]}
        />
      </section>
      <section className={ui.pila}>
        <div className={ui.acciones} style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Conductores <span className="muted">(transporte privado)</span></h3>
          {editable && <Boton icono={Plus} onClick={() => setEditando({ tipo: 'conductor', fila: null })}>Nuevo conductor</Boton>}
        </div>
        <Tabla
          filas={conductores}
          clave={(c) => c.id}
          vacio="Aún no hay conductores."
          columnas={[
            { titulo: 'Conductor', celda: (c) => <>{c.nombres} {c.apellidos}<span className={`${ui.sub} font-id`}>{c.numDoc}</span></> },
            { titulo: 'Licencia', celda: (c) => <span className="font-id">{c.licencia}</span> },
            { titulo: 'Estado', celda: (c) => estado(c.activo) },
            { titulo: '', celda: (c) => editar(() => setEditando({ tipo: 'conductor', fila: c })) },
          ]}
        />
      </section>
      {editando?.tipo === 'transportista' && <TransportistaDialogo fila={editando.fila} alCerrar={() => setEditando(null)} />}
      {editando?.tipo === 'vehiculo' && <VehiculoDialogo fila={editando.fila} alCerrar={() => setEditando(null)} />}
      {editando?.tipo === 'conductor' && <ConductorDialogo fila={editando.fila} alCerrar={() => setEditando(null)} />}
    </div>
  );
}

/** Guarda con POST (nuevo) o PUT (edición) y refresca la lista. */
function useGuardar(recurso: 'transportistas' | 'vehiculos' | 'conductores', id: number | undefined, alCerrar: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  return async (enviar: (fn: () => Promise<void>) => Promise<boolean>, datos: unknown) => {
    try {
      await enviar(async () => {
        await pedir(id ? `/${recurso}/${id}` : `/${recurso}`, { method: id ? 'PUT' : 'POST', cuerpo: datos });
      });
      await qc.invalidateQueries({ queryKey: [recurso] });
      toast('Guardado', 'ok');
      alCerrar();
    } catch (err) {
      toast(mensajeError(err), 'error');
    }
  };
}

function TransportistaDialogo({ fila, alCerrar }: { fila: TransportistaDto | null; alCerrar: () => void }) {
  const f = useFormulario({ ruc: fila?.ruc ?? '', razonSocial: fila?.razonSocial ?? '', nroMtc: fila?.nroMtc ?? '', activo: fila?.activo ?? true });
  const guardar = useGuardar('transportistas', fila?.id, alCerrar);
  const enviar = () => {
    const d = f.validar(transportistaSchema);
    if (d) void guardar(f.enviar, d);
  };
  return (
    <Dialogo titulo={fila ? 'Editar transportista' : 'Nuevo transportista'} abierto alCerrar={alCerrar} pie={<><Boton onClick={alCerrar}>Cancelar</Boton><Boton variante="primario" onClick={enviar} cargando={f.enviando}>Guardar</Boton></>}>
      <div className={ui.form}>
        <Campo etiqueta="RUC" ancho="mitad" inputMode="numeric" maxLength={11} {...f.texto('ruc')} />
        <Campo etiqueta="N.º de registro MTC" ancho="mitad" opcional {...f.texto('nroMtc')} />
        <Campo etiqueta="Razón social" {...f.texto('razonSocial')} />
        <Casilla etiqueta="Activo" checked={f.valores.activo} onChange={(e) => f.fijar('activo', e.target.checked)} />
      </div>
    </Dialogo>
  );
}

function VehiculoDialogo({ fila, alCerrar }: { fila: VehiculoDto | null; alCerrar: () => void }) {
  const f = useFormulario({ placa: fila?.placa ?? '', nroCirculacion: fila?.nroCirculacion ?? '', descripcion: fila?.descripcion ?? '', activo: fila?.activo ?? true });
  const guardar = useGuardar('vehiculos', fila?.id, alCerrar);
  const enviar = () => {
    const d = f.validar(vehiculoSchema);
    if (d) void guardar(f.enviar, d);
  };
  return (
    <Dialogo titulo={fila ? 'Editar vehículo' : 'Nuevo vehículo'} abierto alCerrar={alCerrar} pie={<><Boton onClick={alCerrar}>Cancelar</Boton><Boton variante="primario" onClick={enviar} cargando={f.enviando}>Guardar</Boton></>}>
      <div className={ui.form}>
        <Campo etiqueta="Placa" ancho="mitad" ayuda="Sin guion, p. ej. ABC123" {...f.texto('placa')} />
        <Campo etiqueta="Certificado de circulación" ancho="mitad" opcional {...f.texto('nroCirculacion')} />
        <Campo etiqueta="Descripción" opcional placeholder="Furgón, camión…" {...f.texto('descripcion')} />
        <Casilla etiqueta="Activo" checked={f.valores.activo} onChange={(e) => f.fijar('activo', e.target.checked)} />
      </div>
    </Dialogo>
  );
}

function ConductorDialogo({ fila, alCerrar }: { fila: ConductorDto | null; alCerrar: () => void }) {
  const f = useFormulario({ tipoDoc: fila?.tipoDoc ?? '1', numDoc: fila?.numDoc ?? '', nombres: fila?.nombres ?? '', apellidos: fila?.apellidos ?? '', licencia: fila?.licencia ?? '', activo: fila?.activo ?? true });
  const guardar = useGuardar('conductores', fila?.id, alCerrar);
  const enviar = () => {
    const d = f.validar(conductorSchema);
    if (d) void guardar(f.enviar, d);
  };
  return (
    <Dialogo titulo={fila ? 'Editar conductor' : 'Nuevo conductor'} abierto alCerrar={alCerrar} pie={<><Boton onClick={alCerrar}>Cancelar</Boton><Boton variante="primario" onClick={enviar} cargando={f.enviando}>Guardar</Boton></>}>
      <div className={ui.form}>
        <Selector etiqueta="Documento" ancho="cuarto" value={f.valores.tipoDoc} onChange={(e) => f.fijar('tipoDoc', e.target.value)} opciones={[{ valor: '1', texto: 'DNI' }, { valor: '4', texto: 'Carné de extranjería' }, { valor: '7', texto: 'Pasaporte' }]} />
        <Campo etiqueta="Número" ancho="cuarto" {...f.texto('numDoc')} />
        <Campo etiqueta="Licencia de conducir" ancho="mitad" {...f.texto('licencia')} />
        <Campo etiqueta="Nombres" ancho="mitad" {...f.texto('nombres')} />
        <Campo etiqueta="Apellidos" ancho="mitad" {...f.texto('apellidos')} />
        <Casilla etiqueta="Activo" checked={f.valores.activo} onChange={(e) => f.fijar('activo', e.target.checked)} />
      </div>
    </Dialogo>
  );
}
