import type { ComprobanteDetalleDto, ValidacionAnulacionDto } from '@sv/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Boton, Campo, Dialogo, Franja, Selector, ui, useToast } from '../../components/ui';
import { useCajaActiva, useMetodosPago } from '../../lib/caja';
import { dinero } from '../../lib/formato';
import { mensajeError, pedir } from '../../lib/http';

/** Anulación ante SUNAT: comunicación de baja (facturas y notas) o resumen de anulación (boletas). */
export function AnularDialogo({ comprobante, alCerrar, alAnular }: { comprobante: ComprobanteDetalleDto; alCerrar: () => void; alAnular: () => Promise<void> }) {
  const toast = useToast();
  const { data: v } = useQuery({ queryKey: ['validar-anulacion', comprobante.id], queryFn: () => pedir<ValidacionAnulacionDto>('/anulaciones/validar', { cuerpo: { comprobanteIds: [comprobante.id] } }) });
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [clave] = useState(() => crypto.randomUUID());

  const anular = async () => {
    setEnviando(true);
    try {
      await pedir('/anulaciones', { cuerpo: { comprobanteIds: [comprobante.id], motivo }, idempotente: clave });
      await alAnular();
      toast('Anulación solicitada: se confirmará cuando responda SUNAT', 'ok');
      alCerrar();
    } catch (err) {
      toast(mensajeError(err), 'error');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialogo
      titulo={`Anular ${comprobante.numeroCompleto ?? ''} ante SUNAT`}
      abierto
      alCerrar={alCerrar}
      pie={<><Boton onClick={alCerrar}>Cancelar</Boton><Boton variante="peligro" onClick={anular} cargando={enviando} disabled={!v?.permitido || motivo.trim().length < 5}>Solicitar anulación</Boton></>}
    >
      {!v ? (
        <span className="muted">Revisando…</span>
      ) : (
        <div className={ui.pila}>
          <Franja>
            {v.mecanismo === 'RC'
              ? 'Las boletas se anulan con un resumen de anulación.'
              : 'Las facturas y sus notas se anulan con una comunicación de baja.'}
            {v.plazoHasta && ` Plazo: hasta el ${v.plazoHasta}.`}
          </Franja>
          {v.bloqueos.length > 0 && (
            <Franja tono="alerta">
              <ul style={{ marginTop: 0 }}>
                {v.bloqueos.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </Franja>
          )}
          {v.advertencias.length > 0 && (
            <Franja tono="aviso">
              <ul style={{ marginTop: 0 }}>
                {v.advertencias.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </Franja>
          )}
          {v.permitido && (
            <div className={ui.form}>
              <Campo etiqueta="Motivo (se comunica a SUNAT)" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
            </div>
          )}
        </div>
      )}
    </Dialogo>
  );
}

export function ReembolsoDialogo({ comprobante, alCerrar, alReembolsar }: { comprobante: ComprobanteDetalleDto; alCerrar: () => void; alReembolsar: () => Promise<void> }) {
  const toast = useToast();
  const { caja } = useCajaActiva();
  const { data: metodos = [] } = useMetodosPago();
  const [metodoId, setMetodoId] = useState<number | null>(null);
  const [enviando, setEnviando] = useState(false);
  const metodo = metodoId ?? metodos.find((m) => m.tipo === 'efectivo')?.id ?? metodos[0]?.id;

  const reembolsar = async () => {
    if (!caja?.turnoAbierto || !comprobante.ventaId) return;
    setEnviando(true);
    try {
      await pedir(`/ventas/${comprobante.ventaId}/reembolsar`, { cuerpo: { cajaId: caja.id, metodoPagoId: metodo } });
      await alReembolsar();
      toast('Reembolso registrado en caja', 'ok');
      alCerrar();
    } catch (err) {
      toast(mensajeError(err), 'error');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialogo titulo="Devolver el dinero al cliente" abierto alCerrar={alCerrar} pie={<><Boton onClick={alCerrar}>Cancelar</Boton><Boton variante="primario" onClick={reembolsar} cargando={enviando} disabled={!caja?.turnoAbierto}>Registrar reembolso</Boton></>}>
      <div className={ui.pila}>
        <span>
          La venta fue anulada por SUNAT. Reembolso pendiente: <strong>{dinero(comprobante.reembolsoPendiente, comprobante.moneda)}</strong>
        </span>
        {!caja?.turnoAbierto && <Franja tono="aviso">Abre la caja para registrar el reembolso.</Franja>}
        <div className={ui.form}>
          <Selector etiqueta="Medio" value={String(metodo ?? '')} onChange={(e) => setMetodoId(Number(e.target.value))} opciones={metodos.map((m) => ({ valor: String(m.id), texto: m.nombre }))} />
        </div>
      </div>
    </Dialogo>
  );
}
