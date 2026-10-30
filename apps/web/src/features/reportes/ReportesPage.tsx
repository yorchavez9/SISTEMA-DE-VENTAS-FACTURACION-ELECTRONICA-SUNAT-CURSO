import {
  AGRUPACIONES_VENTAS, REPORTES, type AgrupacionVentas, type AuditoriaDto, type IntentoDto, type Pagina, type ReporteDto, type TipoColumna, type TipoReporte,
} from '@sv/shared';
import { Input } from '@/components/ui/input';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BarChart3, CloudUpload, Download, Eye, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { useRetardo } from '../../components/comunes';
import css from '../../components/comunes.module.css';
import { Boton, Casilla, Chip, Dialogo, Encabezado, Franja, Pestanas, Tabla, ui, useToast, Selector, SelectorFecha } from '../../components/ui';
import { fechaHora, hoyLima } from '../../lib/formato';
import { descargar, mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';

export function ReportesPage() {
  const { puede } = useSesion();
  return (
    <>
      <Encabezado titulo="Reportes" />
      {puede('auditoria.ver') && (
        <Pestanas items={[{ ruta: '/reportes', texto: 'Reportes', icono: BarChart3 }, { ruta: '/reportes/auditoria', texto: 'Auditoría', icono: ShieldCheck }, { ruta: '/reportes/integracion', texto: 'Envíos a API-PRO', icono: CloudUpload }]} />
      )}
      <Routes>
        <Route index element={<Reportes />} />
        {puede('auditoria.ver') && <Route path="auditoria" element={<Auditoria />} />}
        {puede('auditoria.ver') && <Route path="integracion" element={<Intentos />} />}
      </Routes>
    </>
  );
}

/** Reportes sin rango de fechas (foto al día de hoy). */
const SIN_FECHAS: TipoReporte[] = ['inventario', 'cxc'];
const primeroDelMes = () => `${hoyLima().slice(0, 8)}01`;

function formatear(tipo: TipoColumna, v: string | number | null): string {
  if (v == null || v === '') return '';
  if (tipo === 'importe') return Number(v).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (tipo === 'cantidad') return Number(v).toLocaleString('es-PE', { maximumFractionDigits: 3 });
  if (tipo === 'entero') return Number(v).toLocaleString('es-PE');
  return String(v);
}

function Reportes() {
  const { sesion } = useSesion();
  const toast = useToast();
  const [tipo, setTipo] = useState<TipoReporte>('ventas');
  const [agrupar, setAgrupar] = useState<AgrupacionVentas>('dia');
  const [desde, setDesde] = useState(primeroDelMes());
  const [hasta, setHasta] = useState(hoyLima());
  const [sucursal, setSucursal] = useState('');
  const [moneda, setMoneda] = useState('');
  const [exportando, setExportando] = useState(false);

  const params = new URLSearchParams();
  if (!SIN_FECHAS.includes(tipo)) {
    params.set('desde', desde);
    params.set('hasta', hasta);
  }
  if (tipo === 'ventas') {
    params.set('agrupar', agrupar);
    if (moneda) params.set('moneda', moneda);
  }
  if (sucursal) params.set('sucursalId', sucursal);
  const valido = SIN_FECHAS.includes(tipo) || (desde && hasta && desde <= hasta);
  const { data: r, isFetching, error } = useQuery({
    queryKey: ['reporte', tipo, params.toString()],
    queryFn: () => pedir<ReporteDto>(`/reportes/${tipo}?${params}`),
    enabled: Boolean(valido),
    placeholderData: keepPreviousData,
  });

  const exportar = async () => {
    setExportando(true);
    try {
      await descargar(`/reportes/${tipo}?${params}&formato=csv`);
    } catch (err) {
      toast(mensajeError(err), 'error');
    } finally {
      setExportando(false);
    }
  };

  const alinear = (t: TipoColumna) => (['importe', 'cantidad', 'entero', 'porcentaje'].includes(t) ? ('derecha' as const) : undefined);

  return (
    <div className={ui.pila}>
      <div className={css.filtros} style={{ marginBottom: 0 }}>
        <Selector value={String(tipo)} onChange={(e) => setTipo(e.target.value as TipoReporte)} aria-label="Reporte" opciones={[...Object.entries(REPORTES).map(([v, t]) => ({ valor: String(v), texto: t }))]} />
        {tipo === 'ventas' && (
          <Selector value={String(agrupar)} onChange={(e) => setAgrupar(e.target.value as AgrupacionVentas)} aria-label="Agrupar por" opciones={[...Object.entries(AGRUPACIONES_VENTAS).map(([v, t]) => ({ valor: String(v), texto: `Por ${t.toLowerCase()}` }))]} />
        )}
        {!SIN_FECHAS.includes(tipo) && (
          <>
            <SelectorFecha value={desde} max={hasta || undefined} onChange={(v) => setDesde(v)} aria-label="Desde" />
            <SelectorFecha value={hasta} min={desde || undefined} max={hoyLima()} onChange={(v) => setHasta(v)} aria-label="Hasta" />
          </>
        )}
        {(sesion?.sucursales.length ?? 0) > 1 && (
          <Selector value={String(sucursal)} onChange={(e) => setSucursal(e.target.value)} aria-label="Sucursal" opciones={[{ valor: '', texto: 'Todas mis sucursales' }, ...sesion!.sucursales.map((s) => ({ valor: String(s.id), texto: s.nombre }))]} />
        )}
        {tipo === 'ventas' && agrupar !== 'metodo' && (
          <Selector value={String(moneda)} onChange={(e) => setMoneda(e.target.value)} aria-label="Moneda" opciones={[{ valor: '', texto: 'Ambas monedas' }, { valor: 'PEN', texto: 'Soles' }, { valor: 'USD', texto: 'Dólares' }]} />
        )}
        <span style={{ flex: 1 }} />
        <Boton icono={Download} onClick={() => void exportar()} cargando={exportando} disabled={!r || r.filas.length === 0}>
          Exportar CSV
        </Boton>
      </div>
      {error && <Franja tono="alerta">{mensajeError(error)}</Franja>}
      {r && (
        <>
          <div>
            <h3 style={{ margin: 0 }}>{r.titulo}</h3>
            <span className="muted">
              {r.subtitulo}
              {isFetching ? ' · actualizando…' : ''}
            </span>
          </div>
          <Tabla
            filas={[...r.filas, ...r.totales.map((t) => ({ ...t, __total: true }))]}
            clave={(f) => JSON.stringify(f)}
            vacio="No hay datos para estos filtros."
            columnas={r.columnas.map((c) => ({
              titulo: c.titulo,
              alinear: alinear(c.tipo),
              celda: (f: Record<string, string | number | null | boolean>) => {
                const texto = formatear(c.tipo, f[c.clave] as string | number | null);
                return f.__total ? <strong>{texto}</strong> : texto;
              },
            }))}
          />
          {r.notas.map((n) => (
            <span key={n} className="muted">
              {n}
            </span>
          ))}
        </>
      )}
    </div>
  );
}

// ---------- Auditoría ----------

function Auditoria() {
  const [accion, setAccion] = useState('');
  const [entidad, setEntidad] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [page, setPage] = useState(1);
  const [viendo, setViendo] = useState<AuditoriaDto | null>(null);
  const a = useRetardo(accion);
  const params = new URLSearchParams({ page: String(page), pageSize: '50' });
  if (a) params.set('accion', a);
  if (entidad) params.set('entidad', entidad);
  if (desde) params.set('desde', desde);
  if (hasta) params.set('hasta', hasta);
  const { data } = useQuery({ queryKey: ['auditoria', params.toString()], queryFn: () => pedir<Pagina<AuditoriaDto>>(`/auditoria?${params}`), placeholderData: keepPreviousData });
  const reiniciar = <T,>(f: (v: T) => void) => (v: T) => (f(v), setPage(1));

  return (
    <div className={ui.pila}>
      <div className={css.filtros} style={{ marginBottom: 0 }}>
        <Input type="search" placeholder="Acción (p. ej. venta, comprobante.anular)" value={accion} onChange={(e) => reiniciar(setAccion)(e.target.value)} aria-label="Acción" />
        <Input style={{ width: '10rem' }} placeholder="Entidad" value={entidad} onChange={(e) => reiniciar(setEntidad)(e.target.value.trim())} aria-label="Entidad" />
        <SelectorFecha value={desde} onChange={(v) => reiniciar(setDesde)(v)} aria-label="Desde" />
        <SelectorFecha value={hasta} onChange={(v) => reiniciar(setHasta)(v)} aria-label="Hasta" />
      </div>
      <Tabla
        filas={data?.data ?? []}
        clave={(x) => x.id}
        vacio="No hay registros con estos filtros."
        columnas={[
          { titulo: 'Fecha', celda: (x) => fechaHora(x.fecha) },
          { titulo: 'Usuario', celda: (x) => <>{x.usuario ?? '—'}{x.operador && <span className={ui.sub}>operó {x.operador}</span>}</> },
          { titulo: 'Acción', celda: (x) => <span className="font-id">{x.accion}</span> },
          { titulo: 'Entidad', celda: (x) => `${x.entidad}${x.entidadId ? ` ${x.entidadId}` : ''}` },
          { titulo: 'Sucursal', celda: (x) => x.sucursal ?? '—' },
          { titulo: '', celda: (x) => (x.antes || x.despues ? <div className={ui.acciones}><Boton chico icono={Eye} onClick={() => setViendo(x)}>Ver</Boton></div> : null) },
        ]}
        paginacion={data && { page: data.page, pageSize: data.pageSize, total: data.total, alCambiar: setPage }}
      />
      {viendo && (
        <Dialogo titulo={`${viendo.accion} · ${fechaHora(viendo.fecha)}`} abierto ancho alCerrar={() => setViendo(null)}>
          <div className={ui.pila}>
            {viendo.antes != null && (
              <>
                <strong>Antes</strong>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'var(--fuente-mono)', fontSize: '0.8125rem' }}>{JSON.stringify(viendo.antes, null, 2)}</pre>
              </>
            )}
            {viendo.despues != null && (
              <>
                <strong>Después</strong>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'var(--fuente-mono)', fontSize: '0.8125rem' }}>{JSON.stringify(viendo.despues, null, 2)}</pre>
              </>
            )}
            {viendo.ip && <span className="muted">IP {viendo.ip}</span>}
          </div>
        </Dialogo>
      )}
    </div>
  );
}

