import {
  ETIQUETA_ESTADO, type ComprobanteDetalleDto, type ComprobanteListaDto, type EstadoIntegracionDto, type Pagina,
} from '@sv/shared';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, FileCode2, FileDown, FileText, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRetardo } from '../../components/comunes';
import css from '../../components/comunes.module.css';
import { AutorizacionDialogo } from '../../components/pin';
import { Boton, Campo, Casilla, Chip, Dialogo, Encabezado, Franja, Selector, Tabla, ui, useToast, SelectorFecha } from '../../components/ui';
import { useCajaActiva } from '../../lib/caja';
import { cantidad, dinero, fechaHora, hoyLima } from '../../lib/formato';
import { descargar, ErrorHttp, mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';
import { AnularDialogo, ReembolsoDialogo } from './AnulacionDialogos';
import { NotaCreditoDialogo, NotaDebitoDialogo } from './NotaDialogos';
import { AccionesComprobante } from './AccionesComprobante';
import { HojaFlotante } from '../../components/HojaFlotante';

const NOMBRE_TIPO: Record<string, string> = { '01': 'Factura', '03': 'Boleta', '07': 'Nota de crédito', '08': 'Nota de débito' };

export function EstadoChip({ c }: { c: Pick<ComprobanteListaDto, 'estado' | 'simulado'> }) {
  const e = ETIQUETA_ESTADO[c.estado];
  return (
    <>
      <Chip tono={e.tono}>{e.texto}</Chip>
      {c.simulado && (
        <span style={{ marginLeft: '0.25rem' }}>
          <Chip>Simulado</Chip>
        </span>
      )}
    </>
  );
}

/** Menú "Notas": la misma lista, filtrada en notas de crédito y abierta al mes en curso. */
export function NotasPage() {
  return <ComprobantesPage titulo="Notas de crédito y débito" tipoInicial="07" desdeInicial={`${hoyLima().slice(0, 8)}01`} />;
}

export function ComprobantesPage({ titulo = 'Comprobantes', tipoInicial = '', desdeInicial = hoyLima() }: { titulo?: string; tipoInicial?: string; desdeInicial?: string }) {
  const { sesion } = useSesion();
  const [desde, setDesde] = useState(desdeInicial);
  const [hasta, setHasta] = useState(hoyLima());
  const [tipo, setTipo] = useState(tipoInicial);
  const [estado, setEstado] = useState('');
  const [atencion, setAtencion] = useState(false);
  const [buscar, setBuscar] = useState('');
  const [page, setPage] = useState(1);
  const [viendo, setViendo] = useState<number | null>(null);
  const [pdf, setPdf] = useState<ComprobanteListaDto | null>(null);
  /** Comprobante cuyo mensaje (SUNAT, error o simulación) se lee en el modal del ojo. */
  const [nota, setNota] = useState<ComprobanteListaDto | null>(null);
  const q = useRetardo(buscar);

  const params = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (!atencion) {
    if (desde) params.set('desde', desde);
    if (hasta) params.set('hasta', hasta);
  } else params.set('atencion', 'true');
  if (tipo) params.set('tipoDoc', tipo);
  if (estado) params.set('estado', estado);
  if (q) params.set('q', q);
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['comprobantes', params.toString(), sesion?.sucursalActiva?.id],
    queryFn: () => pedir<Pagina<ComprobanteListaDto>>(`/comprobantes?${params}`),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const { data: integracion } = useQuery({ queryKey: ['estado-integracion'], queryFn: () => pedir<EstadoIntegracionDto>('/estado-integracion'), refetchInterval: 15_000 });
  const reiniciar = <T,>(f: (v: T) => void) => (v: T) => (f(v), setPage(1));
  const problemas = integracion?.contadores.problemas ?? 0;

  return (
    <>
      <Encabezado titulo={titulo}>
        <Boton icono={RefreshCw} onClick={() => void refetch()} cargando={isFetching}>
          Actualizar
        </Boton>
      </Encabezado>
      <div className={ui.pila}>
        {integracion?.modoEmision === 'simulacion' && <Franja tono="aviso">Modo simulación: los comprobantes no se envían a SUNAT y no tienen validez tributaria (Configuración → Empresa).</Franja>}
        {problemas > 0 && !atencion && (
          <Franja tono="alerta">
            {problemas} comprobante(s) requieren atención.{' '}
            <Button variant="link" className="h-auto p-0 text-inherit underline" onClick={() => reiniciar(setAtencion)(true)}>
              Ver
            </Button>
          </Franja>
        )}
        <div className={css.filtros} style={{ marginBottom: 0 }}>
          <Input type="search" placeholder="Serie-número, RUC/DNI o cliente" value={buscar} onChange={(e) => reiniciar(setBuscar)(e.target.value)} aria-label="Buscar" />
          {!atencion && (
            <>
              <SelectorFecha value={desde} max={hasta || undefined} onChange={(v) => reiniciar(setDesde)(v)} aria-label="Desde" />
              <SelectorFecha value={hasta} min={desde || undefined} onChange={(v) => reiniciar(setHasta)(v)} aria-label="Hasta" />
            </>
          )}
          <Selector value={String(tipo)} onChange={(e) => reiniciar(setTipo)(e.target.value)} aria-label="Tipo" opciones={[{ valor: '', texto: 'Todos los tipos' }, ...Object.entries(NOMBRE_TIPO).map(([v, t]) => ({ valor: String(v), texto: t }))]} />
          <Selector value={String(estado)} onChange={(e) => reiniciar(setEstado)(e.target.value)} aria-label="Estado" opciones={[{ valor: '', texto: 'Todos los estados' }, ...Object.entries(ETIQUETA_ESTADO).map(([v, e]) => ({ valor: String(v), texto: e.texto }))]} />
          <Casilla etiqueta="Solo los que requieren atención" checked={atencion} onChange={(e) => reiniciar(setAtencion)(e.target.checked)} />
        </div>
        <Tabla
          filas={data?.data ?? []}
          clave={(c) => c.id}
          vacio="No hay comprobantes con estos filtros."
          columnas={[
            { titulo: 'Comprobante', celda: (c) => <>{NOMBRE_TIPO[c.tipoDoc]} <strong className="font-id">{c.numeroCompleto ?? `${c.serie}-…`}</strong><span className={ui.sub}>{c.ventaId ? `Venta ${c.ventaId} · ` : ''}{c.fechaEmision}{c.modoEnvio === 'resumen' ? ' · resumen diario' : ''}</span></> },
            { titulo: 'Cliente', celda: (c) => <>{c.cliente.razonSocial}<span className={`${ui.sub} font-id`}>{c.cliente.numDoc}</span></> },
            { titulo: 'Total', celda: (c) => dinero(c.tipoDoc === '07' ? `-${c.total}` : c.total, c.moneda), alinear: 'derecha' },
            { titulo: 'Estado', celda: (c) => <EstadoChip c={c} /> },
            {
              titulo: 'Detalle',
              fija: true,
              celda: (c) =>
                c.detalle ? (
                  <Button variant="ghost" size="icon-sm" className="text-primary" aria-label={`Ver detalle de ${NOMBRE_TIPO[c.tipoDoc]} ${c.numeroCompleto ?? ''}`} title="Ver detalle" onClick={() => setNota(c)}>
                    <Eye />
                  </Button>
                ) : null,
            },
            { titulo: '', celda: (c) => <AccionesComprobante c={c} alVer={() => setViendo(c.id)} alVerPdf={() => setPdf(c)} /> },
          ]}
          paginacion={data && { page: data.page, pageSize: data.pageSize, total: data.total, alCambiar: setPage }}
        />
      </div>
      {viendo && <DetalleComprobante id={viendo} alCerrar={() => setViendo(null)} />}
      {nota && (
        <Dialogo
          titulo={`Detalle · ${NOMBRE_TIPO[nota.tipoDoc]} ${nota.numeroCompleto ?? `${nota.serie}-…`}`}
          abierto
          chico
          alCerrar={() => setNota(null)}
          pie={
            <>
              <Boton onClick={() => setNota(null)}>Cerrar</Boton>
              <Boton variante="primario" icono={Eye} onClick={() => (setViendo(nota.id), setNota(null))}>
                Ver comprobante
              </Boton>
            </>
          }
        >
          <div className={ui.pila}>
            <EstadoChip c={nota} />
            <p className="m-0 text-sm leading-relaxed whitespace-pre-line">{nota.detalle}</p>
          </div>
        </Dialogo>
      )}
      {pdf && <HojaFlotante titulo={`${NOMBRE_TIPO[pdf.tipoDoc]} ${pdf.numeroCompleto ?? ''}`} pdf={`/comprobantes/${pdf.id}/pdf`} alCerrar={() => setPdf(null)} />}
    </>
  );
}

export function DetalleComprobante({ id, alCerrar }: { id: number; alCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useSesion();
  const { caja } = useCajaActiva();
  const { data: c } = useQuery({ queryKey: ['comprobante', id], queryFn: () => pedir<ComprobanteDetalleDto>(`/comprobantes/${id}`), refetchInterval: 5000 });
  const [verPdf, setVerPdf] = useState(false);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [corrigiendo, setCorrigiendo] = useState(false);
  const [anulando, setAnulando] = useState(false);
  const [historial, setHistorial] = useState(false);
  const [nota, setNota] = useState<'07' | '08' | null>(null);
  const [anulandoSunat, setAnulandoSunat] = useState(false);
  const [reembolsando, setReembolsando] = useState(false);
  const navegar = useNavigate();

  const refrescar = async () => {
    await qc.invalidateQueries({ queryKey: ['comprobante', id] });
    await qc.invalidateQueries({ queryKey: ['comprobantes'] });
    await qc.invalidateQueries({ queryKey: ['estado-integracion'] });
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

  if (!c) return null;
  const tiene = (a: ComprobanteDetalleDto['acciones'][number]) => c.acciones.includes(a);

  return (
    <Dialogo
      titulo={`${NOMBRE_TIPO[c.tipoDoc]} ${c.numeroCompleto ?? `${c.serie} (por numerar)`}`}
      abierto
      ancho
      alCerrar={alCerrar}
      pie={
        <>
          {tiene('reintentar') && puede('comprobantes.emitir') && <Boton onClick={() => void accion('reintentar', () => pedir(`/comprobantes/${id}/reintentar`, { method: 'POST' }), 'Reintento en curso')} cargando={ocupado === 'reintentar'}>Reintentar</Boton>}
          {tiene('consultar') && puede('comprobantes.emitir') && <Boton onClick={() => void accion('consultar', () => pedir(`/comprobantes/${id}/consultar`, { method: 'POST' }), 'Consulta programada')} cargando={ocupado === 'consultar'}>Consultar a SUNAT</Boton>}
          {tiene('corregir') && puede('comprobantes.corregir') && <Boton onClick={() => setCorrigiendo(true)}>Corregir cliente</Boton>}
          {tiene('anular_interna') && <Boton variante="plano" onClick={() => setAnulando(true)}>Anular venta</Boton>}
          {tiene('nota_credito') && puede('notas.crear') && <Boton onClick={() => setNota('07')}>Nota de crédito</Boton>}
          {tiene('nota_debito') && puede('notas.crear') && <Boton onClick={() => setNota('08')}>Nota de débito</Boton>}
          {tiene('anular') && puede('comprobantes.anular') && <Boton variante="plano" onClick={() => setAnulandoSunat(true)}>Anular ante SUNAT</Boton>}
          {['01', '03'].includes(c.tipoDoc) && c.numeroCompleto && ['aceptado', 'observado', 'pendiente_resumen', 'en_resumen', 'en_proceso'].includes(c.estado) && puede('guias.crear') && <Boton onClick={() => navegar(`/guias?comprobanteId=${id}`)}>Guía de remisión</Boton>}
          {c.reembolsoPendiente && puede('caja.movimientos') && <Boton variante="primario" onClick={() => setReembolsando(true)}>Devolver {dinero(c.reembolsoPendiente, c.moneda)}</Boton>}
          <Boton onClick={alCerrar}>Cerrar</Boton>
        </>
      }
    >
      <div className={ui.pila}>
        <div className={ui.acciones} style={{ justifyContent: 'flex-start' }}>
          <EstadoChip c={c} />
          {c.sunat.codigo && <span className="muted">Código SUNAT {c.sunat.codigo}</span>}
        </div>
        {c.reembolsoPendiente && <Franja tono="aviso">Venta anulada: falta devolver {dinero(c.reembolsoPendiente, c.moneda)} al cliente.</Franja>}
        {c.estado === 'anulacion_en_proceso' && <Franja>Anulación enviada a SUNAT: el stock y la deuda se ajustarán al confirmarse.</Franja>}
        {c.estado === 'pendiente_resumen' && <Franja>Boleta registrada; se declarará a SUNAT en el resumen diario.</Franja>}
        {(c.ultimoError || (c.sunat.descripcion && ['rechazado', 'observado', 'error_validacion'].includes(c.estado))) && (
          <Franja tono={c.estado === 'observado' ? 'aviso' : 'alerta'}>{c.ultimoError ?? c.sunat.descripcion}</Franja>
        )}
        {c.estado === 'observado' && Array.isArray(c.sunat.notas) && c.sunat.notas.length > 0 && (
          <Franja tono="aviso">
            <ul style={{ marginTop: 0 }}>
              {(c.sunat.notas as string[]).map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </Franja>
        )}
        <div className={ui.form}>
          <Campo etiqueta="Cliente" readOnly ancho="mitad" value={`${c.cliente.razonSocial} · ${c.cliente.numDoc}`} />
          <Campo etiqueta="Emisión" readOnly ancho="cuarto" value={c.fechaEmision} />
          <Campo etiqueta="Forma de pago" readOnly ancho="cuarto" value={c.formaPago === 'credito' ? 'Crédito' : 'Contado'} />
        </div>
        <Tabla
          filas={c.items}
          clave={(i) => `${i.descripcion}-${i.precioUnitario}-${i.cantidad}`}
          columnas={[
            { titulo: 'Descripción', celda: (i) => <>{i.descripcion}<span className={ui.sub}>{i.codigo ?? ''} · {i.unidad}</span></> },
            { titulo: 'Cantidad', celda: (i) => cantidad(i.cantidad), alinear: 'derecha' },
            { titulo: 'P. unit.', celda: (i) => Number(i.precioUnitario).toFixed(Number(i.precioUnitario) % 0.01 ? 6 : 2), alinear: 'derecha' },
            { titulo: 'Total', celda: (i) => dinero(i.total, c.moneda), alinear: 'derecha' },
          ]}
        />
        <div className={css.totales}>
          <span>Op. gravada</span>
          <strong className="num">{dinero(c.opGravada, c.moneda)}</strong>
          {Number(c.opExonerada) > 0 && (<><span>Op. exonerada</span><strong className="num">{dinero(c.opExonerada, c.moneda)}</strong></>)}
          {Number(c.opInafecta) > 0 && (<><span>Op. inafecta</span><strong className="num">{dinero(c.opInafecta, c.moneda)}</strong></>)}
          <span>IGV</span>
          <strong className="num">{dinero(c.igv, c.moneda)}</strong>
          <span>Total</span>
          <strong className="num">{dinero(c.total, c.moneda)}</strong>
          {c.totalApi && Number(c.totalApi).toFixed(2) !== Number(c.total).toFixed(2) && (<><span style={{ color: 'var(--danger)' }}>Total según API-PRO</span><strong className="num" style={{ color: 'var(--danger)' }}>{dinero(c.totalApi, c.moneda)}</strong></>)}
        </div>
        {c.cuotas.length > 0 && (
          <span className="muted">Cuotas: {c.cuotas.map((q) => `${q.numero}) ${q.fechaPago} ${dinero(q.monto, c.moneda)}`).join(' · ')}</span>
        )}

        {(tiene('pdf') || tiene('xml') || tiene('cdr')) && (
          <div className={ui.acciones} style={{ justifyContent: 'flex-start', alignItems: 'center' }}>
            {tiene('pdf') && (
              <>
                <Boton icono={FileText} onClick={() => setVerPdf(true)}>Ver PDF</Boton>
              </>
            )}
            {tiene('xml') && <Boton icono={FileCode2} onClick={() => void accion('xml', () => descargar(`/comprobantes/${id}/xml`), 'XML descargado')}>XML</Boton>}
            {tiene('cdr') && <Boton icono={FileDown} onClick={() => void accion('cdr', () => descargar(`/comprobantes/${id}/cdr`), 'CDR descargado')}>CDR</Boton>}
          </div>
        )}

        <Boton variante="plano" chico onClick={() => setHistorial(!historial)}>
          {historial ? 'Ocultar' : 'Ver'} historial de envíos ({c.historial.length})
        </Boton>
        {historial && (
          <Tabla
            filas={c.historial}
            clave={(h) => `${h.fecha}-${h.ruta}`}
            vacio="Aún no se contactó a API-PRO."
            columnas={[
              { titulo: 'Fecha', celda: (h) => fechaHora(h.fecha) },
              { titulo: 'Operación', celda: (h) => <>{h.operacion}<span className={`${ui.sub} font-id`}>{h.metodo} {h.ruta}</span></> },
              { titulo: 'Resultado', celda: (h) => (h.httpStatus ? <Chip tono={h.httpStatus < 300 ? 'ok' : h.httpStatus < 500 ? 'aviso' : 'alerta'}>HTTP {h.httpStatus}</Chip> : <Chip tono="alerta">{h.error ?? 'Sin respuesta'}</Chip>) },
              { titulo: 'ms', celda: (h) => h.duracionMs ?? '—', alinear: 'derecha' },
            ]}
          />
        )}
      </div>
      {anulandoSunat && <AnularDialogo comprobante={c} alCerrar={() => setAnulandoSunat(false)} alAnular={refrescar} />}
      {reembolsando && <ReembolsoDialogo comprobante={c} alCerrar={() => setReembolsando(false)} alReembolsar={refrescar} />}
      {nota === '07' && <NotaCreditoDialogo comprobanteId={id} alCerrar={() => setNota(null)} alEmitir={refrescar} />}
      {nota === '08' && <NotaDebitoDialogo comprobanteId={id} alCerrar={() => setNota(null)} alEmitir={refrescar} />}
      {corrigiendo && <CorregirDialogo comprobante={c} alCerrar={() => setCorrigiendo(false)} alCorregir={refrescar} />}
      {anulando && c.ventaId && caja?.turnoAbierto && <AnularVentaDialogo ventaId={c.ventaId} cajaId={caja.id} alCerrar={() => setAnulando(false)} alAnular={refrescar} />}
      {anulando && !caja?.turnoAbierto && <Dialogo titulo="Anular venta" abierto alCerrar={() => setAnulando(false)}><Franja tono="aviso">Abre la caja: el dinero se devuelve desde la caja abierta.</Franja></Dialogo>}
      {verPdf && <HojaFlotante titulo={`${NOMBRE_TIPO[c.tipoDoc]} ${c.numeroCompleto ?? ''}`} pdf={`/comprobantes/${id}/pdf`} alCerrar={() => setVerPdf(false)} />}
    </Dialogo>
  );
}

function CorregirDialogo({ comprobante, alCerrar, alCorregir }: { comprobante: ComprobanteDetalleDto; alCerrar: () => void; alCorregir: () => Promise<void> }) {
  const toast = useToast();
  const [cliente, setCliente] = useState({ ...comprobante.cliente, direccion: '' });
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const factura = comprobante.tipoDoc === '01';

  const guardar = async () => {
    setEnviando(true);
    setError(null);
    try {
      await pedir(`/comprobantes/${comprobante.id}/corregir`, { method: 'PUT', cuerpo: { cliente: { ...cliente, direccion: cliente.direccion || undefined } } });
      await alCorregir();
      toast('Datos corregidos: el comprobante se vuelve a enviar', 'ok');
      alCerrar();
    } catch (err) {
      setError(err instanceof ErrorHttp && Object.keys(err.campos).length ? Object.values(err.campos).join(' · ') : mensajeError(err));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialogo titulo="Corregir datos del cliente" abierto alCerrar={alCerrar} pie={<><Boton onClick={alCerrar}>Cancelar</Boton><Boton variante="primario" onClick={guardar} cargando={enviando}>Corregir y reenviar</Boton></>}>
      <div className={ui.pila}>
        {error && <Franja tono="alerta">{error}</Franja>}
        <Franja>Solo se corrigen los datos del cliente. Si los productos o importes están mal, anula la venta (si nunca llegó a SUNAT) o emite una nota de crédito.</Franja>
        <div className={ui.form}>
          <Selector etiqueta="Documento" ancho="cuarto" value={cliente.tipoDoc} disabled={factura} onChange={(e) => setCliente({ ...cliente, tipoDoc: e.target.value })} opciones={[{ valor: '6', texto: 'RUC' }, { valor: '1', texto: 'DNI' }, { valor: '4', texto: 'CE' }, { valor: '7', texto: 'Pasaporte' }, { valor: '0', texto: 'Sin documento' }]} />
          <Campo etiqueta="Número" ancho="mitad" className="font-id" value={cliente.numDoc} onChange={(e) => setCliente({ ...cliente, numDoc: e.target.value.trim().toUpperCase() })} />
          <Campo etiqueta="Razón social o nombre" value={cliente.razonSocial} onChange={(e) => setCliente({ ...cliente, razonSocial: e.target.value })} />
          <Campo etiqueta="Dirección" opcional={!factura} value={cliente.direccion} onChange={(e) => setCliente({ ...cliente, direccion: e.target.value })} />
        </div>
      </div>
    </Dialogo>
  );
}

function AnularVentaDialogo({ ventaId, cajaId, alCerrar, alAnular }: { ventaId: number; cajaId: number; alCerrar: () => void; alAnular: () => Promise<void> }) {
  const toast = useToast();
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [pidiendo, setPidiendo] = useState(false);

  const anular = async (token?: string) => {
    setEnviando(true);
    try {
      await pedir(`/ventas/${ventaId}/anular-interna`, { cuerpo: { motivo, cajaId, autorizacionToken: token } });
      await alAnular();
      toast('Venta anulada: se devolvió el stock y el dinero', 'ok');
      alCerrar();
    } catch (err) {
      if (err instanceof ErrorHttp && err.codigo === 'REQUIERE_AUTORIZACION') setPidiendo(true);
      else toast(mensajeError(err), 'error');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialogo titulo={`Anular venta ${ventaId}`} abierto alCerrar={alCerrar} pie={<><Boton onClick={alCerrar}>Cancelar</Boton><Boton variante="peligro" disabled={motivo.trim().length < 5} cargando={enviando} onClick={() => void anular()}>Anular venta</Boton></>}>
      <div className={ui.pila}>
        <Franja tono="aviso">El comprobante nunca llegó a SUNAT: se anula internamente, el stock vuelve al inventario y el dinero sale de la caja abierta.</Franja>
        <div className={ui.form}>
          <Campo etiqueta="Motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
        </div>
      </div>
      {pidiendo && <AutorizacionDialogo accion="anular" alCerrar={() => setPidiendo(false)} alAutorizar={(t) => (setPidiendo(false), void anular(t))} />}
    </Dialogo>
  );
}
