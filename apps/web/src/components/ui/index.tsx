// Componentes de la app construidos sobre shadcn/ui (button, input, select, checkbox, badge, alert,
// table, dialog, sonner). Mantienen la API que usan las pantallas (Boton, Campo, Selector…),
// así el diseño es 100 % shadcn sin reescribir cada formulario.
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, Inbox, Loader2, Minus, Plus, type LucideIcon } from 'lucide-react';
import {
  Fragment, lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState,
  type ButtonHTMLAttributes, type ComponentProps, type ChangeEvent, type InputHTMLAttributes, type ReactNode,
} from 'react';
import { Link, useLocation } from 'react-router-dom';
import { toast as avisar } from 'sonner';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from './alert';
import { Badge } from './badge';
import { Button } from './button';
import { Checkbox } from './checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './dialog';
import { Input } from './input';
import { Label } from './label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { Toaster } from './sonner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';
import { Textarea } from './textarea';
import { ToggleGroup, ToggleGroupItem } from './toggle-group';
import css from './ui.module.css';

/** Clases de maquetación (rejilla del formulario, pilas, acciones…). Los controles son de shadcn. */
export { css as ui };

// ---------- Botón ----------

type Variante = 'secundario' | 'primario' | 'peligro' | 'plano';
const VARIANTE = { primario: 'default', secundario: 'outline', peligro: 'destructive', plano: 'ghost' } as const;

interface BotonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variante?: Variante;
  chico?: boolean;
  icono?: LucideIcon;
  cargando?: boolean;
}

export function Boton({ variante = 'secundario', chico, icono: Icono, cargando, children, className, disabled, type = 'button', ...resto }: BotonProps) {
  const soloIcono = !children && Icono;
  return (
    <Button
      type={type}
      variant={VARIANTE[variante]}
      size={soloIcono ? (chico ? 'icon-sm' : 'icon') : chico ? 'sm' : 'default'}
      className={className}
      disabled={disabled || cargando}
      aria-busy={cargando || undefined}
      {...resto}
    >
      {cargando ? <Loader2 className="animate-spin" aria-hidden /> : Icono && <Icono aria-hidden />}
      {children}
    </Button>
  );
}

// ---------- Campos ----------

interface EnvolturaProps {
  etiqueta?: string;
  error?: string;
  ayuda?: ReactNode;
  opcional?: boolean;
  ancho?: 'completo' | 'mitad' | 'cuarto';
}

function Envoltura({ etiqueta, error, ayuda, opcional, ancho = 'completo', id, idDesc, children }: EnvolturaProps & { id: string; idDesc?: string; children: ReactNode }) {
  return (
    <div className={cn(css.campo, ancho === 'mitad' && css.mitad, ancho === 'cuarto' && css.cuarto)}>
      {etiqueta && (
        <Label htmlFor={id} className={cn(error && 'text-peligro')}>
          {etiqueta} {opcional && <span className="font-normal text-muted-foreground">(opcional)</span>}
        </Label>
      )}
      {children}
      {error ? (
        <span id={idDesc} className="text-sm font-normal text-peligro" role="alert">
          {error}
        </span>
      ) : (
        ayuda && (
          <span id={idDesc} className="text-sm font-normal text-muted-foreground">
            {ayuda}
          </span>
        )
      )}
    </div>
  );
}

type CampoProps = EnvolturaProps & InputHTMLAttributes<HTMLInputElement>;