function Intentos() {
  const [soloErrores, setSoloErrores] = useState(false);
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({ page: String(page), pageSize: '50' });
  if (soloErrores) params.set('soloErrores', 'true');
  const { data } = useQuery({ queryKey: ['intentos', params.toString()], queryFn: () => pedir<Pagina<IntentoDto>>(`/integracion/intentos?${params}`), placeholderData: keepPreviousData, refetchInterval: 30_000 });

  return (
    <div className={ui.pila}>
      <div className={css.filtros} style={{ marginBottom: 0 }}>
        <Casilla etiqueta="Solo errores y sin respuesta" checked={soloErrores} onChange={(e) => (setSoloErrores(e.target.checked), setPage(1))} />
      </div>
      <Tabla
        filas={data?.data ?? []}
        clave={(x) => x.id}
        vacio="Aún no hay llamadas a API-PRO."
        columnas={[
          { titulo: 'Fecha', celda: (x) => fechaHora(x.fecha) },
          { titulo: 'Operación', celda: (x) => <>{x.operacion}<span className={`${ui.sub} font-id`}>{x.metodo} {x.ruta}</span></> },
          { titulo: 'Entidad', celda: (x) => (x.entidadTipo ? `${x.entidadTipo} ${x.entidadId ?? ''}` : '—') },
          { titulo: 'HTTP', celda: (x) => (x.httpStatus == null ? <Chip tono="aviso">Sin respuesta</Chip> : <Chip tono={x.httpStatus < 300 ? 'ok' : x.httpStatus < 500 ? 'aviso' : 'alerta'}>{x.httpStatus}</Chip>) },
          { titulo: 'Tiempo', celda: (x) => (x.duracionMs == null ? '—' : `${x.duracionMs} ms`), alinear: 'derecha' },
          { titulo: 'Error', celda: (x) => <span className={ui.sub} style={{ maxWidth: '20rem', display: 'block' }}>{x.error ?? ''}</span> },
        ]}
        paginacion={data && { page: data.page, pageSize: data.pageSize, total: data.total, alCambiar: setPage }}
      />
    </div>
  );
}
