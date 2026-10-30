import { clienteSchema, NOMBRE_TIPO_DOC, proveedorSchema, type ClienteDto, type Pagina, type ProveedorDto, type TipoDocTercero } from '@sv/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { CampoDocumento, useRetardo } from '../../components/comunes';
import css from '../../components/comunes.module.css';
import { Boton, Campo, Casilla, Chip, Dialogo, Selector, Tabla, ui, useToast } from '../../components/ui';
import { dinero } from '../../lib/formato';
import { useFormulario } from '../../lib/formulario';
import { ErrorHttp, mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';
import { Input } from '@/components/ui/input';

type Recurso = 'clientes' | 'proveedores';
type Tercero = ClienteDto | ProveedorDto;

const esCliente = (t: Tercero): t is ClienteDto => 'limiteCredito' in t;

/** Listado y edición de clientes o proveedores (misma pantalla, distinto recurso). */
export function TercerosLista({ recurso }: { recurso: Recurso }) {
  const { puede } = useSesion();
  const editable = puede(`${recurso}.editar`);
  const [buscar, setBuscar] = useState('');
  const [activo, setActivo] = useState<'true' | 'false' | 'todos'>('true');
  const [page, setPage] = useState(1);
  const [editando, setEditando] = useState<Tercero | 'nuevo' | null>(null);
  const q = useRetardo(buscar);

  const params = new URLSearchParams({ page: String(page), pageSize: '25', activo });
  if (q) params.set('q', q);
  const { data } = useQuery({ queryKey: [recurso, params.toString()], queryFn: () => pedir<Pagina<Tercero>>(`/${recurso}?${params}`), placeholderData: keepPreviousData });

  return (
    <>
      <div className={css.filtros}>
        <Input type="search" placeholder="Buscar por nombre o documento" value={buscar} onChange={(e) => (setBuscar(e.target.value), setPage(1))} aria-label="Buscar" />
        <Selector value={String(activo)} onChange={(e) => (setActivo(e.target.value as typeof activo), setPage(1))} aria-label="Estado" opciones={[{ valor: 'true', texto: 'Activos' }, { valor: 'false', texto: 'Desactivados' }, { valor: 'todos', texto: 'Todos' }]} />
        <span style={{ flex: 1 }} />
        {editable && (
          <Boton variante="primario" icono={Plus} onClick={() => setEditando('nuevo')}>
            {recurso === 'clientes' ? 'Nuevo cliente' : 'Nuevo proveedor'}
          </Boton>
        )}
      </div>
      <Tabla
        filas={data?.data ?? []}
        clave={(t) => t.id}
        vacio={q ? 'Sin coincidencias.' : recurso === 'clientes' ? 'Aún no hay clientes.' : 'Aún no hay proveedores.'}
        columnas={[
          { titulo: recurso === 'clientes' ? 'Cliente' : 'Proveedor', celda: (t) => <>{t.razonSocial}<span className={ui.sub}>{t.direccion ?? ''}</span></> },
          { titulo: 'Documento', celda: (t) => <>{NOMBRE_TIPO_DOC[t.tipoDoc]}<span className={`${ui.sub} font-id`}>{t.numDoc}</span></> },
          { titulo: 'Contacto', celda: (t) => [esCliente(t) ? null : t.contacto, t.telefono, t.email].filter(Boolean).join(' · ') || '—' },
          ...(recurso === 'clientes'
            ? [{ titulo: 'Límite de crédito', celda: (t: Tercero) => (esCliente(t) && t.limiteCredito ? dinero(t.limiteCredito, t.monedaCredito ?? 'PEN') : '—'), alinear: 'derecha' as const }]
            : []),
          { titulo: 'Estado', celda: (t) => (t.activo ? <Chip tono="ok">Activo</Chip> : <Chip>Desactivado</Chip>) },
          { titulo: '', celda: (t) => editable && <div className={ui.acciones}><Boton chico icono={Pencil} onClick={() => setEditando(t)}>Editar</Boton></div> },
        ]}
        paginacion={data && { page: data.page, pageSize: data.pageSize, total: data.total, alCambiar: setPage }}
      />
      {editando && <TerceroDialogo recurso={recurso} tercero={editando === 'nuevo' ? null : editando} alCerrar={() => setEditando(null)} />}
    </>
  );
}

export function TerceroDialogo({
  recurso, tercero, alCerrar, alGuardar, inicial,
}: {
  recurso: Recurso;
  tercero: Tercero | null;
  alCerrar: () => void;
  alGuardar?: (t: Tercero) => void;
  inicial?: { tipoDoc: TipoDocTercero; numDoc: string };
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const cliente = tercero && esCliente(tercero) ? tercero : null;
  const f = useFormulario({
    tipoDoc: (tercero?.tipoDoc ?? inicial?.tipoDoc ?? (recurso === 'proveedores' ? '6' : '1')) as TipoDocTercero,
    numDoc: tercero?.numDoc ?? inicial?.numDoc ?? '',
    razonSocial: tercero?.razonSocial ?? '',
    direccion: tercero?.direccion ?? '',
    email: tercero?.email ?? '',
    telefono: tercero?.telefono ?? '',
    contacto: tercero && !esCliente(tercero) ? (tercero.contacto ?? '') : '',
    limiteCredito: cliente?.limiteCredito ? String(Number(cliente.limiteCredito)) : '',
    monedaCredito: (cliente?.monedaCredito ?? 'PEN') as 'PEN' | 'USD',
    activo: tercero?.activo ?? true,
  });
  const [existente, setExistente] = useState<number | null>(null);

  const guardar = async () => {
    const esquema = recurso === 'clientes' ? clienteSchema : proveedorSchema;
    const datos = f.validar(esquema, { ...f.valores, monedaCredito: f.valores.limiteCredito ? f.valores.monedaCredito : undefined });
    if (!datos) return;
    try {
      let guardado: Tercero | undefined;
      await f.enviar(async () => {
        guardado = tercero
          ? await pedir<Tercero>(`/${recurso}/${tercero.id}`, { method: 'PUT', cuerpo: datos })
          : await pedir<Tercero>(`/${recurso}`, { cuerpo: datos });
      });
      await qc.invalidateQueries({ queryKey: [recurso] });
      toast(tercero ? 'Datos actualizados' : 'Registrado', 'ok');
      if (guardado) alGuardar?.(guardado);
      alCerrar();
    } catch (err) {
      if (err instanceof ErrorHttp && err.codigo === 'DUPLICADO') setExistente((err.cuerpo.detalle as { id?: number } | undefined)?.id ?? null);
      toast(mensajeError(err), 'error');
    }
  };

  const titulo = recurso === 'clientes' ? (tercero ? 'Editar cliente' : 'Nuevo cliente') : tercero ? 'Editar proveedor' : 'Nuevo proveedor';
  return (
    <Dialogo
      titulo={titulo}
      abierto
      ancho
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
      <div className={ui.form}>
        <CampoDocumento
          recurso={recurso}
          valor={{ tipoDoc: f.valores.tipoDoc, numDoc: f.valores.numDoc }}
          error={f.errores.numDoc}
          alCambiar={(v) => (f.fijar('tipoDoc', v.tipoDoc), f.fijar('numDoc', v.numDoc), setExistente(null))}
          alEncontrar={(r) => {
            if (r.origen === 'local' && r.id !== tercero?.id) setExistente(r.id);
            if (r.razonSocial && !f.valores.razonSocial) f.fijar('razonSocial', r.razonSocial);
            else if (r.razonSocial && r.origen === 'externo') f.fijar('razonSocial', r.razonSocial);
            if (r.direccion && !f.valores.direccion) f.fijar('direccion', r.direccion);
          }}
        />
        {existente && (
          <div className={ui.campo}>
            <span className={ui.error}>Este documento ya está registrado (id {existente}). Búscalo en el listado para editarlo.</span>
          </div>
        )}
        <Campo etiqueta={f.valores.tipoDoc === '6' ? 'Razón social' : 'Nombres y apellidos'} {...f.texto('razonSocial')} />
        <Campo etiqueta="Dirección" opcional ayuda={recurso === 'clientes' && f.valores.tipoDoc === '6' ? 'La factura la requiere' : undefined} {...f.texto('direccion')} />
        {recurso === 'proveedores' && <Campo etiqueta="Persona de contacto" opcional ancho="mitad" {...f.texto('contacto')} />}
        <Campo etiqueta="Teléfono" opcional ancho={recurso === 'proveedores' ? 'cuarto' : 'mitad'} {...f.texto('telefono')} />
        <Campo etiqueta="Email" type="email" opcional ancho={recurso === 'proveedores' ? 'cuarto' : 'mitad'} {...f.texto('email')} />
        {recurso === 'clientes' && (
          <>
            <Campo etiqueta="Límite de crédito" opcional ancho="mitad" inputMode="decimal" ayuda="Vacío = sin límite configurado" {...f.texto('limiteCredito')} />
            <Selector etiqueta="Moneda del límite" ancho="mitad" value={f.valores.monedaCredito} onChange={(e) => f.fijar('monedaCredito', e.target.value as 'PEN' | 'USD')} error={f.errores.monedaCredito} opciones={[{ valor: 'PEN', texto: 'Soles (PEN)' }, { valor: 'USD', texto: 'Dólares (USD)' }]} />
          </>
        )}
      </div>
      {tercero && (
        <div style={{ marginTop: '1rem' }}>
          <Casilla etiqueta="Activo" checked={f.valores.activo} onChange={(e) => f.fijar('activo', e.target.checked)} />
        </div>
      )}
    </Dialogo>
  );
}
