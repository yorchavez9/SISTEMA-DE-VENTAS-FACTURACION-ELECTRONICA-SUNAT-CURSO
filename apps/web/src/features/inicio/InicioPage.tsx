import { ETIQUETA_ESTADO, type DashboardDto, type EstadoComprobante } from '@sv/shared';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, BarChart3, CheckCircle2, Clock, Coins, Package, ReceiptText, ShoppingCart, TrendingDown, TrendingUp, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Chip, Franja, Tabla } from '../../components/ui';
import { cantidad, dinero } from '../../lib/formato';
import { pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';
import css from './inicio.module.css';

// Inicio con la composición de ferretería (modules/inicio.js): saludo con accesos, cuatro indicadores,
// fila de gráficos y "Ventas recientes" | "Por reponer" + "Comprobantes de hoy". Todo de la BD local.

const diaCorto = (f: string) => new Intl.DateTimeFormat('es-PE', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${f}T12:00:00Z`));
const diaLargo = (f: string) => new Intl.DateTimeFormat('es-PE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${f}T12:00:00Z`));
const compacto = (n: number) => new Intl.NumberFormat('es-PE', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const fechaHoy = () => {
  const t = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const saludo = () => {
  const h = Number(new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  return h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
};
const hora = (iso: string) => new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

/** Indicador de ferretería: icono en un cuadrado naranja, nombre gris, cifra grande y nota o variación. */
function Indicador({ icono: Icono, nombre, valor, destacado, pie }: { icono: LucideIcon; nombre: string; valor: ReactNode; destacado?: boolean; pie?: ReactNode }) {
  return (
    <div className={css.dato}>
      <div className={css.indicadorCabeza}>
        <span className={css.indicadorIcono} aria-hidden>
          <Icono />
        </span>
        <span className={css.datoNombre}>{nombre}</span>
      </div>
      <span className={destacado ? `${css.datoValor} ${css.destacado}` : css.datoValor}>{valor}</span>
      {pie}
    </div>
  );
}

function Seccion({ titulo, desc, children }: { titulo: string; desc?: string; children: ReactNode }) {
  return (
    <section className={css.seccion}>
      <h2>{titulo}</h2>
      {desc && <p className={css.desc}>{desc}</p>}
      {children}
    </section>
  );
}

function FilaAhora({ icono: Icono, a, texto, detalle }: { icono: LucideIcon; a: string; texto: string; detalle: string }) {
  return (
    <li>
      <Link to={a} className={css.ahoraEnlace}>
        <span className={css.indicadorIcono} aria-hidden>
          <Icono />
        </span>
        <span className={css.ahoraTexto}>
          <strong>{texto}</strong>
          <span>{detalle}</span>
        </span>
      </Link>
    </li>
  );
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

export function InicioPage() {
  const { sesion, puede } = useSesion();
  const navegar = useNavigate();
  const { data: d } = useQuery({
    queryKey: ['dashboard', sesion?.sucursalActiva?.id],
    queryFn: () => pedir<DashboardDto>('/dashboard'),
    refetchInterval: 60_000,
  });
  const [tabla, setTabla] = useState(false);

  const accesos = [
    { ruta: '/vender', texto: 'Vender', icono: ShoppingCart, permiso: 'ventas.crear' },
    { ruta: '/productos', texto: 'Productos', icono: Package, permiso: 'productos.ver' },
    { ruta: '/comprobantes', texto: 'Comprobantes', icono: ReceiptText, permiso: 'comprobantes.ver' },
    { ruta: '/reportes', texto: 'Reportes', icono: BarChart3, permiso: 'reportes.ver' },
  ].filter((a) => puede(a.permiso));

  return (
    <div className={css.pagina}>
      <section className={css.saludo}>
        <div>
          <h2 className={css.saludoTitulo}>
            {saludo()}
            {sesion ? `, ${sesion.operador.nombre}` : ''}
          </h2>
          <p className={css.saludoSub}>
            <span>{fechaHoy()}</span>
            {sesion?.sucursalActiva && <span>{sesion.sucursalActiva.nombre}</span>}
          </p>
        </div>
        <div className={css.accesos}>
          {accesos.map((a) => (
            <Button key={a.ruta} variant="outline" className="rounded-full" onClick={() => navegar(a.ruta)}>
              <a.icono className="text-primary" aria-hidden /> {a.texto}
            </Button>
          ))}
        </div>
      </section>

      {sesion && sesion.sucursales.length === 0 && (
        <Franja tono="aviso">
          Aún no hay sucursales. Crea o importa la primera para empezar a vender. {puede('config.ver') && <Link to="/configuracion/sucursales">Ir a Configuración → Sucursales</Link>}
        </Franja>
      )}

      {!d ? (
        <p className={css.ayuda}>Cargando resumen…</p>
      ) : (
        <>
          <section className={css.resumen}>
            <Indicador
              icono={Coins}
              destacado
              nombre={`Ventas de hoy · ${plural(d.ventas.n, 'venta', 'ventas')}`}
              valor={dinero(d.ventas.totalPen)}
              pie={<Variacion valor={d.ventas.variacion} />}
            />
            <Indicador icono={Package} nombre="Productos registrados" valor={d.productos} pie={<span className={css.nota}>{d.ventas.ticketPromedio ? `Ticket promedio de hoy: ${dinero(d.ventas.ticketPromedio)}` : 'Activos en el catálogo'}</span>} />
            <Indicador icono={TriangleAlert} nombre="Productos con stock bajo" valor={d.stockBajo.length} pie={<span className={css.nota}>{d.stockBajo.length ? 'En su mínimo o por debajo' : 'Todo con stock suficiente'}</span>} />
            <Indicador
              icono={ReceiptText}
              nombre="Comprobantes de hoy"
              valor={d.comprobantes.aceptadosHoy}
              pie={
                <span className={css.nota}>
                  {d.comprobantes.problemas ? `${d.comprobantes.problemas} con problema` : d.comprobantes.pendientes + d.comprobantes.enProceso ? `${d.comprobantes.pendientes + d.comprobantes.enProceso} esperando a SUNAT` : 'Sin pendientes'}
                </span>
              }
            />
          </section>

          <div className={css.graficos}>
            <section className={css.seccion}>
              <div className={css.graficoCabeza}>
                <div>
                  <h2>Ventas netas por día</h2>
                  <p className={css.desc}>Últimos 14 días, en soles. Las notas de crédito restan.</p>
                </div>
                <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setTabla(!tabla)}>
                  {tabla ? 'Ver gráfico' : 'Ver tabla'}
                </Button>
              </div>
              {tabla ? (
                <Tabla
                  filas={[...d.serieDiaria].reverse()}
                  clave={(f) => f.fecha}
                  columnas={[
                    { titulo: 'Día', celda: (f) => diaLargo(f.fecha) },
                    { titulo: 'Ventas', celda: (f) => f.n, alinear: 'derecha' },
                    { titulo: 'Neto', celda: (f) => dinero(f.totalPen), alinear: 'derecha' },
                  ]}
                />
              ) : (
                <ColumnasDiarias serie={d.serieDiaria} />
              )}
            </section>
            <Seccion titulo="Más vendidos" desc="Últimos 7 días, por importe.">
              {d.topProductos.length === 0 ? (
                <p className={css.ayuda}>Cuando vendas, aquí verás los productos que más salen.</p>
              ) : (
                <ul className={css.barras}>
                  {d.topProductos.map((p) => (
                    <li key={p.productoId}>
                      <span className={css.barrasNombre} title={p.nombre}>
                        {p.nombre}
                      </span>
                      <span className={css.barrasPista}>
                        <span className={css.barrasRelleno} style={{ width: `${(Number(p.totalPen) / Number(d.topProductos[0]!.totalPen)) * 100}%` }} />
                      </span>
                      <span className={css.barrasValor}>{dinero(p.totalPen)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Seccion>
          </div>

          <div className={css.graficos}>
            <Seccion titulo="Ventas recientes">
              <Tabla
                filas={d.recientes}
                clave={(v) => v.id}
                vacio="Todavía no hay ventas. Empieza en Vender."
                columnas={[
                  { titulo: 'Hora', celda: (v) => <span className="whitespace-nowrap">{hora(v.fecha)}</span> },
                  { titulo: 'Comprobante', celda: (v) => (v.comprobante ? `${v.tipoDoc === '01' ? 'Factura' : 'Boleta'} ${v.comprobante}` : '') },
                  { titulo: 'Total', celda: (v) => dinero(v.total, v.moneda), alinear: 'derecha' },
                  {
                    titulo: 'Estado',
                    celda: (v) =>
                      v.anulada ? <Chip>Anulada</Chip> : v.estadoComprobante ? <Chip tono={ETIQUETA_ESTADO[v.estadoComprobante as EstadoComprobante]?.tono}>{ETIQUETA_ESTADO[v.estadoComprobante as EstadoComprobante]?.texto ?? v.estadoComprobante}</Chip> : null,
                  },
                ]}
              />
            </Seccion>
            <div className={css.columna}>
              <Seccion titulo="Por reponer">
                {d.stockBajo.length ? (
                  <ul className={css.listaEstado}>
                    {d.stockBajo.map((p) => (
                      <li key={p.productoId}>
                        <span>{p.nombre}</span>
                        <span>
                          <Chip tono={Number(p.stock) <= 0 ? 'alerta' : 'aviso'}>
                            {cantidad(p.stock)} de mínimo {cantidad(p.minimo)}
                          </Chip>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={css.ayuda}>{d.productos ? 'Ningún producto está en su stock mínimo.' : 'Cuando registres productos, aquí verás los que falta reponer.'}</p>
                )}
              </Seccion>
              {puede('comprobantes.ver') && (
                <Seccion titulo="Comprobantes de hoy">
                  <ul className={css.ahora}>
                    <FilaAhora icono={CheckCircle2} a="/comprobantes" texto={plural(d.comprobantes.aceptadosHoy, 'aceptado', 'aceptados')} detalle="Por SUNAT o en simulación" />
                    <FilaAhora
                      icono={Clock}
                      a="/comprobantes"
                      texto={`${plural(d.comprobantes.enProceso + d.comprobantes.porVerificar, 'esperando respuesta', 'esperando respuesta')}`}
                      detalle={d.comprobantes.pendientes ? `${d.comprobantes.pendientes} por emitir` : d.comprobantes.pendienteResumen ? `${d.comprobantes.pendienteResumen} para el resumen diario` : 'Al día'}
                    />
                    <FilaAhora icono={AlertTriangle} a="/comprobantes" texto={plural(d.comprobantes.problemas, 'con problema', 'con problema')} detalle={d.comprobantes.problemas ? 'Revisa y reintenta' : 'Ninguno'} />
                  </ul>
                </Seccion>
              )}
              <Seccion titulo="Cobrado hoy">
                {d.porMetodo.length === 0 ? (
                  <p className={css.ayuda}>Sin movimientos de caja todavía.</p>
                ) : (
                  <ul className={css.listaEstado}>
                    {d.porMetodo.map((m) => (
                      <li key={`${m.metodo}-${m.moneda}`}>
                        <span>{m.metodo}</span>
                        <strong className="num">{dinero(m.total, m.moneda)}</strong>
                      </li>
                    ))}
                  </ul>
                )}
              </Seccion>
              {d.cxcVencida.length > 0 && (
                <Seccion titulo="Cuotas vencidas">
                  <ul className={css.listaEstado}>
                    {d.cxcVencida.map((c) => (
                      <li key={c.moneda}>
                        <span>{plural(c.cuotas, 'cuota', 'cuotas')}</span>
                        <strong className="num">{dinero(c.saldo, c.moneda)}</strong>
                      </li>
                    ))}
                  </ul>
                  {puede('cxc.ver') && <Link to="/cuentas-por-cobrar">Ver cuentas por cobrar</Link>}
                </Seccion>
              )}
            </div>
          </div>

          <p className={css.ayuda}>Cifras de ventas confirmadas; las anuladas no suman.</p>
        </>
      )}
    </div>
  );
}

/** Variación vs. el mismo día de la semana pasada (sube en verde, baja en rojo), como .indicador-cambio. */
function Variacion({ valor }: { valor: number | null }) {
  if (valor == null) return <span className={css.nota}>Sin ventas el mismo día de la semana pasada</span>;
  const sube = valor > 0;
  const Icono = sube ? TrendingUp : TrendingDown;
  return (
    <span className={css.cambio} data-sentido={valor === 0 ? 'igual' : sube ? 'sube' : 'baja'}>
      <Icono aria-hidden />
      <strong>
        {sube ? '+' : ''}
        {valor.toLocaleString('es-PE', { maximumFractionDigits: 1 })}%
      </strong>
      <span> vs. semana pasada</span>
    </span>
  );
}

function ColumnasDiarias({ serie }: { serie: DashboardDto['serieDiaria'] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ancho, setAncho] = useState(640);
  const [activo, setActivo] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setAncho(Math.max(280, e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const alto = 200;
  const m = { arriba: 22, abajo: 26, izq: 44, der: 8 };
  const valores = serie.map((s) => Number(s.totalPen));
  const maximo = Math.max(...valores, 0);
  const minimo = Math.min(...valores, 0);
  // Tope "limpio" del eje (1, 2 o 5 × 10^n).
  const limpio = (v: number) => {
    if (v <= 0) return 0;
    const p = 10 ** Math.floor(Math.log10(v));
    return [1, 2, 5, 10].map((k) => k * p).find((k) => k >= v)!;
  };
  const tope = limpio(maximo) || 100;
  const piso = minimo < 0 ? -limpio(-minimo) : 0;
  const y = (v: number) => m.arriba + ((tope - v) / (tope - piso)) * (alto - m.arriba - m.abajo);
  const franja = (ancho - m.izq - m.der) / serie.length;
  const grosor = Math.min(24, franja * 0.6);
  const marcas = [piso, ...(piso < 0 ? [0] : []), tope / 2, tope].filter((v, i, a) => a.indexOf(v) === i);

  const barra = (x: number, v: number) => {
    const y0 = y(0);
    const y1 = y(v);
    const h = Math.abs(y1 - y0);
    if (h < 0.5) return '';
    const r = Math.min(4, h, grosor / 2);
    // Tapa redondeada en el extremo del dato, recta en la línea base.
    return v >= 0
      ? `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + grosor - r} Q${x + grosor},${y1} ${x + grosor},${y1 + r} V${y0} Z`
      : `M${x},${y0} V${y1 - r} Q${x},${y1} ${x + r},${y1} H${x + grosor - r} Q${x + grosor},${y1} ${x + grosor},${y1 - r} V${y0} Z`;
  };
  const ultimo = serie.length - 1;
  const etiquetaCada = franja < 40 ? 2 : 1;

  return (
    <div ref={ref} className={css.grafico} onMouseLeave={() => setActivo(null)}>
      <svg viewBox={`0 0 ${ancho} ${alto}`} height={alto} role="img" aria-label={`Ventas netas por día; hoy ${dinero(serie[ultimo]?.totalPen ?? 0)}`}>
        {marcas.map((v) => (
          <g key={v}>
            <line className={css.eje} x1={m.izq} x2={ancho - m.der} y1={y(v)} y2={y(v)} />
            <text className={css.texto} x={m.izq - 6} y={y(v) + 4} textAnchor="end">
              {compacto(v)}
            </text>
          </g>
        ))}
        {serie.map((s, i) => {
          const x = m.izq + i * franja + (franja - grosor) / 2;
          const v = Number(s.totalPen);
          return (
            <g key={s.fecha}>
              <path className={css.barra} d={barra(x, v)} />
              {i % etiquetaCada === (ultimo % etiquetaCada) && (
                <text className={css.texto} x={x + grosor / 2} y={alto - 8} textAnchor="middle">
                  {i === ultimo ? 'Hoy' : diaCorto(s.fecha)}
                </text>
              )}
              {i === ultimo && v !== 0 && (
                <text className={css.valor} x={x + grosor / 2} y={v >= 0 ? y(v) - 6 : y(v) + 14} textAnchor="middle">
                  {compacto(v)}
                </text>
              )}
              {/* Zona de hover: toda la franja del día, más grande que la barra. */}
              <rect
                className={css.blanco}
                x={m.izq + i * franja}
                y={m.arriba}
                width={franja}
                height={alto - m.arriba - m.abajo}
                onMouseEnter={() => setActivo(i)}
                onFocus={() => setActivo(i)}
                onBlur={() => setActivo(null)}
                tabIndex={0}
                aria-label={`${diaLargo(s.fecha)}: ${dinero(s.totalPen)}, ${s.n} ventas`}
              />
            </g>
          );
        })}
      </svg>
      {activo != null && serie[activo] && (
        <div className={css.tooltip} style={{ left: `${((m.izq + (activo + 0.5) * franja) / ancho) * 100}%`, top: y(Math.max(0, Number(serie[activo].totalPen))) }}>
          {diaLargo(serie[activo].fecha)}
          <strong>{dinero(serie[activo].totalPen)}</strong>
          {serie[activo].n} venta(s)
        </div>
      )}
    </div>
  );
}
