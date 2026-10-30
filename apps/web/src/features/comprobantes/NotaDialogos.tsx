import { MOTIVOS_NC, MOTIVOS_ND, notaCreditoSchema, notaDebitoSchema, type MotivoNc, type MotivoNd, type SaldoNotaCreditoDto } from '@sv/shared';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Boton, Campo, Casilla, Dialogo, Franja, Selector, Tabla, ui, useToast } from '../../components/ui';
import { useCajaActiva, useMetodosPago } from '../../lib/caja';
import { cantidad, dinero, hoyLima } from '../../lib/formato';
import { ErrorHttp, mensajeError, pedir } from '../../lib/http';
import { Input } from '@/components/ui/input';

const mensaje = (err: unknown) => (err instanceof ErrorHttp && Object.keys(err.campos).length ? Object.values(err.campos).join(' · ') : mensajeError(err));

export function NotaCreditoDialogo({ comprobanteId, alCerrar, alEmitir }: { comprobanteId: number; alCerrar: () => void; alEmitir: () => Promise<void> }) {
  const toast = useToast();
  const { caja } = useCajaActiva();
  const { data: metodos = [] } = useMetodosPago();
  const { data: s } = useQuery({ queryKey: ['saldo-nota', comprobanteId], queryFn: () => pedir<SaldoNotaCreditoDto>(`/comprobantes/${comprobanteId}/saldo-nota`) });
  const [motivo, setMotivo] = useState<MotivoNc>('07');
  const [descripcion, setDescripcion] = useState('');
  const [cantidades, setCantidades] = useState<Record<number, string>>({});
  const [devuelveStock, setDevuelveStock] = useState(true);
  const [reintegro, setReintegro] = useState<'caja' | 'cxc' | 'ninguno'>('caja');
  const [metodoId, setMetodoId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [clave] = useState(() => crypto.randomUUID());

  if (!s) return null;
  const parcial = motivo === '07';
  const yaAcreditado = Number(s.acreditado) > 0;
  const estimado = parcial
    ? s.lineas.reduce((a, l) => a + Number(cantidades[l.id] || 0) * Number(l.precioUnitario), 0)
    : Number(s.saldo);
  const metodo = metodoId ?? metodos.find((m) => m.tipo === 'efectivo')?.id ?? metodos[0]?.id;

  const emitir = async () => {
    setError(null);
    const r = notaCreditoSchema.safeParse({
      comprobanteAfectadoId: comprobanteId,
      codMotivo: motivo,
      desMotivo: descripcion || MOTIVOS_NC[motivo],
      items: parcial ? Object.entries(cantidades).filter(([, q]) => Number(q) > 0).map(([id, q]) => ({ comprobanteItemId: Number(id), cantidad: q })) : undefined,
      devuelveStock,
      reintegro: reintegro === 'caja' ? { tipo: 'caja', cajaId: caja?.id, metodoPagoId: metodo } : { tipo: reintegro },
    });
    if (!r.success) return setError(r.error.issues[0]?.message ?? 'Datos inválidos');
    setEnviando(true);
    try {
      await pedir('/notas-credito', { cuerpo: r.data, idempotente: clave });
      await alEmitir();
      toast('Nota de crédito registrada: se enviará a SUNAT', 'ok');
      alCerrar();
    } catch (err) {
      setError(mensaje(err));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialogo
      titulo={`Nota de crédito · ${s.numero}`}
      abierto
      ancho
      fijo
      alCerrar={alCerrar}
      pie={<><Boton onClick={alCerrar}>Cancelar</Boton><Boton variante="primario" onClick={emitir} cargando={enviando} disabled={!s.seriesNc.length || Number(s.saldo) <= 0}>Emitir nota {dinero(estimado.toFixed(2), s.moneda)}</Boton></>}
    >
      <div className={ui.pila}>
        {error && <Franja tono="alerta">{error}</Franja>}
        {!s.seriesNc.length && <Franja tono="alerta">No hay series propias de nota de crédito para este tipo de comprobante en la sucursal (Configuración → Series).</Franja>}
        <span className="muted">
          Total {dinero(s.total, s.moneda)} · ya acreditado {dinero(s.acreditado, s.moneda)} · <strong>saldo {dinero(s.saldo, s.moneda)}</strong>
        </span>
        <div className={ui.form}>
          <Selector
            etiqueta="Motivo"
            ancho="mitad"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value as MotivoNc)}
            opciones={Object.entries(MOTIVOS_NC).map(([v, t]) => ({ valor: v, texto: `${v} · ${t}` }))}
          />
          <Campo etiqueta="Descripción" ancho="mitad" placeholder={MOTIVOS_NC[motivo]} value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
        </div>
        {!parcial && yaAcreditado && <Franja tono="aviso">El comprobante ya tiene notas de crédito: solo queda la devolución por ítem.</Franja>}
        {parcial && (
          <Tabla
            filas={s.lineas}
            clave={(l) => l.id}
            columnas={[
              { titulo: 'Producto', celda: (l) => <>{l.descripcion}<span className={ui.sub}>{dinero(l.precioUnitario, s.moneda)} c/u · {l.unidad}</span></> },
              { titulo: 'Vendido', celda: (l) => cantidad(l.cantidad), alinear: 'derecha' },
              { titulo: 'Disponible', celda: (l) => cantidad(l.disponible), alinear: 'derecha' },
              { titulo: 'Devolver', fija: true, celda: (l) => <Input className="w-24" inputMode="decimal" disabled={Number(l.disponible) <= 0} value={cantidades[l.id] ?? ''} aria-label={`Devolver ${l.descripcion}`} onChange={(e) => setCantidades({ ...cantidades, [l.id]: e.target.value.replace(',', '.') })} /> },
            ]}
          />
        )}
        <Casilla etiqueta="La mercadería vuelve al stock de esta sucursal" checked={devuelveStock} onChange={(e) => setDevuelveStock(e.target.checked)} />
        <div className={ui.form}>
          <Selector
            etiqueta="Reintegro al cliente"
            ancho="mitad"
            value={reintegro}
            onChange={(e) => setReintegro(e.target.value as typeof reintegro)}
            opciones={[
              { valor: 'caja', texto: 'Devolver el dinero desde la caja' },
              ...(s.formaPago === 'credito' && s.saldoCxc && Number(s.saldoCxc) > 0 ? [{ valor: 'cxc', texto: `Rebajar la deuda (saldo ${dinero(s.saldoCxc, s.moneda)})` }] : []),
              { valor: 'ninguno', texto: 'Sin reintegro' },
            ]}
          />
          {reintegro === 'caja' && <Selector etiqueta="Medio" ancho="mitad" value={String(metodo ?? '')} onChange={(e) => setMetodoId(Number(e.target.value))} opciones={metodos.map((m) => ({ valor: String(m.id), texto: m.nombre }))} />}
        </div>
        {reintegro === 'caja' && !caja?.turnoAbierto && <Franja tono="aviso">Abre la caja para devolver el dinero.</Franja>}
      </div>
    </Dialogo>
  );
}

