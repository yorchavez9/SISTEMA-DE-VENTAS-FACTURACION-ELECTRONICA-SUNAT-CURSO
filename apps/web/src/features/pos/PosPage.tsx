import type { CalculoVenta, Pagina, ProductoDto } from '@sv/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Banknote, ChevronLeft, DollarSign, LayoutGrid, Loader2, Minus, PackageSearch, Plus, Search, ShoppingCart, Trash2, UserRoundCog, Wallet, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useRetardo } from '../../components/comunes';
import { CambiarCajeroDialogo } from '../../components/pin';
import { Alternador, Boton, Campo, Dialogo, Franja, ui, useToast } from '../../components/ui';
import { Button } from '@/components/ui/button';
import { useCajaActiva } from '../../lib/caja';
import { cantidad as fmtCantidad, dinero } from '../../lib/formato';
import { ErrorHttp, mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';
import { useCategorias } from '../productos/ProductosPage';
import { disponible, useCarrito } from './carrito';
import { CobroDialogo } from './CobroDialogo';
import css from './pos.module.css';
import { ResultadoVenta, type VentaRegistrada } from './ResultadoVenta';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function PosPage() {
  const { sesion } = useSesion();
  const toast = useToast();
  const sucursalId = sesion?.sucursalActiva?.id ?? 0;
  const { caja, cargando } = useCajaActiva();
  const c = useCarrito(sucursalId);
  const [texto, setTexto] = useState('');
  const [categoria, setCategoria] = useState<number | null>(null);
  const [vista, setVista] = useState<'productos' | 'venta'>('productos');
  const [cobrando, setCobrando] = useState(false);
  const [registrada, setRegistrada] = useState<VentaRegistrada | null>(null);
  const [cambiarCajero, setCambiarCajero] = useState(false);
  const [pidiendoCantidad, setPidiendoCantidad] = useState<ProductoDto | null>(null);
  /** Producto recién agregado: su tarjeta da un pequeño salto. */
  const [pulso, setPulso] = useState<number | null>(null);
  const buscador = useRef<HTMLInputElement>(null);
  const q = useRetardo(texto.trim(), 200);
  const { data: categorias = [] } = useCategorias();

  const params = new URLSearchParams({ pageSize: '60' });
  if (q) params.set('q', q);
  if (categoria) params.set('categoriaId', String(categoria));
  const { data: productos } = useQuery({ queryKey: ['pos-productos', params.toString(), sucursalId], queryFn: () => pedir<Pagina<ProductoDto>>(`/productos?${params}`), placeholderData: keepPreviousData });

  // Totales oficiales del servidor (mismo cálculo que se registra).
  const items = c.carrito.lineas.filter((l) => Number(l.cantidad) > 0).map((l) => ({ productoId: l.producto.id, cantidad: l.cantidad }));
  const claveCotizacion = useRetardo(JSON.stringify({ moneda: c.carrito.moneda, items }), 250);
  const cotizacion = useQuery({
    queryKey: ['cotizar', claveCotizacion],
    queryFn: () => pedir<CalculoVenta & { tipoCambio: string }>('/ventas/cotizar', { cuerpo: JSON.parse(claveCotizacion) }),
    enabled: items.length > 0,
    retry: false,
    placeholderData: keepPreviousData,
  });

  // Ctrl+K enfoca el buscador.
  useEffect(() => {
    const alTecla = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        buscador.current?.focus();
      }
    };
    window.addEventListener('keydown', alTecla);
    return () => window.removeEventListener('keydown', alTecla);
  }, []);

  const agregar = (p: ProductoDto) => {
    const enCarrito = c.carrito.lineas.find((l) => l.producto.id === p.id)?.cantidad;
    const libre = disponible(p, enCarrito);
    if (libre !== null && libre < 1 && !p.unidad.fraccionable) return toast(`Solo hay ${fmtCantidad(p.stock)} de ${p.nombre}`, 'error');
    if (p.unidad.fraccionable) return setPidiendoCantidad(p);
    c.agregar(p);
    setPulso(p.id);
  };

  /** Enter con un código exacto (o lector de barras) agrega el producto sin elegirlo. */
  const alEnter = async () => {
    const t = texto.trim();
    if (!t) return;
    try {
      const r = await pedir<ProductoDto[]>(`/productos/buscar-pos?q=${encodeURIComponent(t)}`);
      const exacto = r.find((p) => p.codigo === t.toUpperCase() || p.codigoBarras === t);
      if (exacto) {
        agregar(exacto);
        setTexto('');
      }
    } catch (err) {
      toast(mensajeError(err), 'error');
    }
  };

  if (cargando) return null;
  if (!caja?.turnoAbierto) {
    return (
      <Card className={cn('gap-3', `${css.cerrada}`)}>
        <h2>{caja ? `${caja.nombre} está cerrada` : 'Esta sucursal no tiene cajas'}</h2>
        <span className="muted">Abre la caja para empezar a vender.</span>
        <Button asChild>
          <Link to="/caja">Ir a Caja</Link>
        </Button>
      </Card>
    );
  }

  const errorCotizacion = cotizacion.error instanceof ErrorHttp ? cotizacion.error : null;
  const total = cotizacion.data?.total;
  const n = c.carrito.lineas.length;

  const moneda = c.carrito.moneda;
  const enVenta = new Map(c.carrito.lineas.map((l) => [l.producto.id, l.cantidad]));
  const unidades = c.carrito.lineas.reduce((a, l) => a + (l.producto.unidad.fraccionable ? 1 : Number(l.cantidad) || 0), 0);
  const puedeCobrar = n > 0 && Boolean(total) && !errorCotizacion && !cotizacion.isFetching;
  const lista = productos?.data ?? [];

  return (
    <div className={css.pos} data-vista={vista}>
      <section className={css.catalogo} aria-label="Productos">
        <div className={css.barraBusqueda}>
          <div className={css.campoBusqueda}>
            <Search aria-hidden />
            <Input ref={buscador} placeholder="Buscar o escanear código…" value={texto} autoFocus onChange={(e) => setTexto(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void alEnter())} aria-label="Buscar producto" />
            <kbd className={css.atajo} aria-hidden>
              Ctrl K
            </kbd>
          </div>
          {sesion?.dispositivo && (
            <Button variant="outline" className="h-11 rounded-full [&_svg]:text-primary" onClick={() => setCambiarCajero(true)} title="Cambiar cajero">
              <UserRoundCog aria-hidden />
              <span className="max-sm:hidden">{sesion.operador.nombre}</span>
            </Button>
          )}
        </div>
        <Alternador
          separado
          className={css.categorias}
          etiqueta="Categoría"
          valor={categoria === null ? 'todo' : String(categoria)}
          alCambiar={(v) => setCategoria(v === 'todo' ? null : Number(v))}
          opciones={[{ valor: 'todo', texto: 'Todo', icono: LayoutGrid }, ...categorias.filter((x) => x.activo && x.productos > 0).map((x) => ({ valor: String(x.id), texto: x.nombre }))]}
        />
        <div className={css.rejilla} data-cargando={productos === undefined || undefined}>
          {lista.map((p) => {
            const agotado = p.inventariable && Number(p.stock) <= 0;
            const enUsd = moneda === 'USD' && p.precioVentaUsd;
            const llevado = enVenta.get(p.id);
            return (
              <button
                key={p.id}
                type="button"
                className={cn(css.producto, pulso === p.id && css.agregado)}
                data-agotado={agotado || undefined}
                disabled={agotado}
                onClick={() => agregar(p)}
                onAnimationEnd={() => setPulso(null)}
                aria-label={`${p.nombre}${llevado ? `, ${fmtCantidad(llevado)} en la venta` : ''}`}
              >
                <span className={css.imagen}>
                  {p.imagenUrl ? <img src={p.imagenUrl} alt="" loading="lazy" /> : <span className={css.inicial}>{p.nombre.trim().charAt(0).toUpperCase()}</span>}
                  {llevado && (
                    <span key={llevado} className={css.insignia}>
                      {fmtCantidad(llevado)}
                    </span>
                  )}
                  {agotado && <span className={css.sello}>Agotado</span>}
                </span>
                <span className={css.productoNombre}>{p.nombre}</span>
                <span className={css.productoPie}>
                  <strong className="num">{dinero(enUsd ? p.precioVentaUsd : p.precioVenta, enUsd ? 'USD' : 'PEN')}</strong>
                  <span>{p.inventariable ? `${fmtCantidad(p.stock)} ${p.unidad.codigoSunat}` : 'Servicio'}</span>
                </span>
              </button>
            );
          })}
          {productos && lista.length === 0 && (
            <div className={css.sinResultados}>
              <PackageSearch aria-hidden />
              <p>{q ? `No hay productos que coincidan con “${q}”.` : 'Todavía no hay productos en esta categoría.'}</p>
            </div>
          )}
        </div>
      </section>

      <aside className={css.ticket} aria-label="Venta en curso">
        <Button variant="link" className={css.volver} onClick={() => setVista('productos')}>
          <ChevronLeft aria-hidden /> Seguir agregando
        </Button>
        <div className={css.ticketCabeza}>
          <div>
            <h2>
              Venta actual {n > 0 && <span className={css.contador}>{n}</span>}
            </h2>
            <span className={css.meta}>
              {caja.nombre} · {sesion?.operador.nombre}
            </span>
          </div>
          {n > 0 && (
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => c.vaciar()}>
              <Trash2 aria-hidden /> Vaciar
            </Button>
          )}
        </div>
        <Alternador
          etiqueta="Moneda"
          valor={moneda}
          alCambiar={(m) => c.fijarMoneda(m)}
          opciones={[{ valor: 'PEN' as const, texto: 'Soles', icono: Banknote }, { valor: 'USD' as const, texto: 'Dólares', icono: DollarSign }]}
        />
        <div className={css.lineas}>
          {n === 0 && (
            <div className={css.vacia}>
              <span className={css.vaciaIcono}>
                <ShoppingCart aria-hidden />
              </span>
              <strong>La venta está vacía</strong>
              <p>Toca un producto o escanea su código para agregarlo.</p>
            </div>
          )}
          {c.carrito.lineas.map((l) => {
            const linea = cotizacion.data?.lineas.filter((x) => x.productoId === l.producto.id) ?? [];
            const importe = linea.reduce((a, x) => a + Number(x.total), 0);
            const precio = linea[0]?.precioLista;
            const tope = l.producto.inventariable ? Number(l.producto.stock) : Infinity;
            return (
              <div key={l.producto.id} className={css.linea}>
                <div className={css.lineaTexto}>
                  <strong>{l.producto.nombre}</strong>
                  <span>
                    {precio ? `${dinero(precio, moneda)} c/u` : l.producto.codigo} · {l.producto.unidad.codigoSunat}
                  </span>
                </div>
                <span className={`num ${css.importe}`}>{linea.length ? dinero(importe, moneda) : '…'}</span>
                <div className={css.lineaControles}>
                  {l.producto.unidad.fraccionable ? (
                    <Input className={css.cantidad} inputMode="decimal" value={l.cantidad} aria-label={`Cantidad de ${l.producto.nombre}`} onChange={(e) => c.fijarCantidad(l.producto.id, e.target.value.replace(',', '.'))} />
                  ) : (
                    <div className={css.paso}>
                      <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Menos" onClick={() => (Number(l.cantidad) <= 1 ? c.quitar(l.producto.id) : c.fijarCantidad(l.producto.id, String(Number(l.cantidad) - 1)))}>
                        <Minus />
                      </Button>
                      <span key={l.cantidad} className="num">
                        {fmtCantidad(l.cantidad)}
                      </span>
                      <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Más" disabled={Number(l.cantidad) >= tope} onClick={() => c.fijarCantidad(l.producto.id, String(Number(l.cantidad) + 1))}>
                        <Plus />
                      </Button>
                    </div>
                  )}
                  <Button variant="ghost" size="icon-sm" className="ml-auto text-muted-foreground" aria-label={`Quitar ${l.producto.nombre}`} title="Quitar" onClick={() => c.quitar(l.producto.id)}>
                    <X />
                  </Button>
                </div>
                {Number(l.cantidad) > tope && <span className={css.falta}>Solo hay {fmtCantidad(l.producto.stock)}</span>}
              </div>
            );
          })}
        </div>
        {errorCotizacion && <Franja tono="alerta">{errorCotizacion.message}</Franja>}
        {n > 0 && cotizacion.data && (
          <dl className={css.resumen}>
            {Number(cotizacion.data.opGravada) > 0 && (
              <div>
                <dt>Op. gravada</dt>
                <dd className="num">{dinero(cotizacion.data.opGravada, moneda)}</dd>
              </div>
            )}
            {Number(cotizacion.data.opExonerada) > 0 && (
              <div>
                <dt>Op. exonerada</dt>
                <dd className="num">{dinero(cotizacion.data.opExonerada, moneda)}</dd>
              </div>
            )}
            {Number(cotizacion.data.opInafecta) > 0 && (
              <div>
                <dt>Op. inafecta</dt>
                <dd className="num">{dinero(cotizacion.data.opInafecta, moneda)}</dd>
              </div>
            )}
            <div>
              <dt>IGV</dt>
              <dd className="num">{dinero(cotizacion.data.igv, moneda)}</dd>
            </div>
            {moneda === 'USD' && (
              <div>
                <dt>Tipo de cambio</dt>
                <dd className="num">{cotizacion.data.tipoCambio}</dd>
              </div>
            )}
          </dl>
        )}
        <div className={css.total}>
          <span>Total</span>
          <strong className="num">{total ? dinero(total, moneda) : dinero(0, moneda)}</strong>
        </div>
        <Button size="lg" className={css.cobrar} disabled={!puedeCobrar} onClick={() => setCobrando(true)}>
          {cotizacion.isFetching && n > 0 ? <Loader2 className="animate-spin" aria-hidden /> : <Wallet aria-hidden />}
          Cobrar {total ? dinero(total, moneda) : ''}
        </Button>
      </aside>

      {/* Teléfono: la venta siempre a mano, abajo. */}
      <div className={css.barraMovil} aria-hidden={vista === 'venta' || undefined}>
        <div>
          <strong className="num">{total && n ? dinero(total, moneda) : dinero(0, moneda)}</strong>
          <span>{n ? `${fmtCantidad(unidades)} ${unidades === 1 ? 'producto' : 'productos'}` : 'Venta vacía'}</span>
        </div>
        <Button size="lg" className="rounded-full" disabled={!n} onClick={() => setVista('venta')}>
          <ShoppingCart aria-hidden /> Ver venta
          {n > 0 && <span className={css.barraContador}>{n}</span>}
        </Button>
      </div>

      {cobrando && cotizacion.data && (
        <CobroDialogo
          carrito={c.carrito}
          cajaId={caja.id}
          cotizacion={cotizacion.data}
          alCerrar={() => setCobrando(false)}
          alRegistrar={(v) => {
            setCobrando(false);
            setRegistrada(v);
            c.reiniciar();
            setVista('productos');
          }}
        />
      )}
      {registrada && <ResultadoVenta registrada={registrada} alCerrar={() => (setRegistrada(null), buscador.current?.focus())} />}
      {cambiarCajero && <CambiarCajeroDialogo alCerrar={() => setCambiarCajero(false)} />}
      {pidiendoCantidad && <CantidadDialogo producto={pidiendoCantidad} alCerrar={() => setPidiendoCantidad(null)} alAceptar={(q) => (c.agregar(pidiendoCantidad, q), setPidiendoCantidad(null))} />}
    </div>
  );
}

