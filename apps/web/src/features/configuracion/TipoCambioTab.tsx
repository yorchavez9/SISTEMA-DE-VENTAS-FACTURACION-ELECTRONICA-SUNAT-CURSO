import { tipoCambioSchema, type TipoCambioDto } from '@sv/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { Boton, Campo, Franja, Tabla, ui, useToast } from '../../components/ui';
import { useFormulario } from '../../lib/formulario';
import { mensajeError, pedir } from '../../lib/http';
import { Card } from '@/components/ui/card';

function hoyLima(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date());
}

export function TipoCambioTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const hoy = hoyLima();
  const { data: historial = [] } = useQuery({ queryKey: ['tipos-cambio'], queryFn: () => pedir<TipoCambioDto[]>('/tipos-cambio') });
  const deHoy = historial.find((t) => t.fecha === hoy);
  const f = useFormulario({ fecha: hoy, compra: '', venta: '' });

  const guardar = async () => {
    const datos = f.validar(tipoCambioSchema);
    if (!datos) return;
    try {
      await f.enviar(() => pedir(`/tipos-cambio/${f.valores.fecha}`, { method: 'PUT', cuerpo: datos }));
      await qc.invalidateQueries({ queryKey: ['tipos-cambio'] });
      toast('Tipo de cambio registrado', 'ok');
      f.setValores({ fecha: hoy, compra: '', venta: '' });
    } catch (err) {
      toast(mensajeError(err), 'error');
    }
  };

  return (
    <div className={ui.pila}>
      {!deHoy && <Franja tono="aviso">Aún no se registra el tipo de cambio de hoy: las ventas en dólares quedarán bloqueadas hasta registrarlo.</Franja>}
      <Card className="gap-3">
        <h2 style={{ marginBottom: '0.75rem' }}>Registrar tipo de cambio</h2>
        <div className={ui.form}>
          <Campo etiqueta="Fecha" type="date" max={hoy} ancho="mitad" {...f.texto('fecha')} />
          <Campo etiqueta="Compra (S/ por US$)" inputMode="decimal" ancho="cuarto" placeholder="3.7410" {...f.texto('compra')} />
          <Campo etiqueta="Venta (S/ por US$)" inputMode="decimal" ancho="cuarto" placeholder="3.7520" {...f.texto('venta')} />
        </div>
        <p className="muted">Usa el tipo de cambio oficial del día (SBS/SUNAT). La venta se usa para convertir precios y cobros.</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Boton variante="primario" icono={Save} onClick={guardar} cargando={f.enviando}>
            Guardar
          </Boton>
        </div>
      </Card>
      <Tabla
        filas={historial}
        clave={(t) => t.fecha}
        vacio="Sin registros"
        columnas={[
          { titulo: 'Fecha', celda: (t) => <span className="font-id">{t.fecha}</span> },
          { titulo: 'Compra', celda: (t) => t.compra, alinear: 'derecha' },
          { titulo: 'Venta', celda: (t) => t.venta, alinear: 'derecha' },
        ]}
      />
    </div>
  );
}