interface ConceptoNd {
  descripcion: string;
  cantidad: string;
  precioUnitario: string;
  tipAfeIgv: '10' | '20' | '30';
}

export function NotaDebitoDialogo({ comprobanteId, alCerrar, alEmitir }: { comprobanteId: number; alCerrar: () => void; alEmitir: () => Promise<void> }) {
  const toast = useToast();
  const { caja } = useCajaActiva();
  const { data: metodos = [] } = useMetodosPago();
  const { data: s } = useQuery({ queryKey: ['saldo-nota', comprobanteId], queryFn: () => pedir<SaldoNotaCreditoDto>(`/comprobantes/${comprobanteId}/saldo-nota`) });
  const [motivo, setMotivo] = useState<MotivoNd>('02');
  const [descripcion, setDescripcion] = useState('');
  const [conceptos, setConceptos] = useState<ConceptoNd[]>([{ descripcion: '', cantidad: '1', precioUnitario: '', tipAfeIgv: '10' }]);
  const [cobro, setCobro] = useState<'caja' | 'cxc' | 'ninguno'>('caja');
  const [metodoId, setMetodoId] = useState<number | null>(null);
  const [vence, setVence] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [clave] = useState(() => crypto.randomUUID());

  if (!s) return null;
  const total = conceptos.reduce((a, c) => a + Number(c.cantidad || 0) * Number(c.precioUnitario || 0), 0);
  const metodo = metodoId ?? metodos.find((m) => m.tipo === 'efectivo')?.id ?? metodos[0]?.id;
  const fijar = (i: number, cambio: Partial<ConceptoNd>) => setConceptos(conceptos.map((c, j) => (j === i ? { ...c, ...cambio } : c)));

  const emitir = async () => {
    setError(null);
    const r = notaDebitoSchema.safeParse({
      comprobanteAfectadoId: comprobanteId,
      codMotivo: motivo,
      desMotivo: descripcion || MOTIVOS_ND[motivo],
      items: conceptos,
      cobro: cobro === 'caja' ? { tipo: 'caja', cajaId: caja?.id, metodoPagoId: metodo } : cobro === 'cxc' ? { tipo: 'cxc', fechaVencimiento: vence } : { tipo: 'ninguno' },
    });
    if (!r.success) return setError(r.error.issues[0]?.message ?? 'Datos inválidos');
    setEnviando(true);
    try {
      await pedir('/notas-debito', { cuerpo: r.data, idempotente: clave });
      await alEmitir();
      toast('Nota de débito registrada: se enviará a SUNAT', 'ok');
      alCerrar();
    } catch (err) {
      setError(mensaje(err));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialogo
      titulo={`Nota de débito · ${s.numero}`}
      abierto
      ancho
      fijo
      alCerrar={alCerrar}
      pie={<><Boton onClick={alCerrar}>Cancelar</Boton><Boton variante="primario" onClick={emitir} cargando={enviando} disabled={!s.seriesNd.length}>Emitir nota {dinero(total.toFixed(2), s.moneda)}</Boton></>}
    >
      <div className={ui.pila}>
        {error && <Franja tono="alerta">{error}</Franja>}
        {!s.seriesNd.length && <Franja tono="alerta">No hay series propias de nota de débito para este tipo de comprobante en la sucursal.</Franja>}
        <div className={ui.form}>
          <Selector etiqueta="Motivo" ancho="mitad" value={motivo} onChange={(e) => setMotivo(e.target.value as MotivoNd)} opciones={Object.entries(MOTIVOS_ND).map(([v, t]) => ({ valor: v, texto: `${v} · ${t}` }))} />
          <Campo etiqueta="Descripción" ancho="mitad" placeholder={MOTIVOS_ND[motivo]} value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
        </div>
        <Tabla
          filas={conceptos}
          clave={(_, i) => i}
          columnas={[
            { titulo: 'Concepto', celda: (c, i) => <Input value={c.descripcion} aria-label="Concepto" onChange={(e) => fijar(i, { descripcion: e.target.value })} /> },
            { titulo: 'Cantidad', celda: (c, i) => <Input className="w-20" inputMode="decimal" value={c.cantidad} aria-label="Cantidad" onChange={(e) => fijar(i, { cantidad: e.target.value.replace(',', '.') })} /> },
            { titulo: `Precio ${s.moneda === 'USD' ? 'US$' : 'S/'} (con IGV)`, fija: true, celda: (c, i) => <Input className="w-28" inputMode="decimal" value={c.precioUnitario} aria-label="Precio" onChange={(e) => fijar(i, { precioUnitario: e.target.value.replace(',', '.') })} /> },
            {
              titulo: 'IGV',
              celda: (c, i) => <Selector value={String(c.tipAfeIgv)} aria-label="Afectación" onChange={(e) => fijar(i, { tipAfeIgv: e.target.value as ConceptoNd['tipAfeIgv'] })} opciones={[{ valor: '10', texto: 'Gravado' }, { valor: '20', texto: 'Exonerado' }, { valor: '30', texto: 'Inafecto' }]} />,
            },
            { titulo: '', celda: (_, i) => conceptos.length > 1 && <Boton chico variante="plano" icono={Trash2} aria-label="Quitar" onClick={() => setConceptos(conceptos.filter((_, j) => j !== i))} /> },
          ]}
        />
        <div>
          <Boton chico icono={Plus} onClick={() => setConceptos([...conceptos, { descripcion: '', cantidad: '1', precioUnitario: '', tipAfeIgv: '10' }])}>Agregar concepto</Boton>
        </div>
        <div className={ui.form}>
          <Selector
            etiqueta="Cobro del cargo"
            ancho="mitad"
            value={cobro}
            onChange={(e) => setCobro(e.target.value as typeof cobro)}
            opciones={[
              { valor: 'caja', texto: 'Cobrar ahora en caja' },
              ...(s.formaPago === 'credito' ? [{ valor: 'cxc', texto: 'Agregar como cuota a la deuda' }] : []),
              { valor: 'ninguno', texto: 'Cobrar después' },
            ]}
          />
          {cobro === 'caja' && <Selector etiqueta="Medio" ancho="mitad" value={String(metodo ?? '')} onChange={(e) => setMetodoId(Number(e.target.value))} opciones={metodos.map((m) => ({ valor: String(m.id), texto: m.nombre }))} />}
          {cobro === 'cxc' && <Campo etiqueta="Vence" type="date" ancho="mitad" min={hoyLima()} value={vence} onChange={(e) => setVence(e.target.value)} />}
        </div>
      </div>
    </Dialogo>
  );
}
