import type { EstadoIntegracionDto } from '@sv/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { mensajeError, pedir } from '../lib/http';
import { useSesion } from '../lib/sesion';
import { Boton, Chip, Franja, useToast, type Tono } from './ui';

const useIntegracion = () =>
  useQuery({ queryKey: ['estado-integracion'], queryFn: () => pedir<EstadoIntegracionDto>('/estado-integracion'), refetchInterval: 30_000, retry: false });

/** Chip del encabezado: estado de la conexión con API-PRO y de la emisión. */
export function EstadoSistema() {
  const { data, isError } = useIntegracion();

  let tono: Tono = 'neutro';
  let texto = 'Conectando…';
  if (isError) [tono, texto] = ['alerta', 'Sin servidor'];
  else if (data) {
    if (data.credenciales === 'ninguno') [tono, texto] = ['alerta', 'API sin configurar'];
    else if (data.colaPausada) [tono, texto] = ['alerta', 'Emisión pausada'];
    else if (data.contadores.problemas > 0) [tono, texto] = ['alerta', `${data.contadores.problemas} con problema`];
    else if (!data.verificadaEn) [tono, texto] = ['aviso', 'Conexión sin probar'];
    else if (data.modoEmision === 'simulacion') [tono, texto] = ['aviso', 'Modo simulación'];
    else if (data.contadores.pendientes + data.contadores.enProceso + data.contadores.porVerificar > 0) [tono, texto] = ['info', 'Enviando a SUNAT…'];
    else [tono, texto] = ['ok', data.entorno === 'beta' ? 'SUNAT beta' : 'SUNAT'];
  }
  return (
    <Link to="/comprobantes" role="status" className={tono === 'alerta' ? 'no-underline' : 'no-underline max-md:hidden'} title="Ver comprobantes">
      <Chip tono={tono}>{texto}</Chip>
    </Link>
  );
}

/** Franja global cuando la emisión está pausada (credenciales, licencia o cupo de API-PRO). */
export function AvisoPausa() {
  const { data } = useIntegracion();
  const { puede } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  if (!data) return null;
  if (!data.pausa) return <AvisoAtascados a={data.atascados} />;

  const reanudar = async () => {
    try {
      await pedir('/estado-integracion/reanudar', { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['estado-integracion'] });
      toast('Emisión reanudada', 'ok');
    } catch (err) {
      toast(mensajeError(err), 'error');
    }
  };

  return (
    <div style={{ marginBottom: '1rem' }}>
      <Franja tono="alerta">
        La emisión a SUNAT está pausada: {data.pausa.motivo}. Las ventas siguen registrándose y sus comprobantes se enviarán al reanudar
        (se reintenta solo cada 15 minutos).
        {puede('config.editar') && (
          <div style={{ marginTop: '0.5rem' }}>
            <Boton chico onClick={reanudar}>
              Reanudar ahora
            </Boton>
          </div>
        )}
      </Franja>
    </div>
  );
}

/** Franja cuando hay envíos que no avanzan solos: necesitan que alguien los mire. */
function AvisoAtascados({ a }: { a: EstadoIntegracionDto['atascados'] }) {
  const { puede } = useSesion();
  if (!a || a.total === 0 || !puede('comprobantes.ver')) return null;
  const partes = [
    a.items.length > 0 && `${a.items.length} envío(s) sin avanzar hace más de ${a.minutos} min (${a.items.slice(0, 3).map((i) => i.numero).join(', ')}${a.items.length > 3 ? '…' : ''})`,
    a.boletasSinResumen > 0 && `${a.boletasSinResumen} boleta(s) de días anteriores sin resumen diario`,
    a.trabajosFallidos > 0 && `${a.trabajosFallidos} tarea(s) del worker fallidas en la última semana`,
  ].filter(Boolean);
  return (
    <div style={{ marginBottom: '1rem' }}>
      <Franja tono="aviso">
        Requiere revisión: {partes.join(' · ')}. <Link to="/comprobantes">Ver comprobantes</Link>
        {a.items.some((i) => i.tipo === 'guia') && <> · <Link to="/guias">Ver guías</Link></>}
        {a.boletasSinResumen > 0 && <> · <Link to="/resumenes">Ver resumen diario</Link></>}
      </Franja>
    </div>
  );
}
