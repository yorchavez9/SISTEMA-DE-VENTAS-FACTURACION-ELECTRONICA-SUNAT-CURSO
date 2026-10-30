import { crearSucursalSchema, editarSucursalSchema, type SucursalDto } from '@sv/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudDownload, Link2, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { Boton, Campo, Casilla, Chip, Dialogo, Franja, Selector, Tabla, ui, useToast } from '../../components/ui';
import { useFormulario } from '../../lib/formulario';
import { mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';

interface SucursalApi {
  id: number;
  nombre: string;
  codLocal: string;
  activo: boolean;
  vinculadaA: number | null;
}

const MODOS = [
  { valor: 'individual', texto: 'Individual (cada boleta se envía al emitirla)' },
  { valor: 'resumen', texto: 'Resumen diario (se declaran juntas al final del día)' },
];

export function SucursalesTab() {
  const { puede, sesion, fijar } = useSesion();
  const qc = useQueryClient();
  const editable = puede('sucursales.editar');
  const { data: sucursales = [] } = useQuery({ queryKey: ['sucursales'], queryFn: () => pedir<SucursalDto[]>('/sucursales') });
  const [editando, setEditando] = useState<SucursalDto | 'nueva' | null>(null);
  const [vinculando, setVinculando] = useState<SucursalDto | null>(null);
  const [importando, setImportando] = useState(false);

  const refrescar = async () => {
    await qc.invalidateQueries({ queryKey: ['sucursales'] });
    await qc.invalidateQueries({ queryKey: ['series'] });
    // La lista de sucursales de la sesión también cambia.
    const s = await pedir<NonNullable<typeof sesion>>('/auth/me');
    fijar(s);
  };

  return (
    <div className={ui.pila}>
      <div className={ui.encabezado}>
        <span className="muted">Cada sucursal del sistema se vincula con una sucursal de API-PRO; su código de local es el que se envía a SUNAT.</span>
        {editable && (
          <div className={ui.acciones}>
            <Boton icono={CloudDownload} onClick={() => setImportando(true)}>
              Importar desde API-PRO
            </Boton>
            <Boton variante="primario" icono={Plus} onClick={() => setEditando('nueva')}>
              Nueva sucursal
            </Boton>
          </div>
        )}
      </div>
      <Tabla
        filas={sucursales}
        clave={(s) => s.id}
        vacio="Aún no hay sucursales. Si ya existen en API-PRO, usa «Importar desde API-PRO»; si no, crea la primera."
        columnas={[
          { titulo: 'Sucursal', celda: (s) => <>{s.nombre}<span className={ui.sub}>{s.direccion}</span></> },
          { titulo: 'Código', celda: (s) => <span className="font-id">{s.codLocal}</span> },
          { titulo: 'API-PRO', celda: (s) => (s.apiSucursalId ? <Chip tono="ok">Vinculada (id {s.apiSucursalId})</Chip> : <Chip tono="aviso">Sin vincular</Chip>) },
          { titulo: 'Boletas', celda: (s) => (s.modoBoletas === 'resumen' ? `Resumen diario · ${s.horaResumen}` : 'Individual') },
          { titulo: 'Estado', celda: (s) => (s.activo ? <Chip tono="ok">Activa</Chip> : <Chip>Inactiva</Chip>) },
          {
            titulo: '',
            celda: (s) =>
              editable && (
                <div className={ui.acciones}>
                  {!s.apiSucursalId && (
                    <Boton chico icono={Link2} onClick={() => setVinculando(s)}>
                      Vincular
                    </Boton>
                  )}
                  <Boton chico icono={Pencil} onClick={() => setEditando(s)}>
                    Editar
                  </Boton>
                </div>
              ),
          },
        ]}
      />
      {editando && <SucursalDialogo sucursal={editando === 'nueva' ? null : editando} alCerrar={() => setEditando(null)} alGuardar={refrescar} />}
      {vinculando && <VincularDialogo sucursal={vinculando} alCerrar={() => setVinculando(null)} alGuardar={refrescar} />}
      {importando && <ImportarDialogo alCerrar={() => setImportando(false)} alImportar={refrescar} />}
    </div>
  );
}

function SucursalDialogo({ sucursal, alCerrar, alGuardar }: { sucursal: SucursalDto | null; alCerrar: () => void; alGuardar: () => Promise<void> }) {
  const toast = useToast();
  const f = useFormulario({
    nombre: sucursal?.nombre ?? '',
    codLocal: sucursal?.codLocal ?? '',
    direccion: sucursal?.direccion ?? '',
    ubigeo: sucursal?.ubigeo ?? '',
    telefono: sucursal?.telefono ?? '',
    modoBoletas: sucursal?.modoBoletas ?? 'individual',
    horaResumen: sucursal?.horaResumen ?? '23:00',
    activo: sucursal?.activo ?? true,
    crearEnApi: false,
  });

  const guardar = async () => {
    const datos = sucursal ? f.validar(editarSucursalSchema) : f.validar(crearSucursalSchema);
    if (!datos) return;
    try {
      await f.enviar(() =>
        sucursal
          ? pedir(`/sucursales/${sucursal.id}`, { method: 'PUT', cuerpo: { ...datos, telefono: f.valores.telefono || undefined } })
          : pedir('/sucursales', { cuerpo: { ...datos, telefono: f.valores.telefono || undefined }, idempotente: true }),
      );
      await alGuardar();
      toast(sucursal ? 'Sucursal actualizada' : 'Sucursal creada', 'ok');
      alCerrar();
    } catch (err) {
      toast(mensajeError(err), 'error');
    }
  };

  return (
    <Dialogo
      titulo={sucursal ? `Editar ${sucursal.nombre}` : 'Nueva sucursal'}
      abierto
      alCerrar={alCerrar}
      ancho
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
          <Campo etiqueta="Nombre" ancho="mitad" {...f.texto('nombre')} />
          <Campo
            etiqueta="Código de local"
            ancho="cuarto"
            className="font-id"
            maxLength={4}
            inputMode="numeric"
            disabled={Boolean(sucursal)}
            ayuda={sucursal ? 'Lo define la sucursal de API-PRO' : '4 dígitos, ej. 0002'}
            {...f.texto('codLocal')}
          />
          <Campo etiqueta="Ubigeo" ancho="cuarto" className="font-id" maxLength={6} inputMode="numeric" {...f.texto('ubigeo')} />
          <Campo etiqueta="Dirección" ancho="mitad" {...f.texto('direccion')} />
          <Campo etiqueta="Teléfono" ancho="mitad" opcional {...f.texto('telefono')} />
          <Selector
            etiqueta="Envío de boletas por defecto"
            ancho="mitad"
            opciones={MODOS}
            value={f.valores.modoBoletas}
            onChange={(e) => f.fijar('modoBoletas', e.target.value as 'individual' | 'resumen')}
            ayuda="El cajero con permiso puede cambiarlo en cada venta."
          />
          <Campo etiqueta="Hora del resumen diario" type="time" ancho="cuarto" {...f.texto('horaResumen')} />
        </div>
        {sucursal ? (
          <Casilla etiqueta="Sucursal activa" checked={f.valores.activo} onChange={(e) => f.fijar('activo', e.target.checked)} />
        ) : (
          <>
            <Casilla etiqueta="Crear también esta sucursal en API-PRO" checked={f.valores.crearEnApi} onChange={(e) => f.fijar('crearEnApi', e.target.checked)} />
            {f.valores.crearEnApi ? (
              <Franja tono="aviso">Se creará la sucursal {f.valores.codLocal || '____'} en tu cuenta de API-PRO (operación de escritura en la API).</Franja>
            ) : (
              <Franja>Podrás vincularla después con una sucursal existente de API-PRO.</Franja>
            )}
          </>
        )}
        {sucursal?.apiSucursalId && <Franja>Los cambios solo se guardan en este sistema: la sucursal de API-PRO puede estar compartida con otros sistemas.</Franja>}
      </div>
    </Dialogo>
  );
}

function VincularDialogo({ sucursal, alCerrar, alGuardar }: { sucursal: SucursalDto; alCerrar: () => void; alGuardar: () => Promise<void> }) {
  const toast = useToast();
  const { data: api, isLoading, error } = useQuery({ queryKey: ['sucursales-api'], queryFn: () => pedir<SucursalApi[]>('/sucursales/api-pro') });
  const [elegida, setElegida] = useState<number | null>(null);
  const [enviando, setEnviando] = useState(false);
  const libres = (api ?? []).filter((s) => s.activo && !s.vinculadaA);
  const seleccion = libres.find((s) => s.id === elegida);

  const vincular = async () => {
    if (!elegida) return;
    setEnviando(true);
    try {
      await pedir(`/sucursales/${sucursal.id}/vincular`, { cuerpo: { apiSucursalId: elegida } });
      await alGuardar();
      toast('Sucursal vinculada', 'ok');
      alCerrar();
    } catch (err) {
      toast(mensajeError(err), 'error');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialogo
      titulo={`Vincular ${sucursal.nombre} con API-PRO`}
      abierto
      alCerrar={alCerrar}
      pie={
        <>
          <Boton onClick={alCerrar}>Cancelar</Boton>
          <Boton variante="primario" onClick={vincular} disabled={!elegida} cargando={enviando}>
            Vincular
          </Boton>
        </>
      }
    >
      <div className={ui.pila}>
        {isLoading && <span className="muted">Consultando API-PRO…</span>}
        {error && <Franja tono="alerta">{mensajeError(error)}</Franja>}
        {api && !libres.length && <Franja tono="aviso">No hay sucursales libres en API-PRO. Crea una nueva sucursal marcando "Crear también en API-PRO".</Franja>}
        {libres.length > 0 && (
          <div className={ui.form}>
            <Selector
              etiqueta="Sucursal de API-PRO"
              value={elegida == null ? '' : String(elegida)}
              onChange={(e) => setElegida(Number(e.target.value) || null)}
              opciones={[{ valor: '', texto: 'Elige una sucursal…' }, ...libres.map((s) => ({ valor: String(s.id), texto: `${s.codLocal} · ${s.nombre}` }))]}
            />
          </div>
        )}
        {seleccion && (
          <Franja tono="aviso">
            La sucursal local adoptará el código de local {seleccion.codLocal}. Sus series en API-PRO aparecerán en esta sucursal como externas hasta que crees series propias.
          </Franja>
        )}
      </div>
    </Dialogo>
  );
}

/** Trae las sucursales que ya existen en API-PRO, ya vinculadas y con sus series. Solo lee de API-PRO. */
function ImportarDialogo({ alCerrar, alImportar }: { alCerrar: () => void; alImportar: () => Promise<void> }) {
  const toast = useToast();
  const { data: api, isLoading, error } = useQuery({ queryKey: ['sucursales-api'], queryFn: () => pedir<SucursalApi[]>('/sucursales/api-pro') });
  const [enviando, setEnviando] = useState(false);
  const pendientes = (api ?? []).filter((s) => s.activo && !s.vinculadaA);

  const importar = async () => {
    setEnviando(true);
    try {
      const r = await pedir<{ creadas: SucursalDto[]; omitidas: Array<{ nombre: string; motivo: string }> }>('/sucursales/importar', { cuerpo: { apiSucursalIds: pendientes.map((s) => s.id) } });
      await alImportar();
      toast(`${r.creadas.length} sucursal(es) importadas con sus series`, 'ok');
      if (r.omitidas.length) toast(`No se importaron: ${r.omitidas.map((o) => `${o.nombre} (${o.motivo})`).join('; ')}`, 'info');
      alCerrar();
    } catch (err) {
      toast(mensajeError(err), 'error');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialogo
      titulo="Importar sucursales de API-PRO"
      abierto
      alCerrar={alCerrar}
      pie={<><Boton onClick={alCerrar}>Cancelar</Boton><Boton variante="primario" onClick={() => void importar()} cargando={enviando} disabled={pendientes.length === 0}>Importar {pendientes.length || ''}</Boton></>}
    >
      <div className={ui.pila}>
        <span className="muted">Se crean aquí con el nombre, código de local, dirección y ubigeo de API-PRO, y se les asignan sus series. No se modifica nada en API-PRO.</span>
        {isLoading && <span className="muted">Consultando API-PRO…</span>}
        {error && <Franja tono="alerta">{mensajeError(error)}</Franja>}
        {api && (
          <Tabla
            filas={api}
            clave={(s) => s.id}
            vacio="API-PRO no tiene sucursales."
            columnas={[
              { titulo: 'Sucursal en API-PRO', celda: (s) => s.nombre },
              { titulo: 'Código', celda: (s) => <span className="font-id">{s.codLocal}</span> },
              { titulo: '', celda: (s) => (!s.activo ? <Chip>Desactivada</Chip> : s.vinculadaA ? <Chip tono="ok">Ya está aquí</Chip> : <Chip tono="info">Se importará</Chip>) },
            ]}
          />
        )}
      </div>
    </Dialogo>
  );
}
