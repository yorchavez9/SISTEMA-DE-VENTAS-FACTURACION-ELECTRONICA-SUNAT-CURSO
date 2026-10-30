import { ETIQUETA_ESTADO, type ComprobanteDetalleDto, type EstadoComprobante, type FormatoPdf, type Moneda, type VentaDto } from '@sv/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Espera, HojaFlotante } from '../../components/HojaFlotante';
import { useToast } from '../../components/ui';
import { Button } from '@/components/ui/button';
import { cantidad, dinero, fechaHora } from '../../lib/formato';
import { pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';
import css from '../../components/hoja.module.css';

export interface VentaRegistrada {
  venta: VentaDto;
  vuelto: Array<{ moneda: Moneda; monto: string }>;
}

/** Tamaño de página al imprimir la representación local (modo simulación). */
const PAGINA: Record<FormatoPdf, string> = { 'ticket-80': '80mm auto', 'ticket-58': '58mm auto', a5: 'A5', a4: 'A4' };
/** Con el PDF ya listo: aceptado por SUNAT o boleta que va en el resumen diario. */
const CON_PDF: readonly EstadoComprobante[] = ['aceptado', 'observado', 'pendiente_resumen', 'en_resumen'];
const SIN_SALIDA: readonly EstadoComprobante[] = ['rechazado', 'error_validacion', 'sin_respuesta_sunat', 'anulado', 'anulado_interno'];
const MAX_CONSULTAS = 48; // 2,5 s × 48 ≈ 2 minutos

/** Todavía tiene sentido esperar el PDF: ni simulado, ni con error, ni listo. */
const esperandoPdf = (c?: ComprobanteDetalleDto) => !c || (!c.simulado && !SIN_SALIDA.includes(c.estado) && !(c.acciones.includes('pdf') && CON_PDF.includes(c.estado)));

/**
 * Tras cobrar solo se muestra el comprobante: el PDF de API-PRO flotando, del ancho del formato
 * elegido. En modo simulación (sin PDF de SUNAT) se muestra la misma hoja armada aquí. El total y
 * el vuelto van en un aviso.
 */
export function ResultadoVenta({ registrada, alCerrar }: { registrada: VentaRegistrada; alCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const v = registrada.venta;
  const resumen = v.comprobantes.find((c) => c.tipoDoc === v.tipoComprobante);

  const consulta = useQuery({
    queryKey: ['comprobante', resumen?.id],
    queryFn: () => pedir<ComprobanteDetalleDto>(`/comprobantes/${resumen!.id}`),
    enabled: Boolean(resumen),
    refetchInterval: (q) => (esperandoPdf(q.state.data) && q.state.dataUpdateCount < MAX_CONSULTAS ? 2500 : false),
  });
  const c = consulta.data;
  const conPdf = Boolean(c && !c.simulado && c.acciones.includes('pdf') && CON_PDF.includes(c.estado));
  const local = !resumen || Boolean(c?.simulado);
  const seRindio = Boolean(c) && esperandoPdf(c) && (qc.getQueryState(['comprobante', resumen?.id])?.dataUpdateCount ?? 0) >= MAX_CONSULTAS;

  useEffect(() => {
    const vuelto = registrada.vuelto.map((x) => dinero(x.monto, x.moneda)).join(' + ');
    toast(`Venta N° ${v.id}: ${dinero(v.total, v.moneda)}${vuelto ? ` · vuelto ${vuelto}` : ''}`, 'ok');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const alTecla = (e: KeyboardEvent) => e.key === 'Enter' && !(e.target instanceof HTMLButtonElement) && alCerrar();
    window.addEventListener('keydown', alTecla);
    return () => window.removeEventListener('keydown', alTecla);
  }, [alCerrar]);

  const nombre = `${(resumen?.tipoDoc ?? v.tipoComprobante) === '01' ? 'Factura' : 'Boleta'} ${c?.numeroCompleto ?? resumen?.numeroCompleto ?? ''}`.trim();

  return (
    <HojaFlotante titulo={nombre || `Venta N° ${v.id}`} pdf={conPdf ? `/comprobantes/${c!.id}/pdf` : undefined} listo={local} alCerrar={alCerrar} cerrarTexto="Nueva venta (Enter)">
      {(formato) =>
        local ? (
          <>
            <HojaLocal venta={v} formato={formato} />
            <Impresion formato={formato}>
              <HojaLocal venta={v} formato={formato} />
            </Impresion>
          </>
        ) : c && SIN_SALIDA.includes(c.estado) ? (
          <div className={css.espera} data-tono="alerta">
            <AlertTriangle aria-hidden />
            <strong>{ETIQUETA_ESTADO[c.estado].texto}</strong>
            <p>{c.sunat.descripcion ?? c.ultimoError ?? 'SUNAT no aceptó el comprobante.'}</p>
          </div>
        ) : seRindio ? (
          <div className={css.espera}>
            <p>El PDF aún no está listo. Puedes verlo luego en Comprobantes.</p>
            <Button variant="outline" className="rounded-full" onClick={() => void consulta.refetch()}>
              <RefreshCw aria-hidden /> Volver a consultar
            </Button>
          </div>
        ) : (
          <Espera texto="Enviando a SUNAT…" />
        )
      }
    </HojaFlotante>
  );
}

/** Solo al imprimir: la hoja local con el tamaño de página del formato elegido. */
function Impresion({ formato, children }: { formato: FormatoPdf; children: ReactNode }) {
  return createPortal(
    <div className={css.impresion} data-impresion data-formato={formato}>
      <style>{`@media print { @page { size: ${PAGINA[formato]}; margin: ${formato.startsWith('ticket') ? '3mm' : '12mm'}; } }`}</style>
      {children}
    </div>,
    document.body,
  );
}

/** Representación del comprobante armada aquí (modo simulación): misma información que el ticket. */
function HojaLocal({ venta: v, formato }: { venta: VentaDto; formato: FormatoPdf }) {
  const { sesion } = useSesion();
  const c = v.comprobantes.find((x) => x.tipoDoc === v.tipoComprobante);
  const tipo = c?.tipoDoc === '01' ? 'FACTURA' : 'BOLETA DE VENTA';
  return (
    <article className={css.local} data-formato={formato}>
      <header>
        <strong>{sesion?.sucursalActiva?.nombre ?? 'CMA STORE'}</strong>
        <span>
          {tipo} ELECTRÓNICA
          <br />
          <b className="tabular-nums">{c?.numeroCompleto ?? (c ? `${c.serie} (por emitir)` : `Venta N° ${v.id}`)}</b>
        </span>
      </header>
      <dl className={css.localDatos}>
        <div>
          <dt>Fecha</dt>
          <dd>{fechaHora(v.fecha)}</dd>
        </div>
        <div>
          <dt>Cliente</dt>
          <dd>{v.cliente.razonSocial}</dd>
        </div>
        {v.cliente.id && (
          <div>
            <dt>{v.cliente.tipoDoc === '6' ? 'RUC' : 'Doc.'}</dt>
            <dd className="tabular-nums">{v.cliente.numDoc}</dd>
          </div>
        )}
        <div>
          <dt>Cajero</dt>
          <dd>{v.cajero}</dd>
        </div>
      </dl>
      <table className={css.localItems}>
        <thead>
          <tr>
            <th>Cant.</th>
            <th>Descripción</th>
            <th>Importe</th>
          </tr>
        </thead>
        <tbody>
          {v.items.map((i, k) => (
            <tr key={k}>
              <td className="tabular-nums">{cantidad(i.cantidad)}</td>
              <td>
                {i.descripcion}
                <small>P. unit. {dinero(i.precioUnitario, v.moneda)}</small>
              </td>
              <td className="tabular-nums">{dinero(i.total, v.moneda)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className={css.localTotales}>
        {Number(v.descuento) > 0 && (
          <div>
            <dt>Descuento</dt>
            <dd>−{dinero(v.descuento, v.moneda)}</dd>
          </div>
        )}
        <div>
          <dt>Op. gravada</dt>
          <dd>{dinero(v.opGravada, v.moneda)}</dd>
        </div>
        {Number(v.opExonerada) > 0 && (
          <div>
            <dt>Op. exonerada</dt>
            <dd>{dinero(v.opExonerada, v.moneda)}</dd>
          </div>
        )}
        {Number(v.opInafecta) > 0 && (
          <div>
            <dt>Op. inafecta</dt>
            <dd>{dinero(v.opInafecta, v.moneda)}</dd>
          </div>
        )}
        <div>
          <dt>IGV {Number(v.tasaIgv)}%</dt>
          <dd>{dinero(v.igv, v.moneda)}</dd>
        </div>
        <div data-total>
          <dt>TOTAL</dt>
          <dd>{dinero(v.total, v.moneda)}</dd>
        </div>
        {v.pagos.map((p, k) => (
          <div key={k}>
            <dt>{p.metodo}</dt>
            <dd>{dinero(p.monto, p.moneda)}</dd>
          </div>
        ))}
        {v.cuotas.map((q) => (
          <div key={q.numero}>
            <dt>
              Cuota {q.numero} · {q.fechaVencimiento}
            </dt>
            <dd>{dinero(q.monto, v.moneda)}</dd>
          </div>
        ))}
      </dl>
      <footer>Modo simulación: no enviado a SUNAT, sin valor tributario.</footer>
    </article>
  );
}