/** Input de shadcn con etiqueta, ayuda y error. */
export function Campo({ etiqueta, error, ayuda, opcional, ancho, className, id: idDado, ...input }: CampoProps) {
  const propio = useId();
  const id = idDado ?? propio;
  const idDesc = error || ayuda ? `${id}-desc` : undefined;
  return (
    <Envoltura etiqueta={etiqueta} error={error} ayuda={ayuda} opcional={opcional} ancho={ancho} id={id} idDesc={idDesc}>
      {input.type === 'date' ? (
        <SelectorFecha
          id={id}
          value={String(input.value ?? '')}
          min={input.min as string | undefined}
          max={input.max as string | undefined}
          disabled={input.disabled}
          className={cn('w-full', className)}
          invalido={Boolean(error)}
          describedBy={idDesc}
          onChange={(v) => input.onChange?.({ target: { value: v }, currentTarget: { value: v } } as unknown as ChangeEvent<HTMLInputElement>)}
        />
      ) : (
        <Input id={id} className={className} aria-invalid={Boolean(error) || undefined} aria-describedby={idDesc} {...input} />
      )}
    </Envoltura>
  );
}

type AreaProps = EnvolturaProps & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'children'>;

/** Textarea de shadcn con etiqueta, ayuda y error. */
export function AreaTexto({ etiqueta, error, ayuda, opcional, ancho, className, id: idDado, ...area }: AreaProps) {
  const propio = useId();
  const id = idDado ?? propio;
  const idDesc = error || ayuda ? `${id}-desc` : undefined;
  return (
    <Envoltura etiqueta={etiqueta} error={error} ayuda={ayuda} opcional={opcional} ancho={ancho} id={id} idDesc={idDesc}>
      <Textarea id={id} className={className} aria-invalid={Boolean(error) || undefined} aria-describedby={idDesc} {...area} />
    </Envoltura>
  );
}

// Radix Select no admite '' como valor de una opción: se traduce a un centinela.
const VACIO = '__vacio__';

type SelectorProps = EnvolturaProps & {
  opciones: Array<{ valor: string; texto: string }>;
  value?: string;
  /** Misma forma que el onChange de un <select> (e.target.value), para no cambiar las pantallas. */
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
  disabled?: boolean;
  id?: string;
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
};