/** Cantidad para unidades fraccionables (metros, kilos…). */
function CantidadDialogo({ producto, alCerrar, alAceptar }: { producto: ProductoDto; alCerrar: () => void; alAceptar: (q: string) => void }) {
  const [valor, setValor] = useState('');
  const ok = /^\d{1,8}(\.\d{1,3})?$/.test(valor) && Number(valor) > 0 && (!producto.inventariable || Number(valor) <= Number(producto.stock));
  return (
    <Dialogo titulo={producto.nombre} abierto alCerrar={alCerrar} pie={<><Boton onClick={alCerrar}>Cancelar</Boton><Boton variante="primario" disabled={!ok} onClick={() => alAceptar(valor)}>Agregar</Boton></>}>
      <div className={ui.form}>
        <Campo
          etiqueta={`Cantidad (${producto.unidad.nombre})`}
          inputMode="decimal"
          autoFocus
          value={valor}
          onChange={(e) => setValor(e.target.value.replace(',', '.'))}
          onKeyDown={(e) => e.key === 'Enter' && ok && alAceptar(valor)}
          ayuda={`Hasta 3 decimales${producto.inventariable ? ` · disponible ${fmtCantidad(producto.stock)}` : ''}`}
        />
      </div>
    </Dialogo>
  );
}
