import type { PendientesResumenDto, ResumenDto, VerificacionResumenDto } from '@sv/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Boton, Chip, Dialogo, Encabezado, Franja, Tabla, ui, useToast } from '../../components/ui';
import { dinero, fechaHora } from '../../lib/formato';
import { ErrorHttp, mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';

const ESTADO: Record<ResumenDto['estado'], { texto: string; tono: 'ok' | 'info' | 'aviso' | 'alerta' | 'neutro' }> = {
  verificando: { texto: 'Verificando', tono: 'info' },
  bloqueado: { texto: 'Bloqueado', tono: 'alerta' },
  enviado: { texto: 'En SUNAT', tono: 'info' },
  aceptado: { texto: 'Aceptado', tono: 'ok' },
  rechazado: { texto: 'Rechazado', tono: 'alerta' },
  error: { texto: 'Con error', tono: 'aviso' },
};

export function ResumenesPage() {
  const { puede } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: pendientes = [] } = useQuery({ queryKey: ['resumenes-pendientes'], queryFn: () => pedir<PendientesResumenDto[]>('/resumenes/pendientes'), refetchInterval: 30_000 });
  const { data: historial = [] } = useQuery({ queryKey: ['resumenes'], queryFn: () => pedir<ResumenDto[]>('/resumenes'), refetchInterval: 15_000 });
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [verificacion, setVerificacion] = useState<VerificacionResumenDto | null>(null);
  const enviar = puede('resumenes.enviar');

  const refrescar = async () => {
    await qc.invalidateQueries({ queryKey: ['resumenes-pendientes'] });
    await qc.invalidateQueries({ queryKey: ['resumenes'] });
    await qc.invalidateQueries({ queryKey: ['comprobantes'] });
  };

  const verificar = async (fecha: string) => {
    setOcupado(`v-${fecha}`);
    try {
      setVerificacion(await pedir<VerificacionResumenDto>('/resumenes/verificar', { cuerpo: { fecha } }));
    } catch (err) {
      toast(mensajeError(err), 'error');
    } finally {
      setOcupado(null);
    }
  };

  const enviarResumen = async (fecha: string) => {
    setOcupado(`e-${fecha}`);
    try {
      const r = await pedir<ResumenDto>('/resumenes', { cuerpo: { fecha } });
      toast(r.simulado ? 'Resumen simulado' : `Resumen ${r.identifier} enviado con ${r.documentos} boletas`, 'ok');
      setVerificacion(null);
      await refrescar();
    } catch (err) {
      if (err instanceof ErrorHttp && err.codigo === 'RESUMEN_BLOQUEADO_BOLETAS_AJENAS') {
        setVerificacion((err.cuerpo.detalle as { verificacion: VerificacionResumenDto }).verificacion);
        await refrescar();
      } else toast(mensajeError(err), 'error');
    } finally {
      setOcupado(null);
    }
  };

  return (
    <>
      <Encabezado titulo="Resumen diario" />
      <div className={ui.pila}>
        <Franja>
          Las boletas en modo «resumen diario» se declaran juntas a SUNAT, una vez por fecha. El envío es automático a la hora de resumen de las sucursales;
          antes de enviar, el sistema comprueba que todas las boletas pendientes del RUC sean de este sistema.
        </Franja>
        <h2>Pendientes de declarar</h2>
        <Tabla
          filas={pendientes}
          clave={(p) => p.fecha}
          vacio="No hay boletas pendientes de resumen."
          columnas={[
            { titulo: 'Fecha de emisión', celda: (p) => <span className="font-id">{p.fecha}</span> },
            { titulo: 'Boletas', celda: (p) => p.boletas, alinear: 'derecha' },
            { titulo: 'Total', celda: (p) => dinero(p.total), alinear: 'derecha' },
            { titulo: 'Plazo', celda: (p) => (p.vencido ? <Chip tono="alerta">Venció el {p.plazoHasta}</Chip> : <span className="muted">hasta el {p.plazoHasta}</span>) },
            {
              titulo: '',
              celda: (p) =>
                enviar && !p.vencido && (
                  <div className={ui.acciones}>
                    <Boton chico icono={ShieldCheck} cargando={ocupado === `v-${p.fecha}`} onClick={() => void verificar(p.fecha)}>Verificar</Boton>
                    <Boton chico variante="primario" icono={Send} cargando={ocupado === `e-${p.fecha}`} onClick={() => void enviarResumen(p.fecha)}>Enviar ahora</Boton>
                  </div>
                ),
            },
          ]}
        />
        {pendientes.some((p) => p.vencido) && <Franja tono="alerta">Hay boletas fuera del plazo del resumen (7 días). Envíalas de forma individual desde Comprobantes o consulta a tu contador.</Franja>}

        <h2>Historial</h2>
        <Tabla
          filas={historial}
          clave={(r) => r.id}
          vacio="Aún no se enviaron resúmenes."
          columnas={[
            { titulo: 'Resumen', celda: (r) => <><span className="font-id">{r.identifier ?? `#${r.id}`}</span><span className={ui.sub}>{r.tipo === 'envio' ? 'Envío' : 'Anulación'} · fecha {r.fechaResumen}{r.simulado ? ' · simulado' : ''}</span></> },
            { titulo: 'Boletas', celda: (r) => r.documentos, alinear: 'derecha' },
            { titulo: 'Estado', celda: (r) => <><Chip tono={ESTADO[r.estado].tono}>{ESTADO[r.estado].texto}</Chip>{r.incidente && <span className={ui.sub}><Chip tono="alerta">Incluyó boletas ajenas</Chip></span>}</> },
            { titulo: 'Detalle', celda: (r) => <span className={ui.sub}>{r.bloqueo ? `${r.bloqueo.ajenas.length} boleta(s) de otro sistema` : (r.sunatDescripcion ?? r.ultimoError ?? '')}</span> },
            { titulo: 'Creado', celda: (r) => <>{fechaHora(r.creadoEn)}<span className={ui.sub}>{r.creadoPor ?? 'Automático'}</span></> },
          ]}
        />
      </div>
      {verificacion && <VerificacionDialogo v={verificacion} alCerrar={() => setVerificacion(null)} alEnviar={() => void enviarResumen(verificacion.fecha)} alCambio={refrescar} />}
    </>
  );
}

