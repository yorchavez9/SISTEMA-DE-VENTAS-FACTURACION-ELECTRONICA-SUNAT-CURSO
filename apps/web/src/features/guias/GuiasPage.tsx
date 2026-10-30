import {
  ESTADOS_GUIA, ETIQUETA_ESTADO_GUIA, FORMATOS_PDF, guiaSchema, MODALIDADES_TRASLADO, MOTIVOS_TRASLADO,
  type BorradorGuiaDto, type EstadoGuia, type FormatoPdf, type GuiaDetalleDto, type GuiaInput, type GuiaListaDto, type Pagina, type TipoDocTercero, type UbigeoDto,
} from '@sv/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, FileCode2, FileDown, FileText, Plus, RefreshCw, Trash2, Truck } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Route, Routes, useSearchParams } from 'react-router-dom';
import { BuscadorProducto, CampoDocumento, useRetardo } from '../../components/comunes';
import css from '../../components/comunes.module.css';
import { Boton, Campo, Casilla, Chip, Dialogo, Encabezado, Franja, Pestanas, Selector, Tabla, ui, useToast, type Tono, SelectorFecha } from '../../components/ui';
import { useFormulario } from '../../lib/formulario';
import { cantidad, hoyLima } from '../../lib/formato';
import { descargar, mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';
import { MaestrosTransporte, useConductores, useTransportistas, useVehiculos } from './Maestros';

const TONO: Record<EstadoGuia, Tono> = {
  pendiente: 'neutro', enviando: 'info', por_verificar: 'aviso', en_proceso: 'info', aceptado: 'ok', rechazado: 'alerta', error_validacion: 'alerta', sin_respuesta_sunat: 'aviso',
};
const NOMBRE_FORMATO: Record<FormatoPdf, string> = { a4: 'A4', a5: 'A5', 'ticket-80': 'Ticket 80 mm', 'ticket-58': 'Ticket 58 mm' };

function EstadoGuiaChip({ g }: { g: Pick<GuiaListaDto, 'estado' | 'simulado'> }) {
  return (
    <>
      <Chip tono={TONO[g.estado]}>{ETIQUETA_ESTADO_GUIA[g.estado]}</Chip>
      {g.simulado && (
        <span style={{ marginLeft: '0.25rem' }}>
          <Chip>Simulada</Chip>
        </span>
      )}
    </>
  );
}

export function GuiasPage() {
  return (
    <>
      <Encabezado titulo="Guías de remisión" />
      <Pestanas items={[{ ruta: '/guias', texto: 'Guías', icono: FileText }, { ruta: '/guias/transporte', texto: 'Transportistas, vehículos y conductores', icono: Truck }]} />
      <Routes>
        <Route index element={<ListaGuias />} />
        <Route path="transporte" element={<MaestrosTransporte />} />
      </Routes>
    </>
  );
}

type Origen = GuiaInput['origen'];

function ListaGuias() {
  const { sesion, puede } = useSesion();
  const [params, setParams] = useSearchParams();
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [estado, setEstado] = useState('');
  const [buscar, setBuscar] = useState('');
  const [page, setPage] = useState(1);
  const [viendo, setViendo] = useState<number | null>(null);
  const [nueva, setNueva] = useState<Origen | null>(null);
  const q = useRetardo(buscar);

  // Enlaces desde un comprobante (?comprobanteId=) o un traslado (?trasladoId=).
  useEffect(() => {
    const c = Number(params.get('comprobanteId'));
    const t = Number(params.get('trasladoId'));
    if (c) setNueva({ tipo: 'venta', comprobanteId: c });
    else if (t) setNueva({ tipo: 'traslado', trasladoId: t });
    if (c || t) setParams({}, { replace: true });
  }, [params, setParams]);

  const filtro = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (desde) filtro.set('desde', desde);
  if (hasta) filtro.set('hasta', hasta);
  if (estado) filtro.set('estado', estado);
  if (q) filtro.set('q', q);
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['guias', filtro.toString(), sesion?.sucursalActiva?.id],
    queryFn: () => pedir<Pagina<GuiaListaDto>>(`/guias?${filtro}`),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const reiniciar = <T,>(f: (v: T) => void) => (v: T) => (f(v), setPage(1));

  return (
    <div className={ui.pila}>
      <div className={css.filtros} style={{ marginBottom: 0 }}>
        <Input type="search" placeholder="Número, documento o destinatario" value={buscar} onChange={(e) => reiniciar(setBuscar)(e.target.value)} aria-label="Buscar" />
        <SelectorFecha value={desde} max={hasta || undefined} onChange={(v) => reiniciar(setDesde)(v)} aria-label="Desde" />
        <SelectorFecha value={hasta} min={desde || undefined} onChange={(v) => reiniciar(setHasta)(v)} aria-label="Hasta" />
        <Selector value={String(estado)} onChange={(e) => reiniciar(setEstado)(e.target.value)} aria-label="Estado" opciones={[{ valor: '', texto: 'Todos los estados' }, ...ESTADOS_GUIA.map((e) => ({ valor: String(e), texto: ETIQUETA_ESTADO_GUIA[e] }))]} />
        <span style={{ flex: 1 }} />
        <Boton icono={RefreshCw} onClick={() => void refetch()} cargando={isFetching}>Actualizar</Boton>
        {puede('guias.crear') && <Boton variante="primario" icono={Plus} onClick={() => setNueva({ tipo: 'manual' })}>Nueva guía</Boton>}
      </div>
      <Tabla
        filas={data?.data ?? []}
        clave={(g) => g.id}
        vacio="No hay guías con estos filtros."
        columnas={[
          { titulo: 'Guía', celda: (g) => <><strong className="font-id">{g.numeroCompleto ?? `${g.serie}-…`}</strong><span className={ui.sub}>{g.fechaEmision} · traslado {g.fechaTraslado}</span></> },
          { titulo: 'Destinatario', celda: (g) => g.destinatario },
          { titulo: 'Motivo', celda: (g) => g.motivo },
          { titulo: 'Estado', celda: (g) => <EstadoGuiaChip g={g} /> },
          { titulo: '', celda: (g) => <div className={ui.acciones}><Boton chico icono={Eye} onClick={() => setViendo(g.id)}>Ver</Boton></div> },
        ]}
        paginacion={data && { page: data.page, pageSize: data.pageSize, total: data.total, alCambiar: setPage }}
      />
      {viendo && <DetalleGuia id={viendo} alCerrar={() => setViendo(null)} />}
      {nueva && <FormularioGuia origen={nueva} alCerrar={() => setNueva(null)} alGuardar={(id) => (setNueva(null), setViendo(id))} />}
    </div>
  );
}

// ---------- Detalle ----------

function DetalleGuia({ id, alCerrar }: { id: number; alCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useSesion();
  const { data: g } = useQuery({ queryKey: ['guia', id], queryFn: () => pedir<GuiaDetalleDto>(`/guias/${id}`), refetchInterval: 5000 });
  const [formato, setFormato] = useState<FormatoPdf>('a4');
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [corrigiendo, setCorrigiendo] = useState(false);

  const refrescar = async () => {
    await qc.invalidateQueries({ queryKey: ['guia', id] });
    await qc.invalidateQueries({ queryKey: ['guias'] });
  };
  const accion = async (nombre: string, fn: () => Promise<unknown>, ok: string) => {
    setOcupado(nombre);
    try {
      await fn();
      await refrescar();
      toast(ok, 'ok');
    } catch (err) {
      toast(mensajeError(err), 'error');
    } finally {
      setOcupado(null);
    }
  };

  if (!g) return null;
  const tiene = (a: GuiaDetalleDto['acciones'][number]) => g.acciones.includes(a);

  return (
    <Dialogo
      titulo={`Guía ${g.numeroCompleto ?? `${g.serie} (por numerar)`}`}
      abierto
      ancho
      alCerrar={alCerrar}
      pie={
        <>
          {tiene('reintentar') && puede('guias.crear') && <Boton onClick={() => void accion('reintentar', () => pedir(`/guias/${id}/reintentar`, { method: 'POST' }), 'Reintento en curso')} cargando={ocupado === 'reintentar'}>Reintentar</Boton>}
          {tiene('consultar') && <Boton onClick={() => void accion('consultar', () => pedir(`/guias/${id}/consultar`, { method: 'POST' }), 'Consulta programada')} cargando={ocupado === 'consultar'}>Consultar a SUNAT</Boton>}
          {tiene('corregir') && puede('guias.crear') && <Boton variante="primario" onClick={() => setCorrigiendo(true)}>Corregir y reenviar</Boton>}
          <Boton onClick={alCerrar}>Cerrar</Boton>
        </>
      }
    >
      <div className={ui.pila}>
        <div className={ui.acciones} style={{ justifyContent: 'flex-start' }}>
          <EstadoGuiaChip g={g} />
          {g.sunatCodigo && <span className="muted">Código SUNAT {g.sunatCodigo}</span>}
        </div>
        {g.simulado && <Franja tono="aviso">Guía simulada: no se envió a SUNAT y no sirve para el traslado.</Franja>}
        {g.estado === 'en_proceso' && <Franja>SUNAT está procesando la guía; el estado se actualiza solo.</Franja>}
        {(g.ultimoError || (g.sunatDescripcion && ['rechazado', 'error_validacion'].includes(g.estado))) && <Franja tono="alerta">{g.ultimoError ?? g.sunatDescripcion}</Franja>}
        <div className={ui.form}>
          <Campo etiqueta="Destinatario" readOnly ancho="mitad" value={`${g.destinatarioDoc.razonSocial} · ${g.destinatarioDoc.numDoc}`} />
          <Campo etiqueta="Motivo" readOnly ancho="cuarto" value={g.motivo} />
          <Campo etiqueta="Modalidad" readOnly ancho="cuarto" value={`${MODALIDADES_TRASLADO[g.modTraslado]}${g.vehiculoM1l ? ' (vehículo M1/L)' : ''}`} />
          <Campo etiqueta="Partida" readOnly ancho="mitad" value={`${g.partida.direccion} · ${g.partida.lugar ?? g.partida.ubigeo}`} />
          <Campo etiqueta="Llegada" readOnly ancho="mitad" value={`${g.llegada.direccion} · ${g.llegada.lugar ?? g.llegada.ubigeo}`} />
          <Campo etiqueta="Fecha de traslado" readOnly ancho="cuarto" value={g.fechaTraslado} />
          <Campo etiqueta="Peso bruto" readOnly ancho="cuarto" value={`${cantidad(g.pesoTotal)} kg`} />
          <Campo etiqueta="Bultos" readOnly ancho="cuarto" value={g.numBultos ?? '—'} />
          <Campo etiqueta="Origen" readOnly ancho="cuarto" value={g.origen.tipo === 'venta' ? `Venta · ${g.origen.comprobante ?? ''}` : g.origen.tipo === 'traslado' ? `Traslado ${g.origen.trasladoId}` : 'Manual'} />
          {g.transportista && <Campo etiqueta="Transportista" readOnly value={`${g.transportista.razonSocial} · RUC ${g.transportista.ruc}${g.transportista.nroMtc ? ` · MTC ${g.transportista.nroMtc}` : ''} · entrega ${g.fechaEntregaTransportista ?? ''}`} />}
          {g.vehiculo && <Campo etiqueta="Vehículo" readOnly ancho="mitad" value={[g.vehiculo.placa, ...g.vehiculo.secundarios].join(' + ')} />}
          {g.conductores.length > 0 && <Campo etiqueta="Conductores" readOnly ancho="mitad" value={g.conductores.map((c) => `${c.nombre} (${c.licencia})`).join(' · ')} />}
        </div>
        <Tabla
          filas={g.items}
          clave={(i) => `${i.descripcion}-${i.cantidad}-${i.codigo ?? ''}`}
          columnas={[
            { titulo: 'Bien', celda: (i) => <>{i.descripcion}<span className={ui.sub}>{i.codigo ?? ''}</span></> },
            { titulo: 'Unidad', celda: (i) => i.unidad },
            { titulo: 'Cantidad', celda: (i) => cantidad(i.cantidad), alinear: 'derecha' },
          ]}
        />
        {(tiene('pdf') || tiene('xml') || tiene('cdr')) && (
          <div className={ui.acciones} style={{ justifyContent: 'flex-start', alignItems: 'center' }}>
            {tiene('pdf') && (
              <>
                <Selector value={String(formato)} onChange={(e) => setFormato(e.target.value as FormatoPdf)} aria-label="Formato del PDF" opciones={[...FORMATOS_PDF.map((f) => ({ valor: String(f), texto: NOMBRE_FORMATO[f] }))]} />
                <Boton icono={FileText} cargando={ocupado === 'pdf'} onClick={() => void accion('pdf', () => descargar(`/guias/${id}/pdf?formato=${formato}`, { abrir: true }), 'PDF abierto')}>PDF</Boton>
              </>
            )}
            {tiene('xml') && <Boton icono={FileCode2} onClick={() => void accion('xml', () => descargar(`/guias/${id}/xml`), 'XML descargado')}>XML</Boton>}
            {tiene('cdr') && <Boton icono={FileDown} onClick={() => void accion('cdr', () => descargar(`/guias/${id}/cdr`), 'CDR descargado')}>CDR</Boton>}
          </div>
        )}
      </div>
      {corrigiendo && <FormularioGuia origen={aOrigen(g)} guia={g} alCerrar={() => setCorrigiendo(false)} alGuardar={() => (setCorrigiendo(false), void refrescar())} />}
    </Dialogo>
  );
}

const aOrigen = (g: GuiaDetalleDto): Origen =>
  g.origen.tipo === 'venta' && g.origen.comprobanteId ? { tipo: 'venta', comprobanteId: g.origen.comprobanteId } : g.origen.tipo === 'traslado' && g.origen.trasladoId ? { tipo: 'traslado', trasladoId: g.origen.trasladoId } : { tipo: 'manual' };

// ---------- Formulario (nueva o corrección) ----------

interface Linea { productoId: number | null; codigo: string; descripcion: string; unidad: string; cantidad: string }

function valoresIniciales(g?: GuiaDetalleDto) {
  return {
    serieId: g ? String(g.ids.serieId) : '',
    codTraslado: g?.codTraslado ?? '01',
    modTraslado: (g?.modTraslado ?? '02') as '01' | '02',
    vehiculoM1l: g?.vehiculoM1l ?? false,
    fechaTraslado: g && g.fechaTraslado >= hoyLima() ? g.fechaTraslado : hoyLima(),
    fechaEntregaTransportista: g?.fechaEntregaTransportista ?? hoyLima(),
    pesoTotal: g ? String(Number(g.pesoTotal)) : '',
    numBultos: g?.numBultos ? String(g.numBultos) : '',
    destinatario: { tipoDoc: (g?.destinatarioDoc.tipoDoc ?? '6') as TipoDocTercero, numDoc: g?.destinatarioDoc.numDoc ?? '', razonSocial: g?.destinatarioDoc.razonSocial ?? '' },
    partida: { ubigeo: g?.partida.ubigeo ?? '', direccion: g?.partida.direccion ?? '' },
    llegada: { ubigeo: g?.llegada.ubigeo ?? '', direccion: g?.llegada.direccion ?? '' },
    transportistaId: g?.ids.transportistaId ? String(g.ids.transportistaId) : '',
    vehiculoId: g?.ids.vehiculoId ? String(g.ids.vehiculoId) : '',
    conductor1: g?.ids.conductoresIds[0] ? String(g.ids.conductoresIds[0]) : '',
    conductor2: g?.ids.conductoresIds[1] ? String(g.ids.conductoresIds[1]) : '',
    observacion: g?.observacion ?? '',
    items: (g?.items ?? []).map((i) => ({ productoId: i.productoId, codigo: i.codigo ?? '', descripcion: i.descripcion, unidad: i.unidad, cantidad: String(Number(i.cantidad)) })) as Linea[],
  };
}

function FormularioGuia({ origen, guia, alCerrar, alGuardar }: { origen: Origen; guia?: GuiaDetalleDto; alCerrar: () => void; alGuardar: (id: number) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const f = useFormulario(valoresIniciales(guia));
  const v = f.valores;
  const [clave] = useState(() => crypto.randomUUID());
  const { data: series = [] } = useQuery({ queryKey: ['series-guia'], queryFn: () => pedir<Array<{ id: number; serie: string; predeterminada: boolean }>>('/guias/series'), enabled: !guia });
  const { data: transportistas = [] } = useTransportistas();
  const { data: vehiculos = [] } = useVehiculos();
  const { data: conductores = [] } = useConductores();
  const consulta = origen.tipo === 'venta' ? `comprobanteId=${origen.comprobanteId}` : origen.tipo === 'traslado' ? `trasladoId=${origen.trasladoId}` : '';
  const { data: borrador } = useQuery({ queryKey: ['guia-borrador', consulta], queryFn: () => pedir<BorradorGuiaDto>(`/guias/borrador?${consulta}`), enabled: !guia });

  // Al llegar el borrador se completa el formulario (solo en una guía nueva).
  useEffect(() => {
    if (!borrador || guia) return;
    f.setValores((x) => ({
      ...x,
      codTraslado: borrador.codTraslado,
      destinatario: borrador.destinatario ? { tipoDoc: borrador.destinatario.tipoDoc as TipoDocTercero, numDoc: borrador.destinatario.numDoc, razonSocial: borrador.destinatario.razonSocial } : x.destinatario,
      partida: borrador.partida ?? x.partida,
      llegada: borrador.llegada ?? x.llegada,
      items: borrador.items.length ? borrador.items.map((i) => ({ productoId: i.productoId, codigo: i.codigo ?? '', descripcion: i.descripcion, unidad: i.unidad, cantidad: String(Number(i.cantidad)) })) : x.items,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [borrador, guia]);
  useEffect(() => {
    if (!v.serieId && series.length) f.fijar('serieId', String((series.find((s) => s.predeterminada) ?? series[0])!.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series]);

  const fijarEn = <K extends 'destinatario' | 'partida' | 'llegada'>(campo: K, cambio: Partial<(typeof v)[K]>) => f.setValores((x) => ({ ...x, [campo]: { ...x[campo], ...cambio } }));
  const fijarLinea = (i: number, cambio: Partial<Linea>) => f.setValores((x) => ({ ...x, items: x.items.map((l, j) => (j === i ? { ...l, ...cambio } : l)) }));
  const publico = v.modTraslado === '01' && !v.vehiculoM1l;
  const privado = v.modTraslado === '02' && !v.vehiculoM1l;

  const datos = (): unknown => ({
    serieId: v.serieId ? Number(v.serieId) : undefined,
    origen,
    destinatario: v.destinatario,
    codTraslado: v.codTraslado,
    modTraslado: v.modTraslado,
    vehiculoM1l: v.vehiculoM1l,
    fechaTraslado: v.fechaTraslado,
    fechaEntregaTransportista: v.modTraslado === '01' ? v.fechaEntregaTransportista || undefined : undefined,
    pesoTotal: v.pesoTotal,
    numBultos: v.numBultos ? Number(v.numBultos) : undefined,
    partida: v.partida,
    llegada: v.llegada,
    transportistaId: publico && v.transportistaId ? Number(v.transportistaId) : undefined,
    vehiculoId: privado && v.vehiculoId ? Number(v.vehiculoId) : undefined,
    conductoresIds: privado ? [v.conductor1, v.conductor2].filter(Boolean).map(Number) : [],
    observacion: v.observacion,
    items: v.items.map((i) => ({ productoId: i.productoId ?? undefined, codigo: i.codigo || undefined, descripcion: i.descripcion, unidad: i.unidad, cantidad: i.cantidad })),
  });

  const guardar = async () => {
    const d = f.validar(guiaSchema, datos());
    if (!d) {
      toast('Revisa los datos marcados', 'error');
      return;
    }
    try {
      await f.enviar(async () => {
        const r = guia ? await pedir<GuiaDetalleDto>(`/guias/${guia.id}`, { method: 'PUT', cuerpo: d }) : await pedir<GuiaDetalleDto>('/guias', { cuerpo: d, idempotente: clave });
        await qc.invalidateQueries({ queryKey: ['guias'] });
        toast(guia ? 'Guía corregida: se vuelve a enviar' : 'Guía registrada: se envía a SUNAT', 'ok');
        alGuardar(r.id);
      });
    } catch (err) {
      toast(mensajeError(err), 'error');
    }
  };

  const e = f.errores;
  const opciones = <T extends { id: number }>(filas: T[], texto: (x: T) => string, vacio = 'Elegir…') => [{ valor: '', texto: vacio }, ...filas.map((x) => ({ valor: String(x.id), texto: texto(x) }))];
  const activos = <T extends { activo: boolean; id: number }>(filas: T[], actual: string) => filas.filter((x) => x.activo || String(x.id) === actual);

  return (
    <Dialogo
      titulo={guia ? `Corregir guía ${guia.numeroCompleto ?? guia.serie}` : 'Nueva guía de remisión remitente'}
      abierto
      ancho
      fijo
      alCerrar={alCerrar}
      pie={<><Boton onClick={alCerrar}>Cancelar</Boton><Boton variante="primario" onClick={() => void guardar()} cargando={f.enviando}>{guia ? 'Guardar y reenviar' : 'Emitir guía'}</Boton></>}
    >
      <div className={ui.pila}>
        {borrador?.advertencias.map((a) => <Franja key={a} tono="aviso">{a}</Franja>)}
        {borrador && borrador.guiasPrevias.length > 0 && <Franja tono="aviso">Ya hay guías vigentes para este origen: {borrador.guiasPrevias.join(', ')}.</Franja>}
        {!guia && series.length === 0 && <Franja tono="alerta">La sucursal no tiene una serie propia de guía de remisión (T###). Créala en Configuración → Series.</Franja>}
        {e.origen && <Franja tono="alerta">{e.origen}</Franja>}

        <h3 style={{ margin: 0 }}>Traslado</h3>
        <div className={ui.form}>
          {!guia && <Selector etiqueta="Serie" ancho="cuarto" value={v.serieId} error={e.serieId} onChange={(x) => f.fijar('serieId', x.target.value)} opciones={series.map((s) => ({ valor: String(s.id), texto: s.serie }))} />}
          <Selector etiqueta="Motivo" ancho="mitad" value={v.codTraslado} error={e.codTraslado} disabled={origen.tipo === 'traslado'} onChange={(x) => f.fijar('codTraslado', x.target.value)} opciones={Object.entries(MOTIVOS_TRASLADO).map(([valor, texto]) => ({ valor, texto: `${valor} · ${texto}` }))} />
          <Campo etiqueta="Fecha de traslado" type="date" ancho="cuarto" min={hoyLima()} value={v.fechaTraslado} error={e.fechaTraslado} onChange={(x) => f.fijar('fechaTraslado', x.target.value)} />
          <Campo etiqueta="Peso bruto total (kg)" ancho="cuarto" inputMode="decimal" {...f.texto('pesoTotal')} />
          <Campo etiqueta="Bultos" ancho="cuarto" opcional inputMode="numeric" {...f.texto('numBultos')} />
        </div>

        <h3 style={{ margin: 0 }}>Destinatario</h3>
        <div className={ui.form}>
          <CampoDocumento
            recurso="clientes"
            valor={{ tipoDoc: v.destinatario.tipoDoc, numDoc: v.destinatario.numDoc }}
            alCambiar={(d) => fijarEn('destinatario', d)}
            alEncontrar={(r) => r.razonSocial && fijarEn('destinatario', { razonSocial: r.razonSocial })}
            error={e['destinatario.numDoc'] ?? e['destinatario.tipoDoc']}
          />
          <Campo etiqueta="Nombre o razón social" ancho="cuarto" value={v.destinatario.razonSocial} error={e['destinatario.razonSocial']} onChange={(x) => fijarEn('destinatario', { razonSocial: x.target.value })} />
        </div>

        <h3 style={{ margin: 0 }}>Recorrido</h3>
        <div className={ui.form}>
          <CampoUbigeo etiqueta="Ubigeo de partida" valor={v.partida.ubigeo} error={e['partida.ubigeo']} alCambiar={(u) => fijarEn('partida', { ubigeo: u })} />
          <Campo etiqueta="Dirección de partida" ancho="mitad" value={v.partida.direccion} error={e['partida.direccion']} onChange={(x) => fijarEn('partida', { direccion: x.target.value })} />
          <CampoUbigeo etiqueta="Ubigeo de llegada" valor={v.llegada.ubigeo} error={e['llegada.ubigeo']} alCambiar={(u) => fijarEn('llegada', { ubigeo: u })} />
          <Campo etiqueta="Dirección de llegada" ancho="mitad" value={v.llegada.direccion} error={e['llegada.direccion']} onChange={(x) => fijarEn('llegada', { direccion: x.target.value })} />
        </div>

        <h3 style={{ margin: 0 }}>Transporte</h3>
        <div className={ui.form}>
          <Selector etiqueta="Modalidad" ancho="cuarto" value={v.modTraslado} onChange={(x) => f.fijar('modTraslado', x.target.value as '01' | '02')} opciones={Object.entries(MODALIDADES_TRASLADO).map(([valor, texto]) => ({ valor, texto }))} />
          <div className={`${ui.campo} ${ui.mitad}`} style={{ justifyContent: 'flex-end' }}>
            <Casilla etiqueta="Vehículo M1 o L (auto o moto): no exige vehículo ni conductor" checked={v.vehiculoM1l} onChange={(x) => f.fijar('vehiculoM1l', x.target.checked)} />
          </div>
          {publico && (
            <>
              <Selector etiqueta="Transportista" ancho="mitad" value={v.transportistaId} error={e.transportistaId} onChange={(x) => f.fijar('transportistaId', x.target.value)} opciones={opciones(activos(transportistas, v.transportistaId), (t) => `${t.razonSocial} · ${t.ruc}`, transportistas.length ? 'Elegir…' : 'Registra uno en la pestaña de transporte')} />
              <Campo etiqueta="Entrega al transportista" type="date" ancho="cuarto" min={v.fechaTraslado} value={v.fechaEntregaTransportista} error={e.fechaEntregaTransportista} onChange={(x) => f.fijar('fechaEntregaTransportista', x.target.value)} />
            </>
          )}
          {privado && (
            <>
              <Selector etiqueta="Vehículo" ancho="cuarto" value={v.vehiculoId} error={e.vehiculoId} onChange={(x) => f.fijar('vehiculoId', x.target.value)} opciones={opciones(activos(vehiculos, v.vehiculoId), (x) => `${x.placa}${x.descripcion ? ` · ${x.descripcion}` : ''}`)} />
              <Selector etiqueta="Conductor principal" ancho="cuarto" value={v.conductor1} error={e.conductoresIds} onChange={(x) => f.fijar('conductor1', x.target.value)} opciones={opciones(activos(conductores, v.conductor1), (c) => `${c.nombres} ${c.apellidos}`)} />
              <Selector etiqueta="Conductor secundario" ancho="cuarto" opcional value={v.conductor2} onChange={(x) => f.fijar('conductor2', x.target.value)} opciones={opciones(activos(conductores, v.conductor2).filter((c) => String(c.id) !== v.conductor1), (c) => `${c.nombres} ${c.apellidos}`, 'Ninguno')} />
            </>
          )}
        </div>

        <h3 style={{ margin: 0 }}>Bienes</h3>
        <BuscadorProducto soloInventariables alElegir={(p) => f.setValores((x) => ({ ...x, items: [...x.items, { productoId: p.id, codigo: p.codigo, descripcion: p.nombre, unidad: p.unidad.codigoSunat, cantidad: '1' }] }))} />
        {e.items && <span className={ui.error}>{e.items}</span>}
        <Tabla
          filas={v.items}
          clave={(_, i) => i}
          vacio="Agrega los bienes que se trasladan."
          columnas={[
            { titulo: 'Descripción', celda: (l, i) => <Input value={l.descripcion} aria-label="Descripción" aria-invalid={Boolean(e[`items.${i}.descripcion`])} onChange={(x) => fijarLinea(i, { descripcion: x.target.value })} /> },
            { titulo: 'Unidad', celda: (l, i) => <Input className="w-20" value={l.unidad} aria-label="Unidad" maxLength={5} onChange={(x) => fijarLinea(i, { unidad: x.target.value.toUpperCase() })} /> },
            { titulo: 'Cantidad', fija: true, celda: (l, i) => <Input className="w-28" value={l.cantidad} inputMode="decimal" aria-label="Cantidad" aria-invalid={Boolean(e[`items.${i}.cantidad`])} onChange={(x) => fijarLinea(i, { cantidad: x.target.value })} /> },
            { titulo: '', celda: (_, i) => <Boton chico variante="plano" icono={Trash2} aria-label="Quitar" onClick={() => f.setValores((x) => ({ ...x, items: x.items.filter((_, j) => j !== i) }))} /> },
          ]}
        />
        <Boton chico variante="plano" icono={Plus} onClick={() => f.setValores((x) => ({ ...x, items: [...x.items, { productoId: null, codigo: '', descripcion: '', unidad: 'NIU', cantidad: '1' }] }))}>
          Agregar bien sin producto
        </Boton>
        <div className={ui.form}>
          <Campo etiqueta="Observación" opcional {...f.texto('observacion')} />
        </div>
      </div>
    </Dialogo>
  );
}

/** Ubigeo de 6 dígitos: se escribe o se elige región → provincia → distrito (catálogo de API-PRO en caché). */
function CampoUbigeo({ etiqueta, valor, alCambiar, error }: { etiqueta: string; valor: string; alCambiar: (u: string) => void; error?: string }) {
  const idCampo = useId();
  const [eligiendo, setEligiendo] = useState(false);
  const [region, setRegion] = useState(valor.slice(0, 2));
  const [provincia, setProvincia] = useState(valor.slice(0, 4));
  const lista = (ruta: string, activo: boolean) => ({ queryKey: ['ubigeo', ruta], queryFn: () => pedir<UbigeoDto[]>(ruta), enabled: activo, staleTime: Infinity });
  const regiones = useQuery(lista('/ubigeos/regiones', eligiendo));
  const provincias = useQuery(lista(`/ubigeos/provincias?region=${region}`, eligiendo && region.length === 2));
  const distritos = useQuery(lista(`/ubigeos/distritos?provincia=${provincia}`, eligiendo && provincia.length === 4));
  const sel = (datos: UbigeoDto[] | undefined, vacio: string) => [{ valor: '', texto: vacio }, ...(datos ?? []).map((u) => ({ valor: u.codigo, texto: u.nombre }))];

  if (eligiendo) {
    return (
      <>
        <Selector etiqueta="Región" ancho="cuarto" value={region} onChange={(e) => (setRegion(e.target.value), setProvincia(''))} opciones={sel(regiones.data, regiones.isError ? 'No disponible' : 'Elegir…')} />
        <Selector etiqueta="Provincia" ancho="cuarto" value={provincia} onChange={(e) => setProvincia(e.target.value)} opciones={sel(provincias.data, 'Elegir…')} />
        <Selector etiqueta="Distrito" ancho="cuarto" value={valor} onChange={(e) => (alCambiar(e.target.value), e.target.value && setEligiendo(false))} opciones={sel(distritos.data, 'Elegir…')} />
      </>
    );
  }
  return (
    <div className={`${ui.campo} ${ui.cuarto}`}>
      <Label htmlFor={idCampo}>{etiqueta}</Label>
      <div className="flex gap-2">
        <Input id={idCampo} className="font-id" inputMode="numeric" maxLength={6} value={valor} aria-invalid={Boolean(error) || undefined} onChange={(e) => alCambiar(e.target.value.replace(/\D/g, ''))} />
        <Boton onClick={() => setEligiendo(true)}>Elegir</Boton>
      </div>
      {error && <span className="text-xs text-destructive" role="alert">{error}</span>}
    </div>
  );
}
