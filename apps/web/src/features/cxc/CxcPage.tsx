import { cobroSchema, type AntiguedadDto, type CobroDto, type CuentaPorCobrarDto, type EstadoCuentaDto, type Moneda, type Pagina } from '@sv/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, CalendarClock, FileText, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { useRetardo } from '../../components/comunes';
import css from '../../components/comunes.module.css';
import { Button } from '@/components/ui/button';
import { AutorizacionDialogo } from '../../components/pin';
import { Boton, Campo, Casilla, Chip, Dialogo, Encabezado, Franja, Pestanas, Selector, Tabla, ui, useToast } from '../../components/ui';
import { useCajaActiva, useMetodosPago } from '../../lib/caja';
import { dinero, fechaHora } from '../../lib/formato';
import { ErrorHttp, mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';

export function CxcPage() {
  return (
    <>
      <Encabezado titulo="Cuentas por cobrar" />
      <Pestanas items={[{ ruta: '/cuentas-por-cobrar', texto: 'Cartera', icono: Wallet }, { ruta: '/cuentas-por-cobrar/antiguedad', texto: 'Antigüedad de la deuda', icono: CalendarClock }]} />
      <Routes>
        <Route index element={<Cartera />} />
        <Route path="antiguedad" element={<Antiguedad />} />
      </Routes>
    </>
  );
}

const ESTADO: Record<CuentaPorCobrarDto['estado'], { texto: string; tono: 'ok' | 'aviso' | 'neutro' | 'info' }> = {
  pendiente: { texto: 'Pendiente', tono: 'info' },
  parcial: { texto: 'Parcial', tono: 'aviso' },
  pagada: { texto: 'Pagada', tono: 'ok' },
  anulada: { texto: 'Anulada', tono: 'neutro' },
};

function Cartera() {
  const { puede } = useSesion();
  const [buscar, setBuscar] = useState('');
  const [vencidas, setVencidas] = useState(false);
  const [moneda, setMoneda] = useState('');
  const [page, setPage] = useState(1);
  const [cliente, setCliente] = useState<{ id: number; accion: 'cobrar' | 'estado' } | null>(null);
  const q = useRetardo(buscar);

  const params = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (q) params.set('q', q);
  if (vencidas) params.set('vencidas', 'true');
  if (moneda) params.set('moneda', moneda);
  const { data } = useQuery({ queryKey: ['cxc', params.toString()], queryFn: () => pedir<Pagina<CuentaPorCobrarDto>>(`/cxc?${params}`), placeholderData: keepPreviousData });

  return (
    <>
      <div className={css.filtros}>
        <Input type="search" placeholder="Cliente o documento" value={buscar} onChange={(e) => (setBuscar(e.target.value), setPage(1))} aria-label="Buscar" />
        <Selector value={String(moneda)} onChange={(e) => (setMoneda(e.target.value), setPage(1))} aria-label="Moneda" opciones={[{ valor: '', texto: 'Ambas monedas' }, { valor: 'PEN', texto: 'Soles' }, { valor: 'USD', texto: 'Dólares' }]} />
        <Casilla etiqueta="Solo vencidas" checked={vencidas} onChange={(e) => (setVencidas(e.target.checked), setPage(1))} />
      </div>
      <Tabla
        filas={data?.data ?? []}
        clave={(c) => c.id}
        vacio="No hay cuentas pendientes."
        columnas={[
          { titulo: 'Cliente', celda: (c) => <>{c.cliente.razonSocial}<span className={`${ui.sub} font-id`}>{c.cliente.numDoc}</span></> },
          { titulo: 'Comprobante', celda: (c) => <><span className="font-id">{c.comprobante ?? '—'}</span><span className={ui.sub}>Venta {c.ventaId}</span></> },
          {
            titulo: 'Cuotas',
            celda: (c) => {
              const prox = c.cuotas.find((x) => x.estado === 'pendiente' || x.estado === 'parcial');
              return prox ? <>Próxima {prox.fechaVencimiento}{prox.diasVencida > 0 && <span className={ui.sub}><Chip tono="alerta">Vencida hace {prox.diasVencida} días</Chip></span>}</> : '—';
            },
          },
          { titulo: 'Total', celda: (c) => dinero(c.total, c.moneda), alinear: 'derecha' },
          { titulo: 'Saldo', celda: (c) => <strong>{dinero(c.saldo, c.moneda)}</strong>, alinear: 'derecha' },
          { titulo: 'Estado', celda: (c) => <Chip tono={ESTADO[c.estado].tono}>{ESTADO[c.estado].texto}</Chip> },
          {
            titulo: '',
            celda: (c) => (
              <div className={ui.acciones}>
                {puede('cxc.cobrar') && <Boton chico variante="primario" icono={Banknote} onClick={() => setCliente({ id: c.cliente.id, accion: 'cobrar' })}>Cobrar</Boton>}
                <Boton chico icono={FileText} onClick={() => setCliente({ id: c.cliente.id, accion: 'estado' })}>Estado de cuenta</Boton>
              </div>
            ),
          },
        ]}
        paginacion={data && { page: data.page, pageSize: data.pageSize, total: data.total, alCambiar: setPage }}
      />
      {cliente?.accion === 'cobrar' && <CobrarDialogo clienteId={cliente.id} alCerrar={() => setCliente(null)} />}
      {cliente?.accion === 'estado' && <EstadoCuentaDialogo clienteId={cliente.id} alCerrar={() => setCliente(null)} alCobrar={() => setCliente({ id: cliente.id, accion: 'cobrar' })} />}
    </>
  );
}

function CobrarDialogo({ clienteId, alCerrar }: { clienteId: number; alCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { caja } = useCajaActiva();
  const { data: metodos = [] } = useMetodosPago();
  const { data: ec } = useQuery({ queryKey: ['estado-cuenta', clienteId], queryFn: () => pedir<EstadoCuentaDto>(`/clientes/${clienteId}/estado-cuenta`) });
  const monedas = ec?.saldos.map((s) => s.moneda) ?? [];
  const [moneda, setMoneda] = useState<Moneda | null>(null);
  const m = moneda ?? monedas[0] ?? 'PEN';
  const saldo = ec?.saldos.find((s) => s.moneda === m);
  const [metodoId, setMetodoId] = useState<number | null>(null);
  const [monto, setMonto] = useState('');
  const [referencia, setReferencia] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [clave] = useState(() => crypto.randomUUID());
  const metodo = metodos.find((x) => x.id === metodoId) ?? metodos[0];

  const cobrar = async () => {
    if (!caja?.turnoAbierto) return setError('Abre la caja para registrar cobros');
    const r = cobroSchema.safeParse({ clienteId, cajaId: caja.id, metodoPagoId: metodo?.id, moneda: m, monto, referencia: referencia || undefined });
    if (!r.success) return setError(r.error.issues[0]?.message ?? 'Datos inválidos');
    setEnviando(true);
    setError(null);
    try {
      const cobro = await pedir<CobroDto>('/cobros', { cuerpo: r.data, idempotente: clave });
      await qc.invalidateQueries({ queryKey: ['cxc'] });
      await qc.invalidateQueries({ queryKey: ['estado-cuenta', clienteId] });
      toast(`Cobro registrado: ${dinero(cobro.monto, cobro.moneda)} aplicado a ${cobro.aplicaciones.length} cuota(s)`, 'ok');
      alCerrar();
    } catch (err) {
      setError(err instanceof ErrorHttp && Object.keys(err.campos).length ? Object.values(err.campos).join(' · ') : mensajeError(err));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialogo titulo={`Cobrar a ${ec?.cliente.razonSocial ?? ''}`} abierto alCerrar={alCerrar} pie={<><Boton onClick={alCerrar}>Cancelar</Boton><Boton variante="primario" onClick={cobrar} cargando={enviando}>Registrar cobro</Boton></>}>
      <div className={ui.pila}>
        {error && <Franja tono="alerta">{error}</Franja>}
        {!caja?.turnoAbierto && <Franja tono="aviso">La caja está cerrada: ábrela para cobrar.</Franja>}
        {saldo && (
          <Franja>
            Saldo {dinero(saldo.saldo, saldo.moneda)}
            {Number(saldo.vencido) > 0 ? ` · vencido ${dinero(saldo.vencido, saldo.moneda)}` : ''}. El pago se aplica primero a la cuota que vence antes.
          </Franja>
        )}
        <div className={ui.form}>
          {monedas.length > 1 && <Selector etiqueta="Deuda en" ancho="mitad" value={m} onChange={(e) => setMoneda(e.target.value as Moneda)} opciones={monedas.map((x) => ({ valor: x, texto: x === 'PEN' ? 'Soles' : 'Dólares' }))} />}
          <Selector etiqueta="Medio" ancho="mitad" value={String(metodo?.id ?? '')} onChange={(e) => setMetodoId(Number(e.target.value))} opciones={metodos.map((x) => ({ valor: String(x.id), texto: x.nombre }))} />
          <Campo etiqueta={`Importe (${m === 'PEN' ? 'S/' : 'US$'})`} ancho="mitad" inputMode="decimal" value={monto} onChange={(e) => setMonto(e.target.value.replace(',', '.'))} ayuda={saldo ? <Button variant="link" className="h-auto p-0 text-xs" onClick={() => setMonto(saldo.saldo)}>Pagar todo</Button> : undefined} />
          {metodo?.requiereReferencia && <Campo etiqueta="N° de operación" ancho="mitad" value={referencia} onChange={(e) => setReferencia(e.target.value)} />}
        </div>
      </div>
    </Dialogo>
  );
}

function EstadoCuentaDialogo({ clienteId, alCerrar, alCobrar }: { clienteId: number; alCerrar: () => void; alCobrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useSesion();
  const { caja } = useCajaActiva();
  const { data: ec } = useQuery({ queryKey: ['estado-cuenta', clienteId], queryFn: () => pedir<EstadoCuentaDto>(`/clientes/${clienteId}/estado-cuenta`) });
  const [anulando, setAnulando] = useState<CobroDto | null>(null);
  const [motivo, setMotivo] = useState('');
  const [pidiendo, setPidiendo] = useState(false);

  const anular = async (token?: string) => {
    if (!anulando || !caja) return;
    try {
      await pedir(`/cobros/${anulando.id}/anular`, { cuerpo: { motivo, cajaId: caja.id, autorizacionToken: token } });
      await qc.invalidateQueries({ queryKey: ['estado-cuenta', clienteId] });
      await qc.invalidateQueries({ queryKey: ['cxc'] });
      toast('Cobro anulado', 'ok');
      setAnulando(null);
      setMotivo('');
    } catch (err) {
      if (err instanceof ErrorHttp && err.codigo === 'REQUIERE_AUTORIZACION') setPidiendo(true);
      else toast(mensajeError(err), 'error');
    }
  };

  if (!ec) return null;
  return (
    <Dialogo titulo={`Estado de cuenta · ${ec.cliente.razonSocial}`} abierto ancho alCerrar={alCerrar} pie={<>{puede('cxc.cobrar') && ec.saldos.length > 0 && <Boton variante="primario" icono={Banknote} onClick={alCobrar}>Cobrar</Boton>}<Boton onClick={alCerrar}>Cerrar</Boton></>}>
      <div className={ui.pila}>
        <div className={ui.acciones} style={{ justifyContent: 'flex-start' }}>
          {ec.saldos.length === 0 && <Chip tono="ok">Sin deuda</Chip>}
          {ec.saldos.map((s) => (
            <Card key={s.moneda} className="gap-1">
              <span className="muted">Saldo {s.moneda}</span>
              <strong className="num">{dinero(s.saldo, s.moneda)}</strong>
              {Number(s.vencido) > 0 && <span className="text-destructive">Vencido {dinero(s.vencido, s.moneda)}</span>}
            </Card>
          ))}
          {ec.cliente.limiteCredito && <span className="muted">Límite: {dinero(ec.cliente.limiteCredito, ec.cliente.monedaCredito ?? 'PEN')}</span>}
        </div>
        <h3>Cuotas</h3>
        <Tabla
          filas={ec.cuentas.flatMap((c) => c.cuotas.map((q) => ({ ...q, cuenta: c })))}
          clave={(q) => q.id}
          vacio="Sin ventas al crédito."
          columnas={[
            { titulo: 'Comprobante', celda: (q) => <span className="font-id">{q.cuenta.comprobante ?? `Venta ${q.cuenta.ventaId}`}</span> },
            { titulo: 'Cuota', celda: (q) => q.numero },
            { titulo: 'Vence', celda: (q) => <>{q.fechaVencimiento}{q.diasVencida > 0 && <span className={ui.sub} style={{ color: 'var(--danger)' }}>hace {q.diasVencida} días</span>}</> },
            { titulo: 'Monto', celda: (q) => dinero(q.monto, q.cuenta.moneda), alinear: 'derecha' },
            { titulo: 'Saldo', celda: (q) => dinero(q.saldo, q.cuenta.moneda), alinear: 'derecha' },
            { titulo: 'Estado', celda: (q) => <Chip tono={ESTADO[q.estado].tono}>{ESTADO[q.estado].texto}</Chip> },
          ]}
        />
        <h3>Cobros</h3>
        <Tabla
          filas={ec.cobros}
          clave={(c) => c.id}
          vacio="Sin cobros."
          columnas={[
            { titulo: 'Fecha', celda: (c) => fechaHora(c.fecha) },
            { titulo: 'Medio', celda: (c) => <>{c.metodo}{c.referencia && <span className={ui.sub}>Op. {c.referencia}</span>}</> },
            { titulo: 'Importe', celda: (c) => dinero(c.monto, c.moneda), alinear: 'derecha' },
            { titulo: 'Estado', celda: (c) => (c.estado === 'registrado' ? <Chip tono="ok">Registrado</Chip> : <Chip>Anulado</Chip>) },
            { titulo: '', celda: (c) => c.estado === 'registrado' && puede('cxc.cobrar') && <Boton chico variante="plano" onClick={() => setAnulando(c)}>Anular</Boton> },
          ]}
        />
        {anulando && (
          <Card className="gap-3">
            <div className={ui.form}>
              <Campo etiqueta={`Motivo para anular el cobro de ${dinero(anulando.monto, anulando.moneda)}`} value={motivo} onChange={(e) => setMotivo(e.target.value)} ayuda={!caja?.turnoAbierto ? 'Abre la caja: el dinero se devuelve desde la caja abierta.' : undefined} />
            </div>
            <div className={ui.acciones} style={{ marginTop: '0.5rem' }}>
              <Boton chico onClick={() => setAnulando(null)}>Cancelar</Boton>
              <Boton chico variante="peligro" disabled={motivo.trim().length < 5 || !caja?.turnoAbierto} onClick={() => void anular()}>Confirmar anulación</Boton>
            </div>
          </Card>
        )}
      </div>
      {pidiendo && <AutorizacionDialogo accion="anular" alCerrar={() => setPidiendo(false)} alAutorizar={(t) => (setPidiendo(false), void anular(t))} />}
    </Dialogo>
  );
}

function Antiguedad() {
  const { data = [] } = useQuery({ queryKey: ['cxc-antiguedad'], queryFn: () => pedir<AntiguedadDto[]>('/cxc/antiguedad') });
  return (
    <Tabla
      filas={data}
      clave={(a) => a.moneda}
      vacio="No hay deuda pendiente."
      columnas={[
        { titulo: 'Moneda', celda: (a) => a.moneda },
        { titulo: 'Por vencer', celda: (a) => dinero(a.porVencer, a.moneda), alinear: 'derecha' },
        { titulo: '1–30 días', celda: (a) => dinero(a.d1a30, a.moneda), alinear: 'derecha' },
        { titulo: '31–60 días', celda: (a) => dinero(a.d31a60, a.moneda), alinear: 'derecha' },
        { titulo: '61–90 días', celda: (a) => dinero(a.d61a90, a.moneda), alinear: 'derecha' },
        { titulo: 'Más de 90', celda: (a) => <span style={{ color: Number(a.mas90) > 0 ? 'var(--danger)' : undefined }}>{dinero(a.mas90, a.moneda)}</span>, alinear: 'derecha' },
        { titulo: 'Total', celda: (a) => <strong>{dinero(a.total, a.moneda)}</strong>, alinear: 'derecha' },
      ]}
    />
  );
}
