import { ajustesSchema, type Ajustes } from '@sv/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useEffect } from 'react';
import { Boton, Campo, Casilla, ui, useToast } from '../../components/ui';
import { useFormulario } from '../../lib/formulario';
import { mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';
import { Card } from '@/components/ui/card';

export function AjustesTab() {
  const { puede } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const editable = puede('config.editar');
  const { data } = useQuery({ queryKey: ['configuracion'], queryFn: () => pedir<Ajustes>('/configuracion') });
  const f = useFormulario({ inactividad: '30', mensaje: '', limite: false, vencidos: true, atascado: '30' });

  useEffect(() => {
    if (!data) return;
    f.setValores({
      inactividad: String(data['sesion.inactividad_min']),
      mensaje: data['ticket.mensaje_pie'],
      limite: data['credito.limite_por_cliente'],
      vencidos: data['credito.bloquear_vencidos'],
      atascado: String(data['alertas.comprobante_atascado_min']),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const guardar = async () => {
    const v = f.valores;
    const r = ajustesSchema.safeParse({
      'sesion.inactividad_min': Number(v.inactividad),
      'ticket.mensaje_pie': v.mensaje,
      'credito.limite_por_cliente': v.limite,
      'credito.bloquear_vencidos': v.vencidos,
      'alertas.comprobante_atascado_min': Number(v.atascado),
    });
    if (!r.success) {
      const campo: Record<string, string> = { 'sesion.inactividad_min': 'inactividad', 'ticket.mensaje_pie': 'mensaje', 'alertas.comprobante_atascado_min': 'atascado' };
      f.setErrores(Object.fromEntries(r.error.issues.map((i) => [campo[String(i.path[0])] ?? String(i.path[0]), i.message])));
      return;
    }
    try {
      await f.enviar(() => pedir('/configuracion', { method: 'PUT', cuerpo: r.data }));
      await qc.invalidateQueries({ queryKey: ['configuracion'] });
      toast('Ajustes guardados', 'ok');
    } catch (err) {
      toast(mensajeError(err), 'error');
    }
  };

  if (!data) return null;
  return (
    <Card className="gap-3">
      <div className={ui.form}>
        <Campo etiqueta="Cerrar sesión tras inactividad (minutos)" inputMode="numeric" ancho="mitad" disabled={!editable} ayuda="Entre 5 y 480" {...f.texto('inactividad')} />
        <Campo etiqueta="Alertar comprobantes sin respuesta tras (minutos)" inputMode="numeric" ancho="mitad" disabled={!editable} {...f.texto('atascado')} />
        <Campo etiqueta="Mensaje al pie del ticket" disabled={!editable} maxLength={200} {...f.texto('mensaje')} />
      </div>
      <div className={ui.pila} style={{ marginTop: '1rem' }}>
        <Casilla etiqueta="Aplicar límite de crédito por cliente" disabled={!editable} checked={f.valores.limite} onChange={(e) => f.fijar('limite', e.target.checked)} />
        <Casilla etiqueta="Bloquear ventas al crédito a clientes con cuotas vencidas" disabled={!editable} checked={f.valores.vencidos} onChange={(e) => f.fijar('vencidos', e.target.checked)} />
      </div>
      {editable && (
        <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'flex-end' }}>
          <Boton variante="primario" icono={Save} onClick={guardar} cargando={f.enviando}>
            Guardar
          </Boton>
        </div>
      )}
    </Card>
  );
}
