import {
  NOMBRE_TIPO_DOC, TIPOS_DOC_TERCERO, errorNumeroDocumento, type AccionAutorizable, type CalculoVenta, type Moneda, type ResultadoBusquedaDocumento,
  type SerieDto, type SucursalDto, type TipoDocTercero, type VentaDto,
} from '@sv/shared';
import { Input } from '@/components/ui/input';
import { useQuery } from '@tanstack/react-query';
import { Banknote, CalendarClock, CheckCircle2, FileText, Percent, Plus, ReceiptText, Search, ShoppingCart, UserRound, Wallet, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useEffect, useMemo, useState } from 'react';
import { AutorizacionDialogo } from '../../components/pin';
import { Alternador, Boton, Campo, Dialogo, Franja, Selector, ui } from '../../components/ui';
import { Label } from '@/components/ui/label';
import { useMetodosPago } from '../../lib/caja';
import { dinero, hoyLima } from '../../lib/formato';
import { ErrorHttp, mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';
import type { Carrito } from './carrito';
import css from './cobro.module.css';
import type { VentaRegistrada } from './ResultadoVenta';

interface Pago {
  metodoPagoId: number;
  moneda: Moneda;
  monto: string;
  montoRecibido: string;
  referencia: string;
}

interface ClienteElegido {
  id: number | null;
  tipoDoc: TipoDocTercero;
  numDoc: string;
  razonSocial: string;
  direccion: string;
}

const sumarDias = (fecha: string, dias: number) => {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

/** Reparte un importe en n cuotas de 2 decimales; la diferencia de redondeo va a la última. */
function generarCuotas(total: number, n: number, cadaDias: number) {
  const base = Math.floor((total / n) * 100) / 100;
  const hoy = hoyLima();
  return Array.from({ length: n }, (_, i) => ({
    monto: (i === n - 1 ? total - base * (n - 1) : base).toFixed(2),
    fechaVencimiento: sumarDias(hoy, cadaDias * (i + 1)),
  }));
}

export function CobroDialogo({
  carrito, cajaId, cotizacion, alCerrar, alRegistrar,
}: { carrito: Carrito; cajaId: number; cotizacion: CalculoVenta & { tipoCambio: string }; alCerrar: () => void; alRegistrar: (v: VentaRegistrada) => void }) {
  const { sesion, puede } = useSesion();
  const moneda = carrito.moneda;
  const tc = Number(cotizacion.tipoCambio);
  const { data: metodos = [] } = useMetodosPago();
  const efectivo = metodos.find((m) => m.tipo === 'efectivo');
  const { data: series = [] } = useQuery({ queryKey: ['series-pos', sesion?.sucursalActiva?.id], queryFn: () => pedir<SerieDto[]>('/series/pos') });
  const { data: sucursales = [] } = useQuery({ queryKey: ['sucursales'], queryFn: () => pedir<SucursalDto[]>('/sucursales') });
  const modoSucursal = sucursales.find((s) => s.id === sesion?.sucursalActiva?.id)?.modoBoletas ?? 'individual';

  const [tipo, setTipo] = useState<'03' | '01'>('03');
  const seriesTipo = series.filter((s) => s.tipoDoc === tipo);
  const [serieId, setSerieId] = useState<number | null>(null);
  const serieElegida = seriesTipo.find((s) => s.id === serieId) ?? seriesTipo.find((s) => s.predeterminada) ?? seriesTipo[0];
  const [modoBoleta, setModoBoleta] = useState<'individual' | 'resumen' | null>(null);

  const [cliente, setCliente] = useState<ClienteElegido>({ id: null, tipoDoc: '1', numDoc: '', razonSocial: '', direccion: '' });
  const [busqueda, setBusqueda] = useState<ResultadoBusquedaDocumento | null>(null);
  const [buscando, setBuscando] = useState(false);

  const [descuento, setDescuento] = useState<{ tipo: 'monto' | 'porcentaje'; valor: string; motivo: string } | null>(null);
  const [formaPago, setFormaPago] = useState<'contado' | 'credito'>('contado');
  const [pagos, setPagos] = useState<Pago[]>([]);
  const [nCuotas, setNCuotas] = useState(1);
  const [cadaDias, setCadaDias] = useState(30);

  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [pidiendo, setPidiendo] = useState<AccionAutorizable | null>(null);
  const [tokens, setTokens] = useState<{ descuento?: string; credito?: string }>({});

  // Totales con descuento (servidor).
  const conDescuento = descuento && Number(descuento.valor) > 0;
  const cotDesc = useQuery({
    queryKey: ['cotizar-desc', moneda, carrito.lineas.map((l) => `${l.producto.id}:${l.cantidad}`).join(','), descuento?.tipo, descuento?.valor],
    queryFn: () => pedir<CalculoVenta>('/ventas/cotizar', { cuerpo: { moneda, items: carrito.lineas.map((l) => ({ productoId: l.producto.id, cantidad: l.cantidad })), descuento: { tipo: descuento!.tipo, valor: descuento!.valor } } }),
    enabled: Boolean(conDescuento),
    retry: false,
  });
  const totales = conDescuento ? cotDesc.data : cotizacion;
  const total = Number(totales?.total ?? 0);

  // Primer pago en efectivo por el total, al abrir y al cambiar el total o la forma de pago.
  useEffect(() => {
    if (!efectivo) return;
    setPagos(formaPago === 'contado' ? [{ metodoPagoId: efectivo.id, moneda, monto: total.toFixed(2), montoRecibido: '', referencia: '' }] : []);
  }, [efectivo, total, formaPago, moneda]);

  const enMonedaVenta = (p: Pago) => (p.moneda === moneda ? Number(p.monto || 0) : moneda === 'PEN' ? Number(p.monto || 0) * tc : Number(p.monto || 0) / tc);
  const pagado = pagos.reduce((a, p) => a + enMonedaVenta(p), 0);
  const falta = Math.round((total - pagado) * 100) / 100;
  const cuotas = useMemo(() => (formaPago === 'credito' && total - pagado > 0 ? generarCuotas(Math.round((total - pagado) * 100) / 100, nCuotas, cadaDias) : []), [formaPago, total, pagado, nCuotas, cadaDias]);
  const totalSoles = moneda === 'PEN' ? total : total * tc;
  const errorDoc = cliente.numDoc ? errorNumeroDocumento(cliente.tipoDoc, cliente.numDoc) : null;

  const buscarCliente = async () => {
    if (!cliente.numDoc || errorDoc) return;
    setBuscando(true);
    try {
      const r = await pedir<ResultadoBusquedaDocumento>(`/clientes/buscar?tipoDoc=${cliente.tipoDoc}&numDoc=${encodeURIComponent(cliente.numDoc)}`);
      setBusqueda(r);
      setCliente((c) => ({ ...c, id: r.id, razonSocial: r.razonSocial ?? c.razonSocial, direccion: r.direccion ?? c.direccion }));
    } catch (err) {
      setError(mensajeError(err));
    } finally {
      setBuscando(false);
    }
  };

  const registrar = async (extra: { descuento?: string; credito?: string } = tokens) => {
    setError(null);
    if (!serieElegida) return setError(`No hay series propias para ${tipo === '01' ? 'facturas' : 'boletas'} en esta sucursal (Configuración → Series).`);
    const conCliente = Boolean(cliente.numDoc);
    const cuerpo = {
      cajaId,
      tipoComprobante: tipo,
      serieId: serieElegida.id,
      modoBoleta: tipo === '03' && modoBoleta ? modoBoleta : undefined,
      moneda,
      cliente: !conCliente ? null : cliente.id ? { id: cliente.id } : { nuevo: { tipoDoc: cliente.tipoDoc, numDoc: cliente.numDoc, razonSocial: cliente.razonSocial, direccion: cliente.direccion || undefined } },
      items: carrito.lineas.map((l) => ({ productoId: l.producto.id, cantidad: l.cantidad })),
      descuento: conDescuento ? { ...descuento!, autorizacionToken: extra.descuento } : undefined,
      formaPago,
      pagos: pagos.filter((p) => Number(p.monto) > 0).map((p) => ({ metodoPagoId: p.metodoPagoId, moneda: p.moneda, monto: Number(p.monto).toFixed(2), montoRecibido: p.montoRecibido ? Number(p.montoRecibido).toFixed(2) : undefined, referencia: p.referencia || undefined })),
      cuotas: formaPago === 'credito' ? cuotas : [],
      autorizacionCredito: extra.credito,
    };
    setEnviando(true);
    try {
      // La clave del carrito hace la operación idempotente: reintentar no duplica la venta.
      const r = await pedir<{ venta: VentaDto; vuelto: Array<{ moneda: Moneda; monto: string }> }>('/ventas', { cuerpo, idempotente: carrito.clave });
      alRegistrar(r);
    } catch (err) {
      if (err instanceof ErrorHttp && err.codigo === 'REQUIERE_AUTORIZACION') {
        setPidiendo((err.cuerpo.detalle as { accion?: AccionAutorizable } | undefined)?.accion ?? 'descuento');
      } else {
        setError(err instanceof ErrorHttp && Object.keys(err.campos).length ? Object.values(err.campos).join(' · ') : mensajeError(err));
      }
    } finally {
      setEnviando(false);
    }
  };

  const listo = totales && !enviando && (formaPago === 'credito' ? Boolean(cliente.numDoc) && cuotas.length > 0 && falta > 0 : Math.abs(falta) < 0.015);
  const pago = (i: number, cambio: Partial<Pago>) => setPagos(pagos.map((p, j) => (j === i ? { ...p, ...cambio } : p)));

  return (
    <Dialogo
      titulo="Cobrar venta"
      abierto
      ancho
      fijo
      alCerrar={alCerrar}
      pie={
        <>
          <Boton onClick={alCerrar} disabled={enviando}>
            Cancelar
          </Boton>
          <Boton variante="primario" onClick={() => void registrar()} cargando={enviando} disabled={!listo}>
            Confirmar venta {totales ? dinero(totales.total, moneda) : ''}
          </Boton>
        </>
      }
    >
      <div className={css.cobro}>
        <section className={css.resumen} aria-label="Resumen de la venta">
          <h3 className={css.titulo}>
            <ShoppingCart aria-hidden /> Resumen
          </h3>
          <ul className={css.productos}>
            {carrito.lineas.map((l) => (
              <li key={l.producto.id}>
                <span className={css.cantidad}>{Number(l.cantidad)}×</span>
                <span className={css.nombre}>{l.producto.nombre}</span>
                <span className="num">{dinero((totales?.lineas ?? []).filter((x) => x.productoId === l.producto.id).reduce((a, x) => a + Number(x.total), 0), moneda)}</span>
              </li>
            ))}
          </ul>
          <dl className={css.cifras}>
            <div>
              <dt>Subtotal</dt>
              <dd className="num">{dinero(totales?.subtotal, moneda)}</dd>
            </div>
            {conDescuento && (
              <div>
                <dt>Descuento</dt>
                <dd className="num">−{dinero(totales?.descuento, moneda)}</dd>
              </div>
            )}
            <div>
              <dt>Op. gravada</dt>
              <dd className="num">{dinero(totales?.opGravada, moneda)}</dd>
            </div>
            <div>
              <dt>IGV</dt>
              <dd className="num">{dinero(totales?.igv, moneda)}</dd>
            </div>
          </dl>
          <div className={css.totalCobro}>
            <span>Total a cobrar</span>
            <strong className="num">{dinero(totales?.total, moneda)}</strong>
          </div>
          {cotDesc.error && <Franja tono="alerta">{mensajeError(cotDesc.error)}</Franja>}
          {!descuento ? (
            <Button variant="link" className={css.enlace} onClick={() => setDescuento({ tipo: 'monto', valor: '', motivo: '' })}>
              <Percent aria-hidden /> Aplicar un descuento
            </Button>
          ) : (
            <div className={ui.form}>
              <Selector etiqueta="Descuento" ancho="mitad" value={descuento.tipo} onChange={(e) => setDescuento({ ...descuento, tipo: e.target.value as 'monto' | 'porcentaje' })} opciones={[{ valor: 'monto', texto: moneda === 'USD' ? 'Monto US$' : 'Monto S/' }, { valor: 'porcentaje', texto: 'Porcentaje %' }]} />
              <Campo etiqueta="Valor" ancho="mitad" inputMode="decimal" value={descuento.valor} onChange={(e) => setDescuento({ ...descuento, valor: e.target.value.replace(',', '.') })} />
              <Campo etiqueta="Motivo" value={descuento.motivo} onChange={(e) => setDescuento({ ...descuento, motivo: e.target.value })} ayuda={!puede('ventas.descuento') ? 'Requerirá la autorización de un supervisor' : undefined} />
              <div className={ui.campo}>
                <Button variant="link" className={css.enlace} onClick={() => setDescuento(null)}>
                  Quitar descuento
                </Button>
              </div>
            </div>
          )}
          <span className={ui.ayuda}>Importes calculados por el servidor (precios con IGV incluido).</span>
        </section>

        <div className={css.pasos}>
          {error && <Franja tono="alerta">{error}</Franja>}

          <section className={css.paso} aria-labelledby="cobro-comprobante">
            <h3 id="cobro-comprobante" className={css.titulo}>
              <ReceiptText aria-hidden /> Comprobante
            </h3>
            <Alternador
              etiqueta="Tipo de comprobante"
              valor={tipo}
              alCambiar={(t) => (setTipo(t), setSerieId(null), t === '01' && setCliente((c) => ({ ...c, tipoDoc: '6', id: null })))}
              opciones={[{ valor: '03' as const, texto: 'Boleta', icono: ReceiptText }, { valor: '01' as const, texto: 'Factura', icono: FileText }]}
            />
            <div className={ui.form}>
              <Selector
                etiqueta="Serie"
                ancho={tipo === '03' ? 'mitad' : 'completo'}
                value={String(serieElegida?.id ?? '')}
                onChange={(e) => setSerieId(Number(e.target.value))}
                opciones={seriesTipo.length ? seriesTipo.map((s) => ({ valor: String(s.id), texto: s.serie })) : [{ valor: '', texto: 'Sin series propias' }]}
              />
              {tipo === '03' && (
                <Selector
                  etiqueta="Envío a SUNAT"
                  ancho="mitad"
                  disabled={!puede('boletas.elegir_modo')}
                  value={modoBoleta ?? modoSucursal}
                  onChange={(e) => setModoBoleta(e.target.value as 'individual' | 'resumen')}
                  opciones={[{ valor: 'individual', texto: 'Individual' }, { valor: 'resumen', texto: 'Resumen diario' }]}
                />
              )}
            </div>
          </section>

          <section className={css.paso} aria-labelledby="cobro-cliente">
            <h3 id="cobro-cliente" className={css.titulo}>
              <UserRound aria-hidden /> Cliente
            </h3>
            <div className={ui.form}>
              <Selector
                etiqueta="Documento"
                ancho="cuarto"
                value={cliente.tipoDoc}
                disabled={tipo === '01'}
                onChange={(e) => (setCliente({ ...cliente, tipoDoc: e.target.value as TipoDocTercero, id: null }), setBusqueda(null))}
                opciones={TIPOS_DOC_TERCERO.map((t) => ({ valor: t, texto: NOMBRE_TIPO_DOC[t] }))}
              />
              <div className={`${ui.campo} ${css.tresCuartos}`}>
                <Label htmlFor="doc-cliente">
                  Número {tipo === '03' && <span className="font-normal text-muted-foreground">(vacío = clientes varios)</span>}
                </Label>
                <div className="flex gap-2">
                  <Input className="tabular-nums" id="doc-cliente" value={cliente.numDoc} inputMode={cliente.tipoDoc === '1' || cliente.tipoDoc === '6' ? 'numeric' : 'text'} aria-invalid={Boolean(errorDoc)} onChange={(e) => (setCliente({ ...cliente, numDoc: e.target.value.trim().toUpperCase(), id: null }), setBusqueda(null))} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void buscarCliente())} />
                  <Boton icono={Search} onClick={buscarCliente} cargando={buscando} disabled={!cliente.numDoc || Boolean(errorDoc)}>
                    <span className="max-sm:sr-only">Buscar</span>
                  </Boton>
                </div>
                {errorDoc && <span className="text-xs text-destructive" role="alert">{errorDoc}</span>}
              </div>
              {cliente.numDoc && (
                <>
                  <Campo etiqueta={cliente.tipoDoc === '6' ? 'Razón social' : 'Nombre'} value={cliente.razonSocial} disabled={Boolean(cliente.id)} onChange={(e) => setCliente({ ...cliente, razonSocial: e.target.value })} />
                  <Campo etiqueta="Dirección" opcional={tipo !== '01'} value={cliente.direccion} disabled={Boolean(cliente.id)} onChange={(e) => setCliente({ ...cliente, direccion: e.target.value })} />
                </>
              )}
            </div>
            {busqueda?.origen === 'local' && <span className={ui.ayuda}>Cliente registrado.</span>}
            {busqueda?.origen === 'externo' && busqueda.fuente && <span className={ui.ayuda}>Datos consultados en {busqueda.fuente}.</span>}
            {busqueda && busqueda.avisos.length > 0 && <Franja tono="aviso">{busqueda.avisos.join(' · ')}</Franja>}
            {tipo === '03' && !cliente.numDoc && totalSoles > 700 && <Franja tono="aviso">Para boletas mayores a S/ 700 identifica al cliente.</Franja>}
          </section>

          <section className={css.paso} aria-labelledby="cobro-pago">
            <h3 id="cobro-pago" className={css.titulo}>
              <Wallet aria-hidden /> Pago
            </h3>
            <Alternador
              etiqueta="Forma de pago"
              valor={formaPago}
              alCambiar={setFormaPago}
              opciones={[
                { valor: 'contado' as const, texto: 'Contado', icono: Banknote },
                { valor: 'credito' as const, texto: 'Crédito', icono: CalendarClock, deshabilitado: !puede('ventas.credito'), titulo: !puede('ventas.credito') ? 'No tienes permiso para vender al crédito' : undefined },
              ]}
            />
            {formaPago === 'credito' && <span className={css.subtitulo}>Cuota inicial (opcional)</span>}
            {pagos.map((p, i) => {
              const m = metodos.find((x) => x.id === p.metodoPagoId);
              const vuelto = m?.tipo === 'efectivo' && p.montoRecibido ? Number(p.montoRecibido) - Number(p.monto || 0) : null;
              return (
                <div key={i} className={css.pago}>
                  {pagos.length > 1 && (
                    <div className={css.pagoCabeza}>
                      <span>Pago {i + 1}</span>
                      <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`Quitar pago ${i + 1}`} title="Quitar pago" onClick={() => setPagos(pagos.filter((_, j) => j !== i))}>
                        <X />
                      </Button>
                    </div>
                  )}
                  <div className={ui.form}>
                    <Selector etiqueta="Medio de pago" ancho="mitad" value={String(p.metodoPagoId)} onChange={(e) => pago(i, { metodoPagoId: Number(e.target.value) })} opciones={metodos.map((x) => ({ valor: String(x.id), texto: x.nombre }))} />
                    <Selector etiqueta="Moneda" ancho="cuarto" value={String(p.moneda)} onChange={(e) => pago(i, { moneda: e.target.value as Moneda })} opciones={[{ valor: 'PEN', texto: 'S/' }, { valor: 'USD', texto: 'US$' }]} />
                    <Campo etiqueta="Monto" ancho="cuarto" inputMode="decimal" value={p.monto} onChange={(e) => pago(i, { monto: e.target.value.replace(',', '.') })} />
                    {m?.tipo === 'efectivo' ? (
                      <Campo etiqueta="Recibido" ancho="mitad" inputMode="decimal" placeholder="¿Con cuánto paga?" value={p.montoRecibido} error={vuelto !== null && vuelto < 0 ? 'El recibido es menor que el monto' : undefined} onChange={(e) => pago(i, { montoRecibido: e.target.value.replace(',', '.') })} />
                    ) : (
                      <Campo etiqueta={m?.requiereReferencia ? 'N° de operación' : 'Referencia'} opcional={!m?.requiereReferencia} ancho="mitad" value={p.referencia} onChange={(e) => pago(i, { referencia: e.target.value })} />
                    )}
                    {vuelto !== null && vuelto > 0 && (
                      <div className={`${ui.campo} ${ui.mitad} ${css.vuelto}`}>
                        <span>Vuelto</span>
                        <strong className="num">{dinero(vuelto.toFixed(2), p.moneda)}</strong>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            <div className={css.pagosPie}>
              <Button
                variant="link"
                className={css.enlace}
                onClick={() => setPagos([...pagos, { metodoPagoId: metodos.find((m) => m.tipo !== 'efectivo')?.id ?? efectivo?.id ?? 0, moneda, monto: Math.max(0, falta).toFixed(2), montoRecibido: '', referencia: '' }])}
              >
                <Plus aria-hidden /> Agregar medio de pago
              </Button>
              {formaPago === 'contado' && (
                <span className={css.estadoPago} data-ok={Math.abs(falta) < 0.015 || undefined}>
                  {Math.abs(falta) < 0.015 && <CheckCircle2 aria-hidden />}
                  {falta > 0.005 ? `Falta ${dinero(falta.toFixed(2), moneda)}` : falta < -0.005 ? `Sobra ${dinero((-falta).toFixed(2), moneda)}` : 'Pagos completos'}
                </span>
              )}
            </div>

            {formaPago === 'credito' && (
              <>
                {!cliente.numDoc && <Franja tono="aviso">El crédito requiere identificar al cliente.</Franja>}
                <div className={ui.form}>
                  <Selector etiqueta="Cuotas" ancho="mitad" value={String(nCuotas)} onChange={(e) => setNCuotas(Number(e.target.value))} opciones={[1, 2, 3, 4, 6, 8, 10, 12].map((n) => ({ valor: String(n), texto: String(n) }))} />
                  <Selector etiqueta="Cada" ancho="mitad" value={String(cadaDias)} onChange={(e) => setCadaDias(Number(e.target.value))} opciones={[7, 15, 30].map((d) => ({ valor: String(d), texto: `${d} días` }))} />
                </div>
                {cuotas.length > 0 && (
                  <dl className={css.cifras}>
                    {cuotas.map((q, i) => (
                      <div key={i}>
                        <dt>
                          Cuota {i + 1} · vence {q.fechaVencimiento}
                        </dt>
                        <dd className="num">{dinero(q.monto, moneda)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </>
            )}
          </section>
        </div>
      </div>
      {pidiendo && (
        <AutorizacionDialogo
          accion={pidiendo}
          alCerrar={() => setPidiendo(null)}
          alAutorizar={(token) => {
            const nuevos = pidiendo === 'credito_excedido' ? { ...tokens, credito: token } : { ...tokens, descuento: token };
            setTokens(nuevos);
            setPidiendo(null);
            void registrar(nuevos);
          }}
        />
      )}
    </Dialogo>
  );
}