/** Select de shadcn (Radix). Sin `etiqueta` se usa solo (p. ej. en una fila de filtros) con aria-label. */
export function Selector({ etiqueta, error, ayuda, opcional, ancho, opciones, value, onChange, disabled, id: idDado, placeholder = 'Elegir…', className, 'aria-label': ariaLabel }: SelectorProps) {
  const propio = useId();
  const id = idDado ?? propio;
  const idDesc = error || ayuda ? `${id}-desc` : undefined;
  const control = (
    <Select
      value={value === '' ? VACIO : value}
      disabled={disabled}
      onValueChange={(v) => onChange?.({ target: { value: v === VACIO ? '' : v }, currentTarget: { value: v === VACIO ? '' : v } } as unknown as ChangeEvent<HTMLSelectElement>)}
    >
      <SelectTrigger id={id} size={etiqueta ? 'default' : 'sm'} className={cn('w-full', !etiqueta && 'w-auto min-w-40', className)} aria-invalid={Boolean(error) || undefined} aria-describedby={idDesc} aria-label={ariaLabel ?? etiqueta}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {opciones.map((o) => (
          <SelectItem key={o.valor || VACIO} value={o.valor === '' ? VACIO : o.valor}>
            {o.texto}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  if (!etiqueta && !error && !ayuda) return control;
  return (
    <Envoltura etiqueta={etiqueta} error={error} ayuda={ayuda} opcional={opcional} ancho={ancho} id={id} idDesc={idDesc}>
      {control}
    </Envoltura>
  );
}

type CasillaProps = {
  etiqueta: ReactNode;
  checked?: boolean;
  /** Misma forma que un <input type="checkbox"> (e.target.checked). */
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  id?: string;
};

/** Checkbox de shadcn con su etiqueta. */
export function Casilla({ etiqueta, checked, onChange, disabled, id: idDado }: CasillaProps) {
  const propio = useId();
  const id = idDado ?? propio;
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={Boolean(checked)}
        disabled={disabled}
        onCheckedChange={(c) => onChange?.({ target: { checked: c === true }, currentTarget: { checked: c === true } } as unknown as ChangeEvent<HTMLInputElement>)}
      />
      <Label htmlFor={id} className={cn('leading-snug', disabled && 'opacity-50')}>
        {etiqueta}
      </Label>
    </div>
  );
}

// ---------- Chip (Badge), franja (Alert), vacío, encabezado ----------

export type Tono = 'neutro' | 'info' | 'ok' | 'aviso' | 'alerta';

const TONO_CHIP: Record<Tono, string> = {
  neutro: 'border-transparent bg-secondary text-secondary-foreground',
  info: 'border-transparent bg-primary text-primary-foreground',
  ok: 'border-transparent bg-exito/14 text-ok',
  aviso: 'border-transparent bg-aviso/16 text-warn',
  alerta: 'border-transparent bg-destructive text-white dark:bg-destructive/60',
};

/** Badge de shadcn con los tonos de estado de la app. */
export function Chip({ tono = 'neutro', children }: { tono?: Tono; children: ReactNode }) {
  return (
    <Badge variant="outline" className={TONO_CHIP[tono]}>
      {children}
    </Badge>
  );
}

const TONO_FRANJA: Record<Exclude<Tono, 'neutro'>, string> = {
  info: 'text-foreground',
  ok: 'text-ok',
  aviso: 'text-warn',
  alerta: 'text-peligro',
};

/** Alert de shadcn con icono según el tono. */
export function Franja({ tono = 'info', children }: { tono?: Exclude<Tono, 'neutro'>; children: ReactNode }) {
  const Icono = tono === 'ok' ? CheckCircle2 : tono === 'info' ? Info : AlertTriangle;
  return (
    <Alert className={cn('border-0 bg-transparent p-0 text-sm [&>svg]:text-current', TONO_FRANJA[tono])} role={tono === 'alerta' ? 'alert' : 'status'}>
      <Icono aria-hidden />
      <AlertDescription className="text-inherit [&_a]:underline [&_a]:underline-offset-4">{children}</AlertDescription>
    </Alert>
  );
}

export function Vacio({ texto, accion }: { texto: string; accion?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center text-sm font-normal text-muted-foreground">
      <Inbox className="size-8 text-primary" aria-hidden />
      <p className="m-0 max-w-sm text-balance">{texto}</p>
      {accion}
    </div>
  );
}

export function Encabezado({ titulo, children }: { titulo: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
      <h1 className="max-w-[68ch] text-[1.0625rem] font-bold tracking-[-0.01em]">{titulo}</h1>
      {children && <div className={css.acciones}>{children}</div>}
    </div>
  );
}

/** Botón flotante redondo con icono naranja, como los accesos del inicio. Activo: relleno primario. */
const PILDORA = 'flex-none rounded-full font-medium';
const pildora = (activa: boolean) => cn(PILDORA, !activa && '[&_svg]:text-primary');

export interface ItemPestana {
  ruta: string;
  texto: string;
  icono?: LucideIcon;
}

/**
 * Secciones de una página como botones flotantes. En pantallas anchas bajan de línea si no caben;
 * en el teléfono forman una sola fila que se desliza (sin barra) y la activa queda a la vista.
 */
export function Pestanas({ items }: { items: ItemPestana[] }) {
  const { pathname } = useLocation();
  const fila = useRef<HTMLElement>(null);
  // La pestaña activa es la de ruta más larga que coincide (la primera suele ser la raíz de la sección).
  const activa = [...items].sort((a, b) => b.ruta.length - a.ruta.length).find((i) => pathname === i.ruta || pathname.startsWith(`${i.ruta}/`))?.ruta ?? items[0]?.ruta;
  useEffect(() => {
    const nav = fila.current;
    const el = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav && el && nav.scrollWidth > nav.clientWidth) nav.scrollTo({ left: el.offsetLeft - (nav.clientWidth - el.offsetWidth) / 2, behavior: 'smooth' });
  }, [activa]);
  return (
    <nav
      ref={fila}
      aria-label="Secciones"
      className="relative mb-5 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] max-md:-mx-4 max-md:px-4 md:flex-wrap [&::-webkit-scrollbar]:hidden"
    >
      {items.map((i) => {
        const on = i.ruta === activa;
        return (
          <Button key={i.ruta} asChild variant={on ? 'default' : 'outline'} className={pildora(on)}>
            <Link to={i.ruta} aria-current={on ? 'page' : undefined}>
              {i.icono && <i.icono aria-hidden />}
              {i.texto}
            </Link>
          </Button>
        );
      })}
    </nav>
  );
}

// ---------- Tabla ----------

export interface Columna<T> {
  titulo: string;
  /** `i` es la posición de la fila en toda la lista (no solo en la página). */
  celda: (fila: T, i: number) => ReactNode;
  alinear?: 'derecha';
  /** Nunca pasa al "+". La primera columna y la de acciones (sin título) ya lo son. */
  fija?: boolean;
  /** Orden en que pasa al "+" cuando no cabe (menor, primero). Sin ella, de derecha a izquierda. */
  prioridad?: number;
  /** El texto baja de línea (descripciones largas) en vez de mandar la columna al "+". */
  envolver?: boolean;
}

/** Página que viene de la API (`Pagina<T>`): la tabla solo pinta el pie. */
export interface PaginacionServidor {
  page: number;
  pageSize: number;
  total: number;
  alCambiar: (page: number) => void;
}

/** Números de página con "…": 1 … 4 5 6 … 12 (los saltos de una sola página se muestran). */
function numerosPagina(p: number, n: number): Array<number | null> {
  const elegidas = new Set([1, n, p - 1, p, p + 1]);
  if (p <= 3) [2, 3, 4].forEach((x) => elegidas.add(x));
  if (p >= n - 2) [n - 1, n - 2, n - 3].forEach((x) => elegidas.add(x));
  const orden = [...elegidas].filter((x) => x >= 1 && x <= n).sort((a, b) => a - b);
  const salida: Array<number | null> = [];
  orden.forEach((x, k) => {
    const antes = orden[k - 1];
    if (antes !== undefined && x - antes === 2) salida.push(x - 1);
    else if (antes !== undefined && x - antes > 2) salida.push(null);
    salida.push(x);
  });
  return salida;
}

/** Pie de tabla: "Mostrando 1–25 de 120 registros" y las páginas (en el teléfono, "3 / 12"). */
export function Paginacion({ page, pageSize, total, alCambiar }: PaginacionServidor) {
  const paginas = Math.max(1, Math.ceil(total / pageSize));
  const desde = total ? (page - 1) * pageSize + 1 : 0;
  const hasta = Math.min(total, page * pageSize);
  const fuerte = 'font-semibold text-foreground';
  return (
    <nav aria-label="Paginación" className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-3 text-xs text-muted-foreground tabular-nums max-sm:justify-center">
      <p className="m-0" aria-live="polite">
        {paginas > 1 ? (
          <>
            Mostrando <span className={fuerte}>{desde}–{hasta}</span> de <span className={fuerte}>{total}</span> registros
          </>
        ) : (
          `${total} ${total === 1 ? 'registro' : 'registros'}`
        )}
      </p>
      {paginas > 1 && (
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" aria-label="Página anterior" title="Página anterior" disabled={page <= 1} onClick={() => alCambiar(page - 1)}>
            <ChevronLeft />
          </Button>
          {numerosPagina(page, paginas).map((n, k) =>
            n === null ? (
              <span key={`salto-${k}`} className="w-6 text-center max-sm:hidden" aria-hidden>
                …
              </span>
            ) : (
              <Button
                key={n}
                variant={n === page ? 'default' : 'ghost'}
                size="icon-sm"
                className={cn('max-sm:hidden', n !== page && 'text-foreground')}
                aria-label={`Página ${n}`}
                aria-current={n === page ? 'page' : undefined}
                onClick={() => n !== page && alCambiar(n)}
              >
                {n}
              </Button>
            ),
          )}
          <span className="px-2 font-semibold text-foreground sm:hidden">
            {page} / {paginas}
          </span>
          <Button variant="outline" size="icon-sm" aria-label="Página siguiente" title="Página siguiente" disabled={page >= paginas} onClick={() => alCambiar(page + 1)}>
            <ChevronRight />
          </Button>
        </div>
      )}
    </nav>
  );
}

/**
 * Data table como la de ferretería: columna "N°", paginación (de la API con `paginacion`, o aquí
 * mismo de `porPagina` en `porPagina`) y 100 % adaptable. Si no cabe en su espacio real (página,
 * modal, barra lateral abierta…), primero sale la "N°" y luego las columnas, de derecha a izquierda
 * (o por `prioridad`), pasan a una fila que se despliega con "+". Sin barra horizontal.
 */
export function Tabla<T>({
  filas, columnas, clave, vacio = 'No hay registros', paginacion, porPagina = 25, numerar = true,
}: {
  filas: T[];
  columnas: Columna<T>[];
  clave: (f: T, i: number) => string | number;
  vacio?: string;
  paginacion?: PaginacionServidor;
  porPagina?: number;
  numerar?: boolean;
}) {
  const caja = useRef<HTMLDivElement>(null);
  const [ocultas, setOcultas] = useState<number[]>([]);
  const [sinNumero, setSinNumero] = useState(false);
  const [abiertas, setAbiertas] = useState<ReadonlySet<string | number>>(new Set());
  const [paginaLocal, setPaginaLocal] = useState(1);

  const tam = paginacion?.pageSize ?? porPagina;
  const total = paginacion?.total ?? filas.length;
  const paginas = Math.max(1, Math.ceil(total / tam));
  const pagina = paginacion?.page ?? Math.min(paginaLocal, paginas);
  const inicio = (pagina - 1) * tam;
  const visibles = paginacion ? filas : filas.slice(inicio, inicio + tam);
  // Las que pueden pasar al "+": ni la primera, ni las fijas, ni la de acciones (sin título).
  const candidatas = columnas
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => i > 0 && !c.fija && c.titulo !== '')
    .sort((a, b) => (a.c.prioridad ?? 0) - (b.c.prioridad ?? 0) || b.i - a.i)
    .map(({ i }) => i);
  const firma = candidatas.join(',');

  // Se mide con todo a la vista y se va quitando hasta que quepa (estilos en línea solo durante la
  // medición); el resultado queda en el estado y React lo pinta antes de mostrarse.
  const ajustar = useRef(() => {});
  ajustar.current = () => {
    const contenedor = caja.current?.querySelector<HTMLElement>('[data-slot=table-container]');
    const tabla = contenedor?.querySelector('table');
    if (!contenedor || !tabla || !contenedor.clientWidth) return;
    const mostrar = (k: string, si: boolean) => tabla.querySelectorAll<HTMLElement>(`[data-col="${k}"]`).forEach((el) => (el.style.display = si ? 'table-cell' : 'none'));
    const cabe = () => tabla.offsetWidth <= contenedor.clientWidth + 1;
    const detalles = tabla.querySelectorAll<HTMLElement>('[data-detalle]');
    detalles.forEach((d) => (d.style.display = 'none'));
    columnas.forEach((_, i) => mostrar(String(i), true));
    mostrar('n', numerar);
    mostrar('mas', false);
    const fuera: number[] = [];
    let quitarNumero = false;
    if (!cabe() && numerar) {
      mostrar('n', false);
      quitarNumero = true;
    }
    if (!cabe() && candidatas.length) {
      mostrar('mas', true);
      for (const i of candidatas) {
        if (cabe()) break;
        mostrar(String(i), false);
        fuera.push(i);
      }
    }
    tabla.querySelectorAll<HTMLElement>('[data-col]').forEach((el) => (el.style.display = ''));
    detalles.forEach((d) => (d.style.display = ''));
    setSinNumero(quitarNumero);
    setOcultas((antes) => (antes.length === fuera.length && antes.every((x, j) => x === fuera[j]) ? antes : fuera));
  };

  // En cada pintado (cambian datos, página o columnas): el estado solo cambia si cambia el resultado.
  useLayoutEffect(() => ajustar.current());
  useEffect(() => {
    const el = caja.current;
    if (!el) return;
    let ancho = el.clientWidth;
    const observador = new ResizeObserver(() => {
      if (el.clientWidth === ancho) return; // el alto cambia al ocultar columnas: no se vuelve a medir
      ancho = el.clientWidth;
      ajustar.current();
    });
    observador.observe(el);
    return () => observador.disconnect();
  }, [firma, filas.length === 0]);

  if (!filas.length) return <Vacio texto={vacio} />;

  const hayMas = ocultas.length > 0;
  const enVista = columnas.length - ocultas.length + (numerar && !sinNumero ? 1 : 0) + (hayMas ? 1 : 0);
  const alternar = (k: string | number) =>
    setAbiertas((a) => {
      const b = new Set(a);
      if (!b.delete(k)) b.add(k);
      return b;
    });
  const irA = (p: number) => {
    if (paginacion) paginacion.alCambiar(p);
    else setPaginaLocal(p);
    caja.current?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <div ref={caja} className="min-w-0">
      <Table>
        <TableHeader>
          <TableRow>
            {numerar && (
              <TableHead data-col="n" className={cn('w-[3.25rem] text-muted-foreground', sinNumero && 'hidden')}>
                N°
              </TableHead>
            )}
            {columnas.map((c, i) => (
              <TableHead key={`${c.titulo}-${i}`} data-col={i} className={cn(c.alinear && 'text-right', ocultas.includes(i) && 'hidden')}>
                {c.titulo}
              </TableHead>
            ))}
            <TableHead data-col="mas" className={cn('w-10', !hayMas && 'hidden')}>
              <span className="sr-only">Más datos</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibles.map((f, j) => {
            const k = clave(f, inicio + j);
            const n = inicio + j;
            const abierta = hayMas && abiertas.has(k);
            return (
              <Fragment key={k}>
                <TableRow className={cn(abierta && 'border-b-0')}>
                  {numerar && (
                    <TableCell data-col="n" className={cn('align-middle text-muted-foreground tabular-nums', sinNumero && 'hidden')}>
                      {n + 1}
                    </TableCell>
                  )}
                  {columnas.map((c, i) => (
                    <TableCell
                      key={`${c.titulo}-${i}`}
                      data-col={i}
                      className={cn('align-middle', i === 0 || c.envolver ? 'min-w-32 whitespace-normal' : 'whitespace-nowrap', c.alinear && 'num text-right', ocultas.includes(i) && 'hidden')}
                    >
                      {c.celda(f, n)}
                    </TableCell>
                  ))}
                  <TableCell data-col="mas" className={cn('w-10 text-right align-middle', !hayMas && 'hidden')}>
                    <Button variant="ghost" size="icon-sm" className="text-base font-bold" aria-expanded={abierta} aria-label={abierta ? 'Ocultar datos' : 'Ver más datos'} title={abierta ? 'Ocultar datos' : 'Ver más datos'} onClick={() => alternar(k)}>
                      {abierta ? <Minus /> : <Plus />}
                    </Button>
                  </TableCell>
                </TableRow>
                {abierta && (
                  <TableRow data-detalle>
                    <TableCell colSpan={enVista} className="whitespace-normal pt-0 pb-3">
                      <dl className="m-0 grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-x-8 gap-y-2 pt-1">
                        {ocultas
                          .slice()
                          .sort((a, b) => a - b)
                          .map((i) => {
                            const c = columnas[i]!;
                            const contenido = c.celda(f, n);
                            if (contenido === '' || contenido === null || contenido === undefined || contenido === false) return null;
                            return (
                              <div key={i} className="flex min-w-0 items-baseline justify-between gap-3">
                                <dt className="flex-none text-xs text-muted-foreground">{c.titulo}</dt>
                                <dd className="m-0 min-w-0 text-right">{contenido}</dd>
                              </div>
                            );
                          })}
                      </dl>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
      {(paginacion || paginas > 1) && <Paginacion page={pagina} pageSize={tam} total={total} alCambiar={irA} />}
    </div>
  );
}

// ---------- Modal ----------

/**
 * Dialog de shadcn (Radix): foco atrapado, Escape y clic fuera cierran. `fijo` impide cerrarlo sin
 * usar los botones (formularios largos que no conviene perder por un clic accidental).
 */
export function Dialogo({
  titulo, abierto, alCerrar, children, pie, ancho, chico, fijo, grande,
}: {
  titulo: string;
  abierto: boolean;
  alCerrar: () => void;
  children: ReactNode;
  pie?: ReactNode;
  ancho?: boolean;
  chico?: boolean;
  fijo?: boolean;
  /** Casi toda la pantalla (visor de PDF): el contenido ocupa el alto disponible. */
  grande?: boolean;
}) {
  return (
    <Dialog open={abierto} onOpenChange={(o) => !o && alCerrar()}>
      <DialogContent
        showCloseButton={!fijo}
        aria-describedby={undefined}
        className={cn('flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden rounded-[var(--radio)] p-0 text-sm', grande ? 'h-[calc(100dvh-2rem)] sm:max-w-[min(72rem,calc(100vw-2rem))]' : ancho ? 'sm:max-w-[62rem]' : chico ? 'sm:max-w-[24rem]' : 'sm:max-w-[32rem]')}
        onInteractOutside={fijo ? (e) => e.preventDefault() : undefined}
        onEscapeKeyDown={fijo ? (e) => e.preventDefault() : undefined}
      >
        <DialogHeader className="gap-2 px-6 pt-6 pr-12 text-left">
          <DialogTitle className="text-lg leading-none font-semibold tracking-normal">{titulo}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
        {pie && <DialogFooter className="flex-wrap gap-2 px-6 pb-6 max-sm:[&>*]:w-full">{pie}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

// ---------- Toasts (sonner) ----------

type TonoToast = 'ok' | 'error' | 'info';

const mostrar = (texto: string, tono: TonoToast = 'info') => {
  if (tono === 'ok') avisar.success(texto);
  else if (tono === 'error') avisar.error(texto, { duration: 6500 });
  else avisar.info(texto);
};

export function ProveedorToasts({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Toaster position="bottom-right" />
    </>
  );
}

export const useToast = () => mostrar;

// ---------- Teclado PIN (como ferretería) ----------

/**
 * Teclado de PIN: 6 puntos (los 2 últimos opcionales), mensaje debajo y teclas grandes.
 * Un campo invisible recibe lo que se escribe con el teclado físico (y un PIN pegado).
 * `error` es un contador: cada valor nuevo vacía el PIN y sacude el teclado.
 */
export function TecladoPin({
  alCompletar, deshabilitado, error, mensaje, textoEntrar = 'Entrar',
}: { alCompletar: (pin: string) => void; largo?: number; deshabilitado?: boolean; error?: number; mensaje?: string | null; textoEntrar?: string }) {
  const [pin, setPin] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);
  const [sacudir, setSacudir] = useState(false);
  const oculto = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!error) return;
    setPin('');
    setSacudir(false);
    const t1 = setTimeout(() => setSacudir(true), 10);
    const t2 = setTimeout(() => setSacudir(false), 320);
    oculto.current?.focus();
    return () => (clearTimeout(t1), clearTimeout(t2));
  }, [error]);

  useEffect(() => {
    const t = setTimeout(() => oculto.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  const fijar = (v: string) => {
    setPin(v.replace(/\D/g, '').slice(0, 6));
    setAviso(null);
  };
  const enviar = () => {
    if (deshabilitado) return;
    if (pin.length < 4) return setAviso('El PIN tiene entre 4 y 6 dígitos.');
    alCompletar(pin);
  };
  const tecla = 'h-13 border-0 bg-campo text-xl font-bold tabular-nums shadow-none ';

  return (
    <div className={cn('relative mx-auto max-w-[19rem]', sacudir && css.sacudir)} onClick={() => oculto.current?.focus()}>
      <Input
        ref={oculto}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        aria-label="PIN"
        maxLength={6}
        value={pin}
        disabled={deshabilitado}
        onChange={(e) => fijar(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), enviar())}
        className="pointer-events-none absolute size-px border-0 p-0 opacity-0"
      />
      <div className={css.pinPuntos} aria-live="polite" aria-label={`${pin.length} dígitos ingresados`}>
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={css.pinPunto} data-lleno={i < pin.length} data-opcional={i >= 4} />
        ))}
      </div>
      <p className="m-0 mt-[0.2rem] mb-[0.4rem] min-h-[1.4em] text-center text-[0.8125rem] text-peligro" role="alert">
        {aviso ?? mensaje ?? ''}
      </p>
      <div className={css.pinTeclado}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <Boton key={d} variante="plano" className={tecla} onClick={() => fijar(pin + d)} disabled={deshabilitado}>
            {d}
          </Boton>
        ))}
        <Boton variante="plano" className={cn(tecla, 'text-sm')} onClick={() => fijar(pin.slice(0, -1))} disabled={deshabilitado}>
          Borrar
        </Boton>
        <Boton variante="plano" className={tecla} onClick={() => fijar(pin + '0')} disabled={deshabilitado}>
          0
        </Boton>
        <Boton variante="primario" className="h-13 text-sm font-bold" onClick={enviar} disabled={deshabilitado}>
          {textoEntrar}
        </Boton>
      </div>
    </div>
  );
}

// ---------- Fecha (se carga al primer uso) ----------

const FechaDiferida = lazy(() => import('./selector-fecha').then((m) => ({ default: m.SelectorFecha })));

/** Selector de fecha (valor AAAA-MM-DD, el mismo que un <input type="date">). */
export function SelectorFecha(props: ComponentProps<typeof FechaDiferida>) {
  return (
    <Suspense fallback={<Button variant="outline" disabled className={cn('justify-start font-normal text-muted-foreground', props.className)}>Cargando…</Button>}>
      <FechaDiferida {...props} />
    </Suspense>
  );
}

// ---------- Alternador (ToggleGroup de shadcn, una opción siempre elegida) ----------

export function Alternador<T extends string>({
  opciones, valor, alCambiar, etiqueta, separado, className,
}: {
  opciones: Array<{ valor: T; texto: ReactNode; icono?: LucideIcon; deshabilitado?: boolean; titulo?: string }>;
  valor: T;
  alCambiar: (v: T) => void;
  /** Nombre accesible del grupo. */
  etiqueta: string;
  /** Muchas opciones (p. ej. categorías): en el teléfono una sola fila que se desliza, sin barra. */
  separado?: boolean;
  className?: string;
}) {
  // Los mismos botones flotantes que Pestanas: redondos, icono naranja; la elegida con relleno primario.
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      spacing={2}
      value={valor}
      // Radix permite "desmarcar" la opción activa; aquí siempre hay una elegida.
      onValueChange={(v) => v && alCambiar(v as T)}
      aria-label={etiqueta}
      className={cn(
        'max-w-full justify-start',
        separado ? 'flex-nowrap overflow-x-auto pb-1 [scrollbar-width:none] md:flex-wrap [&::-webkit-scrollbar]:hidden' : 'flex-wrap',
        className,
      )}
    >
      {opciones.map((o) => (
        <ToggleGroupItem
          key={o.valor}
          value={o.valor}
          disabled={o.deshabilitado}
          title={o.titulo}
          className={cn(
            PILDORA,
            'bg-background px-4 dark:bg-input/30 [&_svg]:text-primary',
            'data-[state=on]:border-transparent data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:[&_svg]:text-primary-foreground',
          )}
        >
          {o.icono && <o.icono aria-hidden />}
          {o.texto}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
