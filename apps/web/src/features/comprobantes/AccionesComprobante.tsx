import type { ComprobanteListaDto } from '@sv/shared';
import { Eye, FileArchive, FileCode2, FileDown, FileText, MoreHorizontal } from 'lucide-react';
import { formatoGuardado } from '../../components/HojaFlotante';
import { useToast } from '../../components/ui';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { descargar, mensajeError } from '../../lib/http';

const NOMBRE_TIPO: Record<string, string> = { '01': 'Factura', '03': 'Boleta', '07': 'Nota de crédito', '08': 'Nota de débito' };

/**
 * Menú "⋯" de cada comprobante, como el de ferretería: ver el detalle, ver el PDF y descargar
 * PDF, XML y CDR. Los archivos solo existen cuando el comprobante ya está en API-PRO.
 */
export function AccionesComprobante({ c, alVer, alVerPdf }: { c: ComprobanteListaDto; alVer: () => void; alVerPdf: () => void }) {
  const toast = useToast();
  const nombre = `${NOMBRE_TIPO[c.tipoDoc] ?? 'Comprobante'} ${c.numeroCompleto ?? `${c.serie}-…`}`;
  const hay = (a: 'pdf' | 'xml' | 'cdr') => c.archivos.includes(a);
  const bajar = async (a: 'pdf' | 'xml' | 'cdr') => {
    try {
      await descargar(`/comprobantes/${c.id}/${a}${a === 'pdf' ? `?formato=${formatoGuardado()}` : ''}`);
    } catch (err) {
      toast(mensajeError(err), 'error');
    }
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Acciones de ${nombre}`} title="Acciones">
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52 [&_[role=menuitem]_svg]:text-primary [&_[data-disabled]_svg]:text-muted-foreground">
        <DropdownMenuItem onSelect={alVer}>
          <Eye /> Ver detalle
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!hay('pdf')} onSelect={alVerPdf}>
          <FileText /> Ver PDF
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!hay('pdf')} onSelect={() => void bajar('pdf')}>
          <FileDown /> Descargar PDF
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!hay('xml')} onSelect={() => void bajar('xml')}>
          <FileCode2 /> Descargar XML
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!hay('cdr')} onSelect={() => void bajar('cdr')}>
          <FileArchive /> Descargar CDR
        </DropdownMenuItem>
        {!hay('pdf') && (
          <DropdownMenuLabel className="max-w-56 text-xs font-normal text-muted-foreground">
            {c.simulado ? 'Simulado: no se envió a SUNAT, así que no tiene PDF, XML ni CDR.' : 'Los archivos estarán disponibles cuando API-PRO registre el comprobante.'}
          </DropdownMenuLabel>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
