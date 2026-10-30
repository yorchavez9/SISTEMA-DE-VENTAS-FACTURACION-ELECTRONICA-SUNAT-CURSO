import { ImagePlus, Package, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Boton, ui } from './ui';
import { Input } from './ui/input';
import { Label } from './ui/label';
import css from './imagen.module.css';

/** Foto del producto o, si no tiene, un ícono neutro del mismo tamaño. */
export function MiniaturaProducto({ url, nombre, tam = 40 }: { url: string | null; nombre: string; tam?: number }) {
  return (
    <span className={css.miniatura} style={{ width: tam, height: tam }}>
      {url ? <img src={url} alt={nombre} loading="lazy" width={tam} height={tam} /> : <Package size={Math.round(tam * 0.45)} strokeWidth={2} aria-hidden />}
    </span>
  );
}

export type CambioImagen = { tipo: 'sin_cambio' } | { tipo: 'nueva'; archivo: Blob; vista: string } | { tipo: 'quitar' };

const LADO_MAX = 800;

/**
 * Reduce la foto a 800 px de lado como máximo (WebP o, si el navegador no lo genera, JPEG).
 * Así se sube rápido y pesa poco en el servidor, aunque venga de la cámara del celular.
 */
async function reducir(archivo: File): Promise<{ blob: Blob; vista: string }> {
  const bmp = await createImageBitmap(archivo).catch(() => {
    throw new Error('No se pudo leer la imagen: usa una foto JPG, PNG o WebP');
  });
  const escala = Math.min(1, LADO_MAX / Math.max(bmp.width, bmp.height));
  const lienzo = document.createElement('canvas');
  lienzo.width = Math.round(bmp.width * escala);
  lienzo.height = Math.round(bmp.height * escala);
  lienzo.getContext('2d')!.drawImage(bmp, 0, 0, lienzo.width, lienzo.height);
  bmp.close();
  const comoBlob = (tipo: string) => new Promise<Blob | null>((ok) => lienzo.toBlob(ok, tipo, 0.85));
  let blob = await comoBlob('image/webp');
  if (!blob || blob.type !== 'image/webp') blob = await comoBlob('image/jpeg');
  if (!blob) throw new Error('No se pudo procesar la imagen');
  // Vista previa como data: (la política de seguridad de la app no permite blob: en imágenes).
  return { blob, vista: lienzo.toDataURL(blob.type, 0.85) };
}

/** Campo opcional de imagen: elegir, cambiar o quitar. No sube nada hasta que se guarda el producto. */
export function CampoImagen({ actual, cambio, alCambiar, nombre }: { actual: string | null; cambio: CambioImagen; alCambiar: (c: CambioImagen) => void; nombre: string }) {
  const entrada = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [procesando, setProcesando] = useState(false);
  const vista = cambio.tipo === 'nueva' ? cambio.vista : cambio.tipo === 'quitar' ? null : actual;

  const elegir = async (archivo: File | undefined) => {
    if (!archivo) return;
    setError(null);
    setProcesando(true);
    try {
      const { blob, vista: v } = await reducir(archivo);
      alCambiar({ tipo: 'nueva', archivo: blob, vista: v });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Imagen no válida');
    } finally {
      setProcesando(false);
      if (entrada.current) entrada.current.value = '';
    }
  };

  return (
    <div className={`${ui.campo}`}>
      <Label>
        Imagen <span className="font-normal text-muted-foreground">(opcional)</span>
      </Label>
      <div className={css.campo}>
        <MiniaturaProducto url={vista} nombre={nombre || 'Producto'} tam={96} />
        <div className={css.botones}>
          <Input ref={entrada} type="file" className="hidden" accept="image/jpeg,image/png,image/webp,image/*" onChange={(e) => void elegir(e.target.files?.[0])} aria-label="Elegir imagen" />
          <Boton chico icono={ImagePlus} cargando={procesando} onClick={() => entrada.current?.click()}>
            {vista ? 'Cambiar imagen' : 'Agregar imagen'}
          </Boton>
          {vista && (
            <Boton chico variante="plano" icono={Trash2} onClick={() => alCambiar(actual ? { tipo: 'quitar' } : { tipo: 'sin_cambio' })}>
              Quitar
            </Boton>
          )}
          {cambio.tipo === 'quitar' && <span className={ui.sub}>Se quitará al guardar</span>}
        </div>
      </div>
      {error ? <span className={ui.error} role="alert">{error}</span> : <span className={ui.ayuda}>JPG, PNG o WebP. Se reduce automáticamente.</span>}
    </div>
  );
}
