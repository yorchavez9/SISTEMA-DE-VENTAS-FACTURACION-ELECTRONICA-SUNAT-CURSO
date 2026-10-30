import type { FormatoPdf } from '@sv/shared';
import { Download, Loader2, Printer, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { descargar } from '../lib/http';
import { Alternador } from './ui';
import css from './hoja.module.css';

// Comprobante flotando sobre el velo, sin marco de modal: solo la hoja del ancho del formato
// (80 mm, 58 mm, A5 o A4) y una barra mínima para cambiar el tamaño, imprimir, descargar y cerrar.

export const FORMATOS_HOJA: Array<{ valor: FormatoPdf; texto: string }> = [
  { valor: 'ticket-80', texto: '80 mm' },
  { valor: 'ticket-58', texto: '58 mm' },
  { valor: 'a5', texto: 'A5' },
  { valor: 'a4', texto: 'A4' },
];
const CLAVE_FORMATO = 'sv.formato-pdf';

/** El formato elegido se recuerda en este navegador (solo es una comodidad: si falla, 80 mm). */
export function formatoGuardado(): FormatoPdf {
  try {
    const f = localStorage.getItem(CLAVE_FORMATO);
    return FORMATOS_HOJA.some((x) => x.valor === f) ? (f as FormatoPdf) : 'ticket-80';
  } catch {
    return 'ticket-80';
  }
}

export function Espera({ texto }: { texto: string }) {
  return (
    <div className={css.espera}>
      <Loader2 className="animate-spin" aria-hidden />
      <p>{texto}</p>
    </div>
  );
}

/**
 * `pdf`: ruta del PDF en la api sin el formato (p. ej. `/comprobantes/12/pdf`); se muestra en un
 * visor sin barra del navegador. Sin `pdf`, se muestra `children(formato)` (espera, error u hoja
 * armada localmente, que debe traer su propia zona de impresión).
 */
export function HojaFlotante({
  titulo, pdf, alCerrar, cerrarTexto = 'Cerrar', listo = true, children,
}: {
  titulo: string;
  pdf?: string;
  alCerrar: () => void;
  cerrarTexto?: string;
  /** Sin PDF: si lo que se muestra ya se puede imprimir. */
  listo?: boolean;
  children?: (formato: FormatoPdf) => ReactNode;
}) {
  const [formato, setFormato] = useState<FormatoPdf>(formatoGuardado);
  const [cargando, setCargando] = useState(true);
  const visor = useRef<HTMLIFrameElement>(null);
  const url = pdf ? `/api${pdf}?formato=${formato}` : '';
  useEffect(() => setCargando(true), [url]);

  const elegir = (f: FormatoPdf) => {
    setFormato(f);
    try {
      localStorage.setItem(CLAVE_FORMATO, f);
    } catch {
      /* sin almacenamiento: solo dura esta vista */
    }
  };

  /** Imprime el PDF desde el visor; si el navegador no lo permite, lo abre en otra pestaña. */
  const imprimir = () => {
    if (!pdf) return window.print();
    try {
      const w = visor.current?.contentWindow;
      if (!w) throw new Error('sin visor');
      w.focus();
      w.print();
    } catch {
      window.open(url, '_blank', 'noopener');
    }
  };

  const puedeImprimir = pdf ? !cargando : listo;
  return (
    <Dialog open onOpenChange={(o) => !o && alCerrar()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        // Sin foco inicial en los botones: Enter queda libre para quien abre la hoja.
        onOpenAutoFocus={(e) => e.preventDefault()}
        className={`w-auto max-w-[calc(100vw-1rem)] gap-3 rounded-none bg-transparent p-0 shadow-none sm:max-w-none ${css.modal}`}
        data-formato={formato}
      >
        <DialogTitle className="sr-only">{titulo}</DialogTitle>
        <div className={css.barra}>
          <Alternador etiqueta="Tamaño" valor={formato} alCambiar={elegir} opciones={FORMATOS_HOJA} className={css.formatos} />
          <div className={css.botones}>
            <Button size="icon" className="rounded-full" onClick={imprimir} disabled={!puedeImprimir} aria-label="Imprimir" title="Imprimir">
              <Printer />
            </Button>
            {pdf && (
              <Button variant="outline" size="icon" className="rounded-full [&_svg]:text-primary" onClick={() => void descargar(`${pdf}?formato=${formato}`)} aria-label="Descargar PDF" title="Descargar PDF">
                <Download />
              </Button>
            )}
            <Button variant="outline" size="icon" className="rounded-full" onClick={alCerrar} aria-label={cerrarTexto} title={cerrarTexto}>
              <X />
            </Button>
          </div>
        </div>
        <div className={css.hoja} aria-busy={!puedeImprimir || undefined}>
          {pdf ? (
            <>
              {cargando && <Espera texto="Cargando el PDF…" />}
              {/* #toolbar=0: el visor del navegador sin su barra; solo la hoja. */}
              <iframe key={url} ref={visor} src={`${url}#toolbar=0&navpanes=0&view=FitH`} title={titulo} className={css.pdf} data-listo={!cargando || undefined} onLoad={() => setCargando(false)} />
            </>
          ) : (
            children?.(formato)
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
