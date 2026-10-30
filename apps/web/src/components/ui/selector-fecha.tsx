import { CalendarIcon } from 'lucide-react';
import { useState } from 'react';
import { es } from 'react-day-picker/locale';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Calendar } from './calendar';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

// Selector de fecha (Popover + Calendar de shadcn). Va en su propio archivo para cargarlo bajo
// demanda: el calendario y su idioma pesan y no hacen falta en el ingreso ni en el POS.

const aFecha = (iso: string) => {
  const [a, m, d] = iso.split('-').map(Number);
  return a && m && d ? new Date(a, m - 1, d) : undefined;
};
const aIso = (f: Date) => `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
const fechaLegible = (f: Date) => new Intl.DateTimeFormat('es-PE', { day: 'numeric', month: 'short', year: 'numeric' }).format(f);

/** Selector de fecha (valor AAAA-MM-DD, el mismo que un <input type="date">). */
export function SelectorFecha({
  value, onChange, min, max, disabled, id, placeholder = 'Elegir fecha', className, invalido, describedBy, 'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (iso: string) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  id?: string;
  placeholder?: string;
  className?: string;
  invalido?: boolean;
  describedBy?: string;
  'aria-label'?: string;
}) {
  const [abierto, setAbierto] = useState(false);
  const fecha = value ? aFecha(value) : undefined;
  const limites = [min && aFecha(min) ? { before: aFecha(min)! } : null, max && aFecha(max) ? { after: aFecha(max)! } : null].filter(Boolean) as Array<{ before: Date } | { after: Date }>;
  return (
    <Popover open={abierto} onOpenChange={setAbierto}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-invalid={invalido || undefined}
          aria-describedby={describedBy}
          className={cn('justify-start font-normal', !fecha && 'text-muted-foreground', className)}
        >
          <CalendarIcon aria-hidden />
          {fecha ? fechaLegible(fecha) : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          locale={es}
          selected={fecha}
          defaultMonth={fecha ?? (max ? aFecha(max) : undefined)}
          captionLayout="dropdown"
          disabled={limites}
          onSelect={(d) => {
            onChange(d ? aIso(d) : '');
            setAbierto(false);
          }}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}
