import { ajusteSchema, trasladoSchema, type MovimientoDto, type Pagina, type ProductoDto, type SucursalDto, type TrasladoDto } from '@sv/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Boxes, History, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import { BuscadorProducto, useRetardo } from '../../components/comunes';
import css from '../../components/comunes.module.css';
import { Boton, Campo, Casilla, Chip, Dialogo, Encabezado, Franja, Pestanas, Selector, Tabla, ui, useToast } from '../../components/ui';
import { cantidad, dinero, fechaHora, TIPO_MOVIMIENTO } from '../../lib/formato';
import { ErrorHttp, mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';
import { Input } from '@/components/ui/input';

export function InventarioPage() {
  return (
    <>
      <Encabezado titulo="Inventario" />
      <Pestanas items={[{ ruta: '/inventario', texto: 'Stock', icono: Boxes }, { ruta: '/inventario/traslados', texto: 'Traslados', icono: ArrowLeftRight }]} />
      <Routes>
        <Route index element={<Stock />} />
        <Route path="traslados" element={<Traslados />} />
      </Routes>
    </>
  );
}

/** Mensaje detallado de un 409 STOCK_INSUFICIENTE (lista los faltantes). */
function mensajeStock(err: unknown): string {
  if (err instanceof ErrorHttp && err.codigo === 'STOCK_INSUFICIENTE') {
    const f = (err.cuerpo.detalle as { faltantes?: Array<{ nombre: string; disponible: string; solicitado: string }> } | undefined)?.faltantes ?? [];
    if (f.length) return `Stock insuficiente: ${f.map((x) => `${x.nombre} (hay ${cantidad(x.disponible)}, se piden ${cantidad(x.solicitado)})`).join('; ')}`;
  }
  return mensajeError(err);
}

function Stock() {
  const { puede, sesion } = useSesion();
  const [buscar, setBuscar] = useState('');
  const [soloBajo, setSoloBajo] = useState(false);
  const [page, setPage] = useState(1);
  const [kardex, setKardex] = useState<ProductoDto | null>(null);
  const [dialogo, setDialogo] = useState<'ajuste' | 'traslado' | null>(null);
  const q = useRetardo(buscar);

  const params = new URLSearchParams({ page: String(page), pageSize: '25', soloInventariables: 'true' });
  if (q) params.set('q', q);
  if (soloBajo) params.set('stockBajo', 'true');
  const { data } = useQuery({ queryKey: ['productos', 'stock', params.toString(), sesion?.sucursalActiva?.id], queryFn: () => pedir<Pagina<ProductoDto>>(`/productos?${params}`), placeholderData: keepPreviousData });

  return (
    <>
      <div className={css.filtros}>
        <Input type="search" placeholder="Buscar producto" value={buscar} onChange={(e) => (setBuscar(e.target.value), setPage(1))} aria-label="Buscar" />
        <Casilla etiqueta="Solo stock bajo" checked={soloBajo} onChange={(e) => (setSoloBajo(e.target.checked), setPage(1))} />
        <span style={{ flex: 1 }} />
        {puede('inventario.ajustar') && (
          <Boton icono={SlidersHorizontal} onClick={() => setDialogo('ajuste')}>
            Ajuste de inventario
          </Boton>
        )}
        {puede('inventario.trasladar') && (sesion?.sucursales.length ?? 0) > 1 && (
          <Boton icono={ArrowLeftRight} onClick={() => setDialogo('traslado')}>
            Trasladar
          </Boton>
        )}
      </div>
      <Tabla
        filas={data?.data ?? []}
        clave={(p) => p.id}
        vacio="No hay productos con control de stock."
        columnas={[
          { titulo: 'Producto', celda: (p) => <>{p.nombre}<span className={ui.sub}>{p.codigo}</span></> },
          { titulo: 'Stock', celda: (p) => <strong>{cantidad(p.stock)} <span className="muted">{p.unidad.codigoSunat}</span></strong>, alinear: 'derecha' },
          { titulo: 'Mínimo', celda: (p) => cantidad(p.stockMinimo), alinear: 'derecha' },
          { titulo: 'Estado', celda: (p) => (p.stockBajo ? <Chip tono="aviso">Por reponer</Chip> : Number(p.stock) === 0 ? <Chip tono="alerta">Agotado</Chip> : <Chip tono="ok">OK</Chip>) },
          { titulo: 'Costo prom.', celda: (p) => dinero(p.costoPromedio), alinear: 'derecha' },
          { titulo: '', celda: (p) => <div className={ui.acciones}><Boton chico icono={History} onClick={() => setKardex(p)}>Kardex</Boton></div> },
        ]}
        paginacion={data && { page: data.page, pageSize: data.pageSize, total: data.total, alCambiar: setPage }}
      />
      {kardex && <KardexDialogo producto={kardex} alCerrar={() => setKardex(null)} />}
      {dialogo === 'ajuste' && <AjusteDialogo alCerrar={() => setDialogo(null)} />}
      {dialogo === 'traslado' && <TrasladoDialogo alCerrar={() => setDialogo(null)} />}
    </>
  );
}

function KardexDialogo({ producto, alCerrar }: { producto: ProductoDto; alCerrar: () => void }) {
  const { sesion } = useSesion();
  const { data = [], isLoading } = useQuery({ queryKey: ['kardex', producto.id, sesion?.sucursalActiva?.id], queryFn: () => pedir<MovimientoDto[]>(`/inventario/kardex/${producto.id}`) });
  return (
    <Dialogo titulo={`Kardex · ${producto.nombre} · ${sesion?.sucursalActiva?.nombre ?? ''}`} abierto ancho alCerrar={alCerrar} pie={<Boton onClick={alCerrar}>Cerrar</Boton>}>
      {isLoading ? (
        <span className="muted">Cargando…</span>
      ) : (
        <Tabla
          filas={data}
          clave={(m) => m.id}
          vacio="Sin movimientos en esta sucursal."
          columnas={[
            { titulo: 'Fecha', celda: (m) => fechaHora(m.fecha) },
            { titulo: 'Movimiento', celda: (m) => <>{TIPO_MOVIMIENTO[m.tipo] ?? m.tipo}<span className={ui.sub}>{m.origenTipo} {m.origenId}{m.nota ? ` · ${m.nota}` : ''}</span></> },
            { titulo: 'Cantidad', celda: (m) => <span style={{ color: Number(m.cantidad) < 0 ? 'var(--danger)' : 'var(--ok-strong)' }}>{Number(m.cantidad) > 0 ? '+' : ''}{cantidad(m.cantidad)}</span>, alinear: 'derecha' },
            { titulo: 'Saldo', celda: (m) => <strong>{cantidad(m.stockResultante)}</strong>, alinear: 'derecha' },
            { titulo: 'Usuario', celda: (m) => m.usuario ?? '—' },
          ]}
        />
      )}
    </Dialogo>
  );
}

interface Linea {
  producto: ProductoDto;
  cantidad: string;
}

/** Editor de líneas de productos (ajustes y traslados). */
function Lineas({ lineas, setLineas, conSigno }: { lineas: Linea[]; setLineas: (l: Linea[]) => void; conSigno?: boolean }) {
  return (
    <div className={ui.pila}>
      <BuscadorProducto
        soloInventariables
        alElegir={(p) => {
          if (lineas.some((l) => l.producto.id === p.id)) return;
          setLineas([...lineas, { producto: p, cantidad: '' }]);
        }}
      />
      {lineas.length > 0 && (
        <Tabla
          filas={lineas}
          clave={(l) => l.producto.id}
          columnas={[
            {
              titulo: 'Producto',
              celda: (l) => (
                <>
                  {l.producto.nombre}
                  <span className={ui.sub}>{l.producto.codigo}</span>
                </>
              ),
            },
            { titulo: 'Stock', celda: (l) => cantidad(l.producto.stock), alinear: 'derecha' },
            {
              titulo: conSigno ? 'Cantidad (+ entra / − sale)' : 'Cantidad',
              fija: true,
              celda: (l, i) => <Input inputMode="decimal" value={l.cantidad} aria-label={`Cantidad de ${l.producto.nombre}`} placeholder={conSigno ? 'ej. -2' : '0'} onChange={(e) => setLineas(lineas.map((x, j) => (j === i ? { ...x, cantidad: e.target.value.replace(',', '.') } : x)))} />,
            },
            { titulo: '', celda: (_, i) => <Boton chico variante="plano" icono={Trash2} aria-label="Quitar" onClick={() => setLineas(lineas.filter((_, j) => j !== i))} /> },
          ]}
        />
      )}
    </div>
  );
}

function AjusteDialogo({ alCerrar }: { alCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { sesion } = useSesion();
  const [motivo, setMotivo] = useState('');
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Una clave por ajuste: reintentar tras un fallo de red no duplica el movimiento.
  const [clave] = useState(() => crypto.randomUUID());

  const guardar = async () => {
    setError(null);
    const r = ajusteSchema.safeParse({ motivo, items: lineas.map((l) => ({ productoId: l.producto.id, cantidad: l.cantidad })) });
    if (!r.success) return setError(r.error.issues[0]?.message ?? 'Datos inválidos');
    setEnviando(true);
    try {
      await pedir('/inventario/ajustes', { cuerpo: r.data, idempotente: clave });
      await qc.invalidateQueries({ queryKey: ['productos'] });
      toast('Ajuste registrado', 'ok');
      alCerrar();
    } catch (err) {
      setError(mensajeStock(err));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialogo
      titulo={`Ajuste de inventario · ${sesion?.sucursalActiva?.nombre ?? ''}`}
      abierto
      ancho
      alCerrar={alCerrar}
      pie={
        <>
          <Boton onClick={alCerrar}>Cancelar</Boton>
          <Boton variante="primario" onClick={guardar} cargando={enviando} disabled={!lineas.length}>
            Registrar ajuste
          </Boton>
        </>
      }
    >
      <div className={ui.pila}>
        {error && <Franja tono="alerta">{error}</Franja>}
        <div className={ui.form}>
          <Campo etiqueta="Motivo" placeholder="Conteo físico, merma, rotura…" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
        </div>
        <Lineas lineas={lineas} setLineas={setLineas} conSigno />
        <span className={ui.ayuda}>Las salidas no pueden dejar el stock en negativo.</span>
      </div>
    </Dialogo>
  );
}

function TrasladoDialogo({ alCerrar }: { alCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { sesion } = useSesion();
  const { data: sucursales = [] } = useQuery({ queryKey: ['sucursales'], queryFn: () => pedir<SucursalDto[]>('/sucursales') });
  const destinos = sucursales.filter((s) => s.activo && s.id !== sesion?.sucursalActiva?.id);
  const [destino, setDestino] = useState('');
  const [nota, setNota] = useState('');
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [clave] = useState(() => crypto.randomUUID());

  const enviar = async () => {
    setError(null);
    const r = trasladoSchema.safeParse({ sucursalDestinoId: destino || destinos[0]?.id, nota: nota || undefined, items: lineas.map((l) => ({ productoId: l.producto.id, cantidad: l.cantidad })) });
    if (!r.success) return setError(r.error.issues[0]?.message ?? 'Datos inválidos');
    setEnviando(true);
    try {
      await pedir('/inventario/traslados', { cuerpo: r.data, idempotente: clave });
      await qc.invalidateQueries({ queryKey: ['productos'] });
      await qc.invalidateQueries({ queryKey: ['traslados'] });
      toast('Traslado enviado: la sucursal de destino debe confirmar la recepción', 'ok');
      alCerrar();
    } catch (err) {
      setError(mensajeStock(err));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialogo
      titulo={`Trasladar desde ${sesion?.sucursalActiva?.nombre ?? ''}`}
      abierto
      ancho
      alCerrar={alCerrar}
      pie={
        <>
          <Boton onClick={alCerrar}>Cancelar</Boton>
          <Boton variante="primario" onClick={enviar} cargando={enviando} disabled={!lineas.length || !destinos.length}>
            Enviar traslado
          </Boton>
        </>
      }
    >
      <div className={ui.pila}>
        {error && <Franja tono="alerta">{error}</Franja>}
        <div className={ui.form}>
          <Selector etiqueta="Sucursal de destino" ancho="mitad" value={destino || String(destinos[0]?.id ?? '')} onChange={(e) => setDestino(e.target.value)} opciones={destinos.map((s) => ({ valor: String(s.id), texto: s.nombre }))} />
          <Campo etiqueta="Nota" ancho="mitad" opcional value={nota} onChange={(e) => setNota(e.target.value)} />
        </div>
        <Lineas lineas={lineas} setLineas={setLineas} />
        <Franja>El stock sale de esta sucursal al enviar y entra al destino cuando lo reciban. Después de enviarlo, emite la guía de remisión desde la lista de traslados.</Franja>
      </div>
    </Dialogo>
  );
}

function Traslados() {
  const { puede, sesion } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const [estado, setEstado] = useState('');
  const { data = [] } = useQuery({ queryKey: ['traslados', estado], queryFn: () => pedir<TrasladoDto[]>(`/inventario/traslados${estado ? `?estado=${estado}` : ''}`) });
  const mias = new Set(sesion?.sucursales.map((s) => s.id));
  const [nuevo, setNuevo] = useState(false);
  const navegar = useNavigate();

  const accion = async (t: TrasladoDto, que: 'recibir' | 'anular') => {
    try {
      await pedir(`/inventario/traslados/${t.id}/${que}`, { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['traslados'] });
      await qc.invalidateQueries({ queryKey: ['productos'] });
      toast(que === 'recibir' ? 'Traslado recibido: el stock ya está en esta sucursal' : 'Traslado anulado: el stock volvió al origen', 'ok');
    } catch (err) {
      toast(mensajeStock(err), 'error');
    }
  };

  return (
    <>
      <div className={css.filtros}>
        <Selector value={String(estado)} onChange={(e) => setEstado(e.target.value)} aria-label="Estado" opciones={[{ valor: '', texto: 'Todos' }, { valor: 'enviado', texto: 'En tránsito' }, { valor: 'recibido', texto: 'Recibidos' }, { valor: 'anulado', texto: 'Anulados' }]} />
        <span style={{ flex: 1 }} />
        {puede('inventario.trasladar') && (
          <Boton variante="primario" icono={Plus} onClick={() => setNuevo(true)}>
            Nuevo traslado
          </Boton>
        )}
      </div>
      <Tabla
        filas={data}
        clave={(t) => t.id}
        vacio="No hay traslados."
        columnas={[
          { titulo: 'N°', celda: (t) => <span className="font-id">{t.id}</span> },
          { titulo: 'Ruta', celda: (t) => <>{t.origen.nombre} → {t.destino.nombre}<span className={ui.sub}>{fechaHora(t.creadoEn)} · {t.enviadoPor}</span></> },
          { titulo: 'Productos', celda: (t) => t.items.map((i) => `${cantidad(i.cantidad)} × ${i.nombre}`).join(', ') },
          { titulo: 'Estado', celda: (t) => (t.estado === 'enviado' ? <Chip tono="info">En tránsito</Chip> : t.estado === 'recibido' ? <Chip tono="ok">Recibido</Chip> : <Chip>Anulado</Chip>) },
          {
            titulo: '',
            celda: (t) => (
              <div className={ui.acciones}>
                {t.estado !== 'anulado' && puede('guias.crear') && sesion?.sucursalActiva?.id === t.origen.id && <Boton chico onClick={() => navegar(`/guias?trasladoId=${t.id}`)}>Guía</Boton>}
                {t.estado === 'enviado' && puede('inventario.trasladar') && mias.has(t.destino.id) && <Boton chico variante="primario" onClick={() => void accion(t, 'recibir')}>Recibir</Boton>}
                {t.estado === 'enviado' && puede('inventario.trasladar') && mias.has(t.origen.id) && <Boton chico variante="plano" onClick={() => void accion(t, 'anular')}>Anular</Boton>}
              </div>
            ),
          },
        ]}
      />
      {nuevo && <TrasladoDialogo alCerrar={() => setNuevo(false)} />}
    </>
  );
}
