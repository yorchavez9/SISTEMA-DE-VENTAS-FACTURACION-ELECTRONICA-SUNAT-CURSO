import { anularSchema, compraSchema, TIPOS_DOC_COMPRA, type CompraDto, type EmpresaDto, type Pagina, type ProductoDto, type ProveedorDto, type TipoCambioDto, type TipoDocCompra } from '@sv/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Plus, ShoppingBag, Trash2, Truck } from 'lucide-react';
import { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { BuscadorProducto, useRetardo } from '../../components/comunes';
import css from '../../components/comunes.module.css';
import { Boton, Campo, Casilla, Chip, Dialogo, Encabezado, Franja, Pestanas, Selector, Tabla, ui, useToast, SelectorFecha } from '../../components/ui';
import { cantidad, dinero, hoyLima } from '../../lib/formato';
import { ErrorHttp, mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';
import { TerceroDialogo, TercerosLista } from '../terceros/TercerosLista';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function ComprasPage() {
  const { puede } = useSesion();
  return (
    <>
      <Encabezado titulo="Compras" />
      <Pestanas items={[{ ruta: '/compras', texto: 'Compras', icono: ShoppingBag }, ...(puede('proveedores.ver') ? [{ ruta: '/compras/proveedores', texto: 'Proveedores', icono: Truck }] : [])]} />
      <Routes>
        <Route index element={<ListaCompras />} />
        <Route path="proveedores" element={<TercerosLista recurso="proveedores" />} />
      </Routes>
    </>
  );
}

function ListaCompras() {
  const { puede, sesion } = useSesion();
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [estado, setEstado] = useState('');
  const [buscar, setBuscar] = useState('');
  const [page, setPage] = useState(1);
  const [nueva, setNueva] = useState(false);
  const [viendo, setViendo] = useState<number | null>(null);
  const q = useRetardo(buscar);

  const params = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (desde) params.set('desde', desde);
  if (hasta) params.set('hasta', hasta);
  if (estado) params.set('estado', estado);
  if (q) params.set('q', q);
  const { data } = useQuery({ queryKey: ['compras', params.toString(), sesion?.sucursalActiva?.id], queryFn: () => pedir<Pagina<CompraDto>>(`/compras?${params}`), placeholderData: keepPreviousData });

  return (
    <>
      <div className={css.filtros}>
        <Input type="search" placeholder="Proveedor o N° de comprobante" value={buscar} onChange={(e) => (setBuscar(e.target.value), setPage(1))} aria-label="Buscar" />
        <SelectorFecha value={desde} max={hasta || undefined} onChange={(v) => (setDesde(v), setPage(1))} aria-label="Desde" />
        <SelectorFecha value={hasta} min={desde || undefined} onChange={(v) => (setHasta(v), setPage(1))} aria-label="Hasta" />
        <Selector value={String(estado)} onChange={(e) => (setEstado(e.target.value), setPage(1))} aria-label="Estado" opciones={[{ valor: '', texto: 'Todas' }, { valor: 'registrada', texto: 'Registradas' }, { valor: 'anulada', texto: 'Anuladas' }]} />
        <span style={{ flex: 1 }} />
        {puede('compras.crear') && (
          <Boton variante="primario" icono={Plus} onClick={() => setNueva(true)}>
            Registrar compra
          </Boton>
        )}
      </div>
      <Tabla
        filas={data?.data ?? []}
        clave={(c) => c.id}
        vacio="No hay compras registradas."
        columnas={[
          { titulo: 'Fecha', celda: (c) => <span className="font-id">{c.fecha}</span> },
          { titulo: 'Comprobante', celda: (c) => <>{TIPOS_DOC_COMPRA[c.tipoDocCompra]} <span className="font-id">{c.serieNumero}</span><span className={ui.sub}>{c.sucursal.nombre}</span></> },
          { titulo: 'Proveedor', celda: (c) => <>{c.proveedor.razonSocial}<span className={`${ui.sub} font-id`}>{c.proveedor.numDoc}</span></> },
          { titulo: 'Total', celda: (c) => dinero(c.total, c.moneda), alinear: 'derecha' },
          { titulo: 'Estado', celda: (c) => (c.estado === 'registrada' ? <Chip tono="ok">Registrada</Chip> : <Chip>Anulada</Chip>) },
          { titulo: '', celda: (c) => <div className={ui.acciones}><Boton chico icono={Eye} onClick={() => setViendo(c.id)}>Ver</Boton></div> },
        ]}
        paginacion={data && { page: data.page, pageSize: data.pageSize, total: data.total, alCambiar: setPage }}
      />
      {nueva && <NuevaCompra alCerrar={() => setNueva(false)} />}
      {viendo && <DetalleCompra id={viendo} alCerrar={() => setViendo(null)} />}
    </>
  );
}

interface LineaCompra {
  producto: ProductoDto;
  cantidad: string;
  costoUnitario: string;
}

/** Vista previa de los totales con las mismas reglas que el servidor (el servidor confirma). */
function previsualizar(lineas: LineaCompra[], tipoDoc: TipoDocCompra, incluyeIgv: boolean, tasa: number) {
  const factor = 1 + tasa / 100;
  let base = 0;
  let total = 0;
  for (const l of lineas) {
    const bruto = Math.round(Number(l.cantidad || 0) * Number(l.costoUnitario || 0) * 100) / 100;
    if (tipoDoc !== '01') {
      base += bruto;
      total += bruto;
    } else if (incluyeIgv) {
      total += bruto;
      base += Math.round((bruto / factor) * 100) / 100;
    } else {
      base += bruto;
      total += Math.round(bruto * factor * 100) / 100;
    }
  }
  return { subtotal: base, igv: total - base, total };
}

function NuevaCompra({ alCerrar }: { alCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { sesion, puede } = useSesion();
  const { data: empresa } = useQuery({ queryKey: ['empresa'], queryFn: () => pedir<EmpresaDto>('/empresa'), enabled: puede('config.ver') });
  const { data: tc } = useQuery({ queryKey: ['tipo-cambio-hoy'], queryFn: () => pedir<TipoCambioDto>('/tipos-cambio/hoy'), retry: false });
  const tasa = Number(empresa?.tasaIgv ?? 18);

  const [proveedor, setProveedor] = useState<ProveedorDto | null>(null);
  const [buscarProv, setBuscarProv] = useState('');
  const qProv = useRetardo(buscarProv.trim(), 250);
  const { data: proveedores } = useQuery({ queryKey: ['proveedores', 'buscar', qProv], queryFn: () => pedir<Pagina<ProveedorDto>>(`/proveedores?pageSize=8&q=${encodeURIComponent(qProv)}`), enabled: qProv.length >= 2 && !proveedor });
  const [nuevoProveedor, setNuevoProveedor] = useState(false);

  const [tipoDoc, setTipoDoc] = useState<TipoDocCompra>('01');
  const [serieNumero, setSerieNumero] = useState('');
  const [fecha, setFecha] = useState(hoyLima());
  const [moneda, setMoneda] = useState<'PEN' | 'USD'>('PEN');
  const [tipoCambio, setTipoCambio] = useState('');
  const [incluyeIgv, setIncluyeIgv] = useState(true);
  const [nota, setNota] = useState('');
  const [lineas, setLineas] = useState<LineaCompra[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [clave] = useState(() => crypto.randomUUID());

  const totales = previsualizar(lineas, tipoDoc, incluyeIgv, tasa);
  const tipoCambioEfectivo = tipoCambio || tc?.venta || '';

  const guardar = async () => {
    setError(null);
    const r = compraSchema.safeParse({
      proveedorId: proveedor?.id,
      tipoDocCompra: tipoDoc,
      serieNumero,
      fecha,
      moneda,
      tipoCambio: moneda === 'USD' ? tipoCambioEfectivo || undefined : undefined,
      preciosIncluyenIgv: incluyeIgv,
      nota: nota || undefined,
      items: lineas.map((l) => ({ productoId: l.producto.id, cantidad: l.cantidad, costoUnitario: l.costoUnitario })),
    });
    if (!r.success) return setError(r.error.issues.map((i) => i.message).filter((m, i, a) => a.indexOf(m) === i).join(' · '));
    setEnviando(true);
    try {
      await pedir('/compras', { cuerpo: r.data, idempotente: clave });
      await qc.invalidateQueries({ queryKey: ['compras'] });
      await qc.invalidateQueries({ queryKey: ['productos'] });
      toast('Compra registrada y stock actualizado', 'ok');
      alCerrar();
    } catch (err) {
      setError(err instanceof ErrorHttp && Object.keys(err.campos).length ? Object.values(err.campos).join(' · ') : mensajeError(err));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialogo
      titulo={`Registrar compra · ${sesion?.sucursalActiva?.nombre ?? ''}`}
      abierto
      ancho
      fijo
      alCerrar={alCerrar}
      pie={
        <>
          <Boton onClick={alCerrar}>Cancelar</Boton>
          <Boton variante="primario" onClick={guardar} cargando={enviando} disabled={!lineas.length || !proveedor}>
            Registrar compra
          </Boton>
        </>
      }
    >
      <div className={ui.pila}>
        {error && <Franja tono="alerta">{error}</Franja>}
        <div className={ui.form}>
          <div className={ui.campo}>
            <Label htmlFor={proveedor ? 'proveedor-elegido' : undefined}>Proveedor</Label>
            {proveedor ? (
              <div className="flex gap-2">
                <Input id="proveedor-elegido" readOnly value={`${proveedor.razonSocial} · ${proveedor.numDoc}`} />
                <Boton onClick={() => setProveedor(null)}>Cambiar</Boton>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <Command shouldFilter={false} className="flex-1 relative overflow-visible rounded-md border border-input bg-transparent font-normal shadow-xs focus-within:border-ring dark:bg-input/30 [&_[data-slot=command-input-wrapper]]:border-0">
                  <CommandInput placeholder="Busca por razón social o RUC" value={buscarProv} onValueChange={setBuscarProv} autoFocus aria-label="Buscar proveedor" />
                  {qProv.length >= 2 && (
                    <CommandList className="absolute top-full right-0 left-0 z-50 mt-1 max-h-72 rounded-md bg-background shadow-[var(--sombra-flotante)]">
                      <CommandEmpty>Sin resultados</CommandEmpty>
                      {proveedores?.data.map((p) => (
                        <CommandItem key={p.id} value={String(p.id)} onSelect={() => (setProveedor(p), setBuscarProv(''))}>
                          <span>
                            {p.razonSocial}
                            <span className="block text-xs text-muted-foreground">{p.numDoc}</span>
                          </span>
                        </CommandItem>
                      ))}
                    </CommandList>
                  )}
                </Command>
                {puede('proveedores.editar') && <Boton icono={Plus} onClick={() => setNuevoProveedor(true)}>Nuevo</Boton>}
              </div>
            )}
          </div>
          <Selector etiqueta="Comprobante" ancho="cuarto" value={tipoDoc} onChange={(e) => setTipoDoc(e.target.value as TipoDocCompra)} opciones={Object.entries(TIPOS_DOC_COMPRA).map(([v, t]) => ({ valor: v, texto: t }))} />
          <Campo etiqueta="Serie y número" ancho="cuarto" className="font-id" placeholder="F001-123" value={serieNumero} onChange={(e) => setSerieNumero(e.target.value.toUpperCase())} />
          <Campo etiqueta="Fecha" type="date" ancho="cuarto" max={hoyLima()} value={fecha} onChange={(e) => setFecha(e.target.value)} />
          <Selector etiqueta="Moneda" ancho="cuarto" value={moneda} onChange={(e) => setMoneda(e.target.value as 'PEN' | 'USD')} opciones={[{ valor: 'PEN', texto: 'Soles' }, { valor: 'USD', texto: 'Dólares' }]} />
          {moneda === 'USD' && (
            <Campo etiqueta="Tipo de cambio" ancho="cuarto" inputMode="decimal" placeholder={tc?.venta ?? '3.7520'} value={tipoCambio} onChange={(e) => setTipoCambio(e.target.value)} ayuda={tc ? `Venta de hoy: ${tc.venta}` : 'No hay tipo de cambio de hoy registrado'} />
          )}
          <Campo etiqueta="Nota" ancho={moneda === 'USD' ? 'mitad' : 'mitad'} opcional value={nota} onChange={(e) => setNota(e.target.value)} />
        </div>
        {tipoDoc === '01' ? (
          <Casilla etiqueta="Los costos incluyen IGV" checked={incluyeIgv} onChange={(e) => setIncluyeIgv(e.target.checked)} />
        ) : (
          <span className={ui.ayuda}>En boletas y tickets el IGV no es recuperable: el costo del inventario es el precio pagado.</span>
        )}

        <BuscadorProducto alElegir={(p) => !lineas.some((l) => l.producto.id === p.id) && setLineas([...lineas, { producto: p, cantidad: '', costoUnitario: '' }])} />
        {lineas.length > 0 && (
          <Tabla
            filas={lineas}
            clave={(l) => l.producto.id}
            columnas={[
              { titulo: 'Producto', celda: (l) => <>{l.producto.nombre}<span className={ui.sub}>{l.producto.codigo} · {l.producto.unidad.codigoSunat}</span></> },
              { titulo: 'Cantidad', fija: true, celda: (l, i) => <Input className="w-24" inputMode="decimal" value={l.cantidad} aria-label="Cantidad" onChange={(e) => setLineas(lineas.map((x, j) => (j === i ? { ...x, cantidad: e.target.value.replace(',', '.') } : x)))} /> },
              { titulo: `Costo unitario (${moneda === 'USD' ? 'US$' : 'S/'})`, celda: (l, i) => <Input className="w-28" inputMode="decimal" value={l.costoUnitario} aria-label="Costo unitario" onChange={(e) => setLineas(lineas.map((x, j) => (j === i ? { ...x, costoUnitario: e.target.value.replace(',', '.') } : x)))} /> },
              { titulo: 'Importe', alinear: 'derecha', celda: (l) => dinero(Number(l.cantidad || 0) * Number(l.costoUnitario || 0), moneda) },
              { titulo: '', celda: (_, i) => <Boton chico variante="plano" icono={Trash2} aria-label="Quitar" onClick={() => setLineas(lineas.filter((_, j) => j !== i))} /> },
            ]}
          />
        )}
        {lineas.length > 0 && (
          <div className={css.totales}>
            <span>Subtotal</span>
            <strong className="num">{dinero(totales.subtotal, moneda)}</strong>
            <span>IGV {tipoDoc === '01' ? `${tasa}%` : '(no discriminado)'}</span>
            <strong className="num">{dinero(totales.igv, moneda)}</strong>
            <span>Total</span>
            <strong className="num">{dinero(totales.total, moneda)}</strong>
          </div>
        )}
      </div>
      {nuevoProveedor && (
        <TerceroDialogo
          recurso="proveedores"
          tercero={null}
          inicial={/^\d{11}$/.test(buscarProv.trim()) ? { tipoDoc: '6', numDoc: buscarProv.trim() } : undefined}
          alCerrar={() => setNuevoProveedor(false)}
          alGuardar={(p) => setProveedor(p as ProveedorDto)}
        />
      )}
    </Dialogo>
  );
}

function DetalleCompra({ id, alCerrar }: { id: number; alCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { puede } = useSesion();
  const { data: c } = useQuery({ queryKey: ['compra', id], queryFn: () => pedir<CompraDto>(`/compras/${id}`) });
  const [anulando, setAnulando] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const anular = async () => {
    const r = anularSchema.safeParse({ motivo });
    if (!r.success) return setError(r.error.issues[0]?.message ?? 'Motivo inválido');
    setEnviando(true);
    setError(null);
    try {
      await pedir(`/compras/${id}/anular`, { cuerpo: r.data });
      await qc.invalidateQueries({ queryKey: ['compras'] });
      await qc.invalidateQueries({ queryKey: ['compra', id] });
      await qc.invalidateQueries({ queryKey: ['productos'] });
      toast('Compra anulada y stock revertido', 'ok');
      setAnulando(false);
    } catch (err) {
      setError(mensajeError(err));
    } finally {
      setEnviando(false);
    }
  };

  if (!c) return null;
  return (
    <Dialogo
      titulo={`${TIPOS_DOC_COMPRA[c.tipoDocCompra]} ${c.serieNumero}`}
      abierto
      ancho
      alCerrar={alCerrar}
      pie={
        <>
          {c.estado === 'registrada' && puede('compras.anular') && !anulando && (
            <Boton variante="plano" onClick={() => setAnulando(true)}>
              Anular compra
            </Boton>
          )}
          {anulando && (
            <Boton variante="peligro" onClick={anular} cargando={enviando}>
              Confirmar anulación
            </Boton>
          )}
          <Boton onClick={alCerrar}>Cerrar</Boton>
        </>
      }
    >
      <div className={ui.pila}>
        {c.estado === 'anulada' && <Franja tono="aviso">Anulada: {c.motivoAnulacion}</Franja>}
        <div className={ui.form}>
          <Campo etiqueta="Proveedor" readOnly ancho="mitad" value={`${c.proveedor.razonSocial} · ${c.proveedor.numDoc}`} />
          <Campo etiqueta="Fecha" readOnly ancho="cuarto" value={c.fecha} />
          <Campo etiqueta="Sucursal" readOnly ancho="cuarto" value={c.sucursal.nombre} />
        </div>
        <Tabla
          filas={c.items ?? []}
          clave={(i) => i.productoId}
          columnas={[
            { titulo: 'Producto', celda: (i) => <>{i.nombre}<span className={ui.sub}>{i.codigo}</span></> },
            { titulo: 'Cantidad', celda: (i) => cantidad(i.cantidad), alinear: 'derecha' },
            { titulo: 'Costo', celda: (i) => dinero(i.costoUnitario, c.moneda), alinear: 'derecha' },
            { titulo: 'Costo inventario', celda: (i) => dinero(i.costoNetoPen), alinear: 'derecha' },
            { titulo: 'Importe', celda: (i) => dinero(i.total, c.moneda), alinear: 'derecha' },
          ]}
        />
        <div className={css.totales}>
          <span>Subtotal</span>
          <strong className="num">{dinero(c.subtotal, c.moneda)}</strong>
          <span>IGV</span>
          <strong className="num">{dinero(c.igv, c.moneda)}</strong>
          <span>Total</span>
          <strong className="num">{dinero(c.total, c.moneda)}</strong>
          {c.moneda === 'USD' && (
            <>
              <span>Tipo de cambio</span>
              <strong className="num">{c.tipoCambio}</strong>
            </>
          )}
        </div>
        {anulando && (
          <>
            {error && <Franja tono="alerta">{error}</Franja>}
            <div className={ui.form}>
              <Campo etiqueta="Motivo de la anulación" value={motivo} onChange={(e) => setMotivo(e.target.value)} ayuda="Se revierte la entrada de stock. Si la mercadería ya se vendió, no se podrá anular." />
            </div>
          </>
        )}
      </div>
    </Dialogo>
  );
}
