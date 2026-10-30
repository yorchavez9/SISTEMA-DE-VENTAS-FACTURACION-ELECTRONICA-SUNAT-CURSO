import { AFECTACIONES_IGV, categoriaSchema, productoSchema, type CategoriaDto, type Pagina, type ProductoDto, type UnidadDto } from '@sv/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Package, Pencil, Plus, Tags } from 'lucide-react';
import { useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { useRetardo } from '../../components/comunes';
import { CampoImagen, MiniaturaProducto, type CambioImagen } from '../../components/ImagenProducto';
import filtros from '../../components/comunes.module.css';
import { Boton, Campo, Casilla, Chip, Dialogo, Encabezado, Franja, Pestanas, Selector, Tabla, ui, useToast } from '../../components/ui';
import { cantidad, dinero } from '../../lib/formato';
import { useFormulario } from '../../lib/formulario';
import { mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';
import { Input } from '@/components/ui/input';

export function ProductosPage() {
  return (
    <>
      <Encabezado titulo="Productos" />
      <Pestanas items={[{ ruta: '/productos', texto: 'Productos', icono: Package }, { ruta: '/productos/categorias', texto: 'Categorías', icono: Tags }]} />
      <Routes>
        <Route index element={<ListaProductos />} />
        <Route path="categorias" element={<Categorias />} />
      </Routes>
    </>
  );
}

export const useCategorias = () => useQuery({ queryKey: ['categorias'], queryFn: () => pedir<CategoriaDto[]>('/categorias') });
export const useUnidades = () => useQuery({ queryKey: ['unidades'], queryFn: () => pedir<UnidadDto[]>('/unidades'), staleTime: Infinity });

function ListaProductos() {
  const { puede, sesion } = useSesion();
  const editable = puede('productos.editar');
  const [buscar, setBuscar] = useState('');
  const [categoriaId, setCategoriaId] = useState('');
  const [activo, setActivo] = useState<'true' | 'false' | 'todos'>('true');
  const [soloBajo, setSoloBajo] = useState(false);
  const [page, setPage] = useState(1);
  const [editando, setEditando] = useState<ProductoDto | 'nuevo' | null>(null);
  const q = useRetardo(buscar);
  const { data: categorias = [] } = useCategorias();

  const params = new URLSearchParams({ page: String(page), pageSize: '25', activo });
  if (q) params.set('q', q);
  if (categoriaId) params.set('categoriaId', categoriaId);
  if (soloBajo) params.set('stockBajo', 'true');
  const { data } = useQuery({ queryKey: ['productos', params.toString(), sesion?.sucursalActiva?.id], queryFn: () => pedir<Pagina<ProductoDto>>(`/productos?${params}`), placeholderData: keepPreviousData });

  const reiniciar = <T,>(fijar: (v: T) => void) => (v: T) => {
    fijar(v);
    setPage(1);
  };

  return (
    <>
      <div className={filtros.filtros}>
        <Input type="search" placeholder="Buscar por nombre, código o código de barras" value={buscar} onChange={(e) => reiniciar(setBuscar)(e.target.value)} aria-label="Buscar productos" />
        <Selector value={String(categoriaId)} onChange={(e) => reiniciar(setCategoriaId)(e.target.value)} aria-label="Categoría" opciones={[{ valor: '', texto: 'Todas las categorías' }, ...categorias.map((c) => ({ valor: String(c.id), texto: c.nombre }))]} />
        <Selector value={String(activo)} onChange={(e) => reiniciar(setActivo)(e.target.value as typeof activo)} aria-label="Estado" opciones={[{ valor: 'true', texto: 'Activos' }, { valor: 'false', texto: 'Desactivados' }, { valor: 'todos', texto: 'Todos' }]} />
        <Casilla etiqueta="Solo stock bajo" checked={soloBajo} onChange={(e) => reiniciar(setSoloBajo)(e.target.checked)} />
        <span style={{ flex: 1 }} />
        {editable && (
          <Boton variante="primario" icono={Plus} onClick={() => setEditando('nuevo')}>
            Nuevo producto
          </Boton>
        )}
      </div>
      <Tabla
        filas={data?.data ?? []}
        clave={(p) => p.id}
        vacio={q ? 'Ningún producto coincide con la búsqueda.' : 'Aún no hay productos.'}
        columnas={[
          {
            titulo: 'Producto',
            celda: (p) => (
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <MiniaturaProducto url={p.imagenUrl} nombre={p.nombre} />
                <span>{p.nombre}<span className={ui.sub}>{p.codigo}{p.codigoBarras ? ` · ${p.codigoBarras}` : ''}{p.categoria ? ` · ${p.categoria.nombre}` : ''}</span></span>
              </span>
            ),
          },
          { titulo: 'Unidad', celda: (p) => <span title={p.unidad.nombre}>{p.unidad.codigoSunat}</span> },
          { titulo: 'IGV', celda: (p) => (p.tipAfeIgv === '10' ? 'Gravado' : p.tipAfeIgv === '20' ? 'Exonerado' : 'Inafecto') },
          { titulo: 'Precio', celda: (p) => <>{dinero(p.precioVenta)}{p.precioVentaUsd && <span className={ui.sub}>{dinero(p.precioVentaUsd, 'USD')}</span>}</>, alinear: 'derecha' },
          { titulo: `Stock ${sesion?.sucursalActiva?.nombre ?? ''}`, celda: (p) => (p.inventariable ? <>{cantidad(p.stock)}{p.stockBajo && <span className={ui.sub}><Chip tono="aviso">Bajo (mín. {cantidad(p.stockMinimo)})</Chip></span>}</> : <span className="muted">Servicio</span>), alinear: 'derecha' },
          { titulo: 'Estado', celda: (p) => (p.activo ? <Chip tono="ok">Activo</Chip> : <Chip>Desactivado</Chip>) },
          { titulo: '', celda: (p) => editable && <div className={ui.acciones}><Boton chico icono={Pencil} onClick={() => setEditando(p)}>Editar</Boton></div> },
        ]}
        paginacion={data && { page: data.page, pageSize: data.pageSize, total: data.total, alCambiar: setPage }}
      />
      {editando && <ProductoDialogo producto={editando === 'nuevo' ? null : editando} alCerrar={() => setEditando(null)} />}
    </>
  );
}

function ProductoDialogo({ producto, alCerrar }: { producto: ProductoDto | null; alCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { sesion } = useSesion();
  const { data: unidades = [] } = useUnidades();
  const { data: categorias = [] } = useCategorias();
  const niu = unidades.find((u) => u.codigoSunat === 'NIU');
  const f = useFormulario({
    codigo: producto?.codigo ?? '',
    codigoBarras: producto?.codigoBarras ?? '',
    nombre: producto?.nombre ?? '',
    descripcion: producto?.descripcion ?? '',
    categoriaId: producto?.categoria?.id ? String(producto.categoria.id) : '',
    unidadId: producto ? String(producto.unidad.id) : '',
    tipo: producto?.tipo ?? ('bien' as 'bien' | 'servicio'),
    inventariable: producto?.inventariable ?? true,
    tipAfeIgv: producto?.tipAfeIgv ?? ('10' as '10' | '20' | '30'),
    codProductoSunat: producto?.codProductoSunat ?? '',
    precioVenta: producto ? String(Number(producto.precioVenta)) : '',
    precioVentaUsd: producto?.precioVentaUsd ? String(Number(producto.precioVentaUsd)) : '',
    stockMinimo: producto ? String(Number(producto.stockMinimo)) : '0',
    pesoKg: producto?.pesoKg ? String(Number(producto.pesoKg)) : '',
    activo: producto?.activo ?? true,
    stockInicial: '',
  });
  const unidadId = f.valores.unidadId || (niu ? String(niu.id) : '');
  const [imagen, setImagen] = useState<CambioImagen>({ tipo: 'sin_cambio' });

  const guardar = async () => {
    const datos = f.validar(productoSchema, { ...f.valores, unidadId, categoriaId: f.valores.categoriaId || null, stockInicial: producto ? undefined : f.valores.stockInicial });
    if (!datos) return;
    try {
      await f.enviar(async () => {
        const p = producto ? await pedir<ProductoDto>(`/productos/${producto.id}`, { method: 'PUT', cuerpo: datos }) : await pedir<ProductoDto>('/productos', { cuerpo: datos });
        // La imagen va aparte, después de guardar los datos (en un producto nuevo hace falta su id).
        try {
          if (imagen.tipo === 'nueva') await pedir(`/productos/${p.id}/imagen`, { method: 'PUT', cuerpo: imagen.archivo });
          if (imagen.tipo === 'quitar') await pedir(`/productos/${p.id}/imagen`, { method: 'DELETE' });
        } catch (err) {
          toast(`El producto se guardó, pero no la imagen: ${mensajeError(err)}`, 'error');
        }
      });
      await qc.invalidateQueries({ queryKey: ['productos'] });
      await qc.invalidateQueries({ queryKey: ['categorias'] });
      toast(producto ? 'Producto actualizado' : 'Producto creado', 'ok');
      alCerrar();
    } catch (err) {
      toast(mensajeError(err), 'error');
    }
  };

  return (
    <Dialogo
      titulo={producto ? `Editar ${producto.nombre}` : 'Nuevo producto'}
      abierto
      ancho
      alCerrar={alCerrar}
      pie={
        <>
          <Boton onClick={alCerrar}>Cancelar</Boton>
          <Boton variante="primario" onClick={guardar} cargando={f.enviando}>
            Guardar
          </Boton>
        </>
      }
    >
      <div className={ui.form}>
        <Campo etiqueta="Código" ancho="cuarto" className="font-id" {...f.texto('codigo')} onChange={(e) => f.fijar('codigo', e.target.value.toUpperCase())} />
        <Campo etiqueta="Nombre" ancho="mitad" {...f.texto('nombre')} />
        <Campo etiqueta="Código de barras" ancho="cuarto" opcional className="font-id" {...f.texto('codigoBarras')} />
        <Selector
          etiqueta="Tipo"
          ancho="cuarto"
          value={f.valores.tipo}
          onChange={(e) => {
            const tipo = e.target.value as 'bien' | 'servicio';
            f.fijar('tipo', tipo);
            if (tipo === 'servicio') f.fijar('inventariable', false);
          }}
          opciones={[{ valor: 'bien', texto: 'Bien' }, { valor: 'servicio', texto: 'Servicio' }]}
        />
        <Selector etiqueta="Unidad" ancho="cuarto" value={unidadId} onChange={(e) => f.fijar('unidadId', e.target.value)} error={f.errores.unidadId} opciones={unidades.map((u) => ({ valor: String(u.id), texto: `${u.codigoSunat} · ${u.nombre}` }))} />
        <Selector etiqueta="Categoría" ancho="mitad" value={f.valores.categoriaId} onChange={(e) => f.fijar('categoriaId', e.target.value)} opciones={[{ valor: '', texto: 'Sin categoría' }, ...categorias.filter((c) => c.activo || String(c.id) === f.valores.categoriaId).map((c) => ({ valor: String(c.id), texto: c.nombre }))]} />
        <Selector
          etiqueta="Afectación del IGV"
          ancho="mitad"
          value={f.valores.tipAfeIgv}
          onChange={(e) => f.fijar('tipAfeIgv', e.target.value as '10' | '20' | '30')}
          opciones={Object.entries(AFECTACIONES_IGV).map(([v, t]) => ({ valor: v, texto: t }))}
        />
        <Campo etiqueta={f.valores.tipAfeIgv === '10' ? 'Precio de venta S/ (con IGV)' : 'Precio de venta S/'} ancho="cuarto" inputMode="decimal" {...f.texto('precioVenta')} />
        <Campo etiqueta="Precio US$" ancho="cuarto" inputMode="decimal" opcional ayuda="Si no se indica, se convierte con el tipo de cambio del día" {...f.texto('precioVentaUsd')} />
        <Campo etiqueta="Stock mínimo" ancho="cuarto" inputMode="decimal" disabled={!f.valores.inventariable} {...f.texto('stockMinimo')} />
        {!producto && (
          <Campo etiqueta={`Stock inicial (${sesion?.sucursalActiva?.nombre ?? 'sucursal'})`} ancho="cuarto" inputMode="decimal" opcional disabled={!f.valores.inventariable} {...f.texto('stockInicial')} />
        )}
        <Campo etiqueta="Código de producto SUNAT" ancho="cuarto" opcional className="font-id" maxLength={8} ayuda="8 dígitos (UNSPSC)" {...f.texto('codProductoSunat')} />
        <Campo etiqueta="Peso (kg)" ancho="cuarto" inputMode="decimal" opcional ayuda="Para la guía de remisión" {...f.texto('pesoKg')} />
        <Campo etiqueta="Descripción" opcional {...f.texto('descripcion')} />
        <CampoImagen actual={producto?.imagenUrl ?? null} cambio={imagen} alCambiar={setImagen} nombre={f.valores.nombre} />
      </div>
      <div className={ui.pila} style={{ marginTop: '1rem' }}>
        <Casilla etiqueta="Controlar stock (inventariable)" disabled={f.valores.tipo === 'servicio'} checked={f.valores.inventariable} onChange={(e) => f.fijar('inventariable', e.target.checked)} />
        {f.errores.inventariable && <span className={ui.error}>{f.errores.inventariable}</span>}
        {producto && <Casilla etiqueta="Producto activo" checked={f.valores.activo} onChange={(e) => f.fijar('activo', e.target.checked)} />}
        {producto && <Franja>El stock se modifica con compras, ajustes o traslados (Inventario), no desde aquí.</Franja>}
      </div>
    </Dialogo>
  );
}

function Categorias() {
  const { puede } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const editable = puede('productos.editar');
  const { data: categorias = [] } = useCategorias();
  const [editando, setEditando] = useState<CategoriaDto | 'nueva' | null>(null);
  const f = useFormulario({ nombre: '', activo: true });

  const abrir = (c: CategoriaDto | 'nueva') => {
    f.setValores(c === 'nueva' ? { nombre: '', activo: true } : { nombre: c.nombre, activo: c.activo });
    f.setErrores({});
    setEditando(c);
  };

  const guardar = async () => {
    const datos = f.validar(categoriaSchema);
    if (!datos || !editando) return;
    try {
      await f.enviar(() => (editando === 'nueva' ? pedir('/categorias', { cuerpo: datos }) : pedir(`/categorias/${editando.id}`, { method: 'PUT', cuerpo: datos })));
      await qc.invalidateQueries({ queryKey: ['categorias'] });
      toast('Categoría guardada', 'ok');
      setEditando(null);
    } catch (err) {
      toast(mensajeError(err), 'error');
    }
  };

  return (
    <>
      {editable && (
        <div className={filtros.filtros}>
          <span style={{ flex: 1 }} />
          <Boton variante="primario" icono={Plus} onClick={() => abrir('nueva')}>
            Nueva categoría
          </Boton>
        </div>
      )}
      <Tabla
        filas={categorias}
        clave={(c) => c.id}
        vacio="Aún no hay categorías."
        columnas={[
          { titulo: 'Categoría', celda: (c) => c.nombre },
          { titulo: 'Productos activos', celda: (c) => c.productos, alinear: 'derecha' },
          { titulo: 'Estado', celda: (c) => (c.activo ? <Chip tono="ok">Activa</Chip> : <Chip>Inactiva</Chip>) },
          { titulo: '', celda: (c) => editable && <div className={ui.acciones}><Boton chico icono={Pencil} onClick={() => abrir(c)}>Editar</Boton></div> },
        ]}
      />
      {editando && (
        <Dialogo
          titulo={editando === 'nueva' ? 'Nueva categoría' : `Editar ${editando.nombre}`}
          abierto
          alCerrar={() => setEditando(null)}
          pie={
            <>
              <Boton onClick={() => setEditando(null)}>Cancelar</Boton>
              <Boton variante="primario" onClick={guardar} cargando={f.enviando}>
                Guardar
              </Boton>
            </>
          }
        >
          <div className={ui.pila}>
            <div className={ui.form}>
              <Campo etiqueta="Nombre" {...f.texto('nombre')} />
            </div>
            {editando !== 'nueva' && <Casilla etiqueta="Categoría activa" checked={f.valores.activo} onChange={(e) => f.fijar('activo', e.target.checked)} />}
          </div>
        </Dialogo>
      )}
    </>
  );
}
