import { NOMBRE_TIPO_DOC, TIPOS_DOC_TERCERO, errorNumeroDocumento, type ProductoDto, type ResultadoBusquedaDocumento, type TipoDocTercero } from '@sv/shared';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { cantidad, dinero } from '../lib/formato';
import { mensajeError, pedir } from '../lib/http';
import { MiniaturaProducto } from './ImagenProducto';
import { Boton, Franja, ui, Selector } from './ui';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from './ui/command';
import { Input } from './ui/input';
import { Label } from './ui/label';
import css from './comunes.module.css';

/** Valor con retardo para no consultar en cada tecla. */
export function useRetardo<T>(valor: T, ms = 300): T {
  const [v, setV] = useState(valor);
  useEffect(() => {
    const t = setTimeout(() => setV(valor), ms);
    return () => clearTimeout(t);
  }, [valor, ms]);
  return v;
}

// ---------- Buscador de productos ----------

/** Busca productos por nombre, código o código de barras; Enter con coincidencia exacta lo elige directo. */
export function BuscadorProducto({
  alElegir, soloInventariables, placeholder = 'Buscar producto por nombre, código o código de barras',
}: { alElegir: (p: ProductoDto) => void; soloInventariables?: boolean; placeholder?: string }) {
  const [texto, setTexto] = useState('');
  const q = useRetardo(texto.trim(), 250);
  const { data } = useQuery({
    queryKey: ['productos-buscar', q],
    queryFn: () => pedir<{ data: ProductoDto[] }>(`/productos?pageSize=15&q=${encodeURIComponent(q)}`),
    enabled: q.length >= 2,
  });
  const resultados = (data?.data ?? []).filter((p) => !soloInventariables || p.inventariable);

  const elegir = (p: ProductoDto) => {
    alElegir(p);
    setTexto('');
  };

  // Command de shadcn (cmdk): flechas para recorrer, Enter elige. La búsqueda la hace el servidor.
  const exacto = resultados.find((p) => p.codigo === texto.trim().toUpperCase() || p.codigoBarras === texto.trim());
  return (
    <Command shouldFilter={false} className="relative overflow-visible rounded-md border border-input bg-transparent font-normal shadow-xs focus-within:border-ring dark:bg-input/30 [&_[data-slot=command-input-wrapper]]:border-0" value={exacto ? String(exacto.id) : undefined}>
      <CommandInput value={texto} onValueChange={setTexto} placeholder={placeholder} aria-label="Buscar producto" />
      {q.length >= 2 && texto && (
        <CommandList className="absolute top-full right-0 left-0 z-50 mt-1 max-h-80 rounded-md bg-background shadow-[var(--sombra-flotante)]">
          <CommandEmpty>Sin resultados</CommandEmpty>
          {resultados.map((p) => (
            <CommandItem key={p.id} value={String(p.id)} onSelect={() => elegir(p)} className="gap-3">
              <MiniaturaProducto url={p.imagenUrl} nombre={p.nombre} tam={32} />
              <span className="min-w-0 flex-1">
                <strong className="block truncate">{p.nombre}</strong>
                <span className="text-xs text-muted-foreground">
                  {p.codigo} · {p.unidad.codigoSunat}
                  {p.inventariable ? ` · stock ${cantidad(p.stock)}` : ' · servicio'}
                </span>
              </span>
              <span className="num">{dinero(p.precioVenta)}</span>
            </CommandItem>
          ))}
        </CommandList>
      )}
    </Command>
  );
}

// ---------- Documento de identidad con búsqueda ----------

export interface DatosDocumento {
  tipoDoc: TipoDocTercero;
  numDoc: string;
}

/**
 * Tipo y número de documento con botón de búsqueda (BD local → SUNAT/RENIEC vía API-PRO).
 * `alEncontrar` recibe el resultado para completar el formulario.
 */
export function CampoDocumento({
  valor, alCambiar, recurso, alEncontrar, error, deshabilitado,
}: {
  valor: DatosDocumento;
  alCambiar: (v: DatosDocumento) => void;
  recurso: 'clientes' | 'proveedores';
  alEncontrar: (r: ResultadoBusquedaDocumento) => void;
  error?: string;
  deshabilitado?: boolean;
}) {
  const idNumero = useId();
  const [buscando, setBuscando] = useState(false);
  const [aviso, setAviso] = useState<{ tono: 'aviso' | 'alerta' | 'ok' | 'info'; texto: string } | null>(null);
  const errorLocal = valor.numDoc ? errorNumeroDocumento(valor.tipoDoc, valor.numDoc) : null;
  const consultable = (valor.tipoDoc === '1' || valor.tipoDoc === '6') && !errorLocal && valor.numDoc;

  const buscar = async () => {
    if (errorLocal || !valor.numDoc) return;
    setBuscando(true);
    setAviso(null);
    try {
      const r = await pedir<ResultadoBusquedaDocumento>(`/${recurso}/buscar?tipoDoc=${valor.tipoDoc}&numDoc=${encodeURIComponent(valor.numDoc)}`);
      alEncontrar(r);
      if (r.origen === 'local') setAviso({ tono: 'info', texto: `Ya registrado: ${r.razonSocial}` });
      else if (r.origen === 'externo') setAviso({ tono: r.avisos.length ? 'aviso' : 'ok', texto: [`Encontrado${r.fuente ? ` en ${r.fuente}` : ''}: ${r.razonSocial}`, ...r.avisos].join(' · ') });
      else setAviso({ tono: 'aviso', texto: r.avisos[0] ?? 'No se encontró el documento: ingresa los datos manualmente.' });
    } catch (err) {
      setAviso({ tono: 'alerta', texto: mensajeError(err) });
    } finally {
      setBuscando(false);
    }
  };

  return (
    <>
      <Selector
        etiqueta="Documento"
        ancho="cuarto"
        value={String(valor.tipoDoc)}
        disabled={deshabilitado}
        onChange={(e) => alCambiar({ ...valor, tipoDoc: e.target.value as TipoDocTercero })}
        opciones={TIPOS_DOC_TERCERO.map((t) => ({ valor: t, texto: NOMBRE_TIPO_DOC[t] }))}
      />
      <div className={`${ui.campo} ${ui.mitad}`}>
        <Label htmlFor={idNumero}>Número</Label>
        <div className="flex gap-2">
          <Input
            id={idNumero}
            className="font-id"
            value={valor.numDoc}
            disabled={deshabilitado}
            aria-invalid={Boolean(error || errorLocal)}
            inputMode={valor.tipoDoc === '1' || valor.tipoDoc === '6' ? 'numeric' : 'text'}
            maxLength={15}
            onChange={(e) => alCambiar({ ...valor, numDoc: e.target.value.toUpperCase().trim() })}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void buscar())}
          />
          <Boton icono={Search} onClick={buscar} cargando={buscando} disabled={deshabilitado || !valor.numDoc || Boolean(errorLocal)} title={consultable ? 'Buscar en SUNAT/RENIEC' : 'Buscar'}>
            Buscar
          </Boton>
        </div>
        {(error || errorLocal) && <span className="text-xs text-destructive" role="alert">{error || errorLocal}</span>}
      </div>
      {aviso && (
        <div className={ui.campo}>
          <Franja tono={aviso.tono}>{aviso.texto}</Franja>
        </div>
      )}
    </>
  );
}