function VerificacionDialogo({ v, alCerrar, alEnviar, alCambio }: { v: VerificacionResumenDto; alCerrar: () => void; alEnviar: () => void; alCambio: () => Promise<void> }) {
  const toast = useToast();
  const [enviando, setEnviando] = useState(false);
  const { data: boletas = [] } = useQuery({ queryKey: ['resumen-boletas', v.fecha], queryFn: () => pedir<Array<{ id: number; numero: string; cliente: string; total: string }>>(`/resumenes/boletas?fecha=${v.fecha}`), enabled: v.ajenas.length > 0 });

  const individual = async () => {
    setEnviando(true);
    try {
      const r = await pedir<{ enviadas: number; omitidas: string[] }>('/resumenes/enviar-individual', { cuerpo: { comprobanteIds: boletas.map((b) => b.id) } });
      toast(`${r.enviadas} boleta(s) enviadas de forma individual${r.omitidas.length ? ` · ${r.omitidas.length} omitidas` : ''}`, r.omitidas.length ? 'info' : 'ok');
      await alCambio();
      alCerrar();
    } catch (err) {
      toast(mensajeError(err), 'error');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialogo
      titulo={`Resumen del ${v.fecha}`}
      abierto
      alCerrar={alCerrar}
      pie={
        <>
          <Boton onClick={alCerrar}>Cerrar</Boton>
          {v.ajenas.length > 0 ? (
            <Boton variante="primario" onClick={individual} cargando={enviando} disabled={!boletas.length}>
              Enviar mis {boletas.length} boletas de forma individual
            </Boton>
          ) : (
            v.puedeEnviar && <Boton variante="primario" onClick={alEnviar}>Enviar resumen</Boton>
          )}
        </>
      }
    >
      <div className={ui.pila}>
        {v.ajenas.length === 0 ? (
          <Franja tono="ok">Todas las boletas pendientes del RUC en esa fecha ({v.propias}) son de este sistema: se puede enviar el resumen.</Franja>
        ) : (
          <>
            <Franja tono="alerta">
              API-PRO incluiría {v.ajenas.length} boleta(s) que no son de este sistema. Para no declarar documentos ajenos, este sistema no enviará el resumen.
              <ul>
                {v.ajenas.slice(0, 10).map((a) => (
                  <li key={a.apiId}>
                    {a.numero} {a.cliente ? `· ${a.cliente}` : ''}
                  </li>
                ))}
              </ul>
            </Franja>
            <span>Como alternativa, se pueden enviar las {boletas.length} boletas propias de forma individual (siguen dentro del plazo).</span>
          </>
        )}
        {v.noEncontradas.length > 0 && <Franja tono="aviso">API-PRO no lista como pendientes: {v.noEncontradas.join(', ')}. Revísalas en Comprobantes.</Franja>}
      </div>
    </Dialogo>
  );
}
