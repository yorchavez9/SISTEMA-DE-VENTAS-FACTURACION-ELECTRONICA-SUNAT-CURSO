import {
  NOMBRE_TIPO_SERIE, TIPOS_SERIE, type OperacionSerie, type ResultadoValidacionSerie, type SerieDto, type SucursalDto, type TipoSerie,
} from '@sv/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Boton, Campo, Casilla, Chip, Dialogo, Franja, Selector, Tabla, ui, useToast } from '../../components/ui';
import { mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';

type Accion = 'crear' | 'correlativo' | 'mover' | 'activar' | 'predeterminada';

export function SeriesTab() {
  const { puede } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const admin = puede('series.administrar');
  const [filtroSucursal, setFiltroSucursal] = useState('');
  const [soloPropias, setSoloPropias] = useState(false);
  const [dialogo, setDialogo] = useState<{ accion: Accion; serie?: SerieDto } | null>(null);

  const { data: series = [] } = useQuery({ queryKey: ['series'], queryFn: () => pedir<SerieDto[]>('/series') });
  const { data: sucursales = [] } = useQuery({ queryKey: ['sucursales'], queryFn: () => pedir<SucursalDto[]>('/sucursales') });

  const sincronizar = useMutation({
    mutationFn: () => pedir<{ sincronizadas: number; series: SerieDto[] }>('/series/sincronizar', { method: 'POST' }),
    onSuccess: (r) => {
      qc.setQueryData(['series'], r.series);
      toast(`${r.sincronizadas} series sincronizadas con API-PRO`, 'ok');
    },
    onError: (err) => toast(mensajeError(err), 'error'),
  });

  const filas = series.filter((s) => (!filtroSucursal || String(s.sucursal?.id ?? '') === filtroSucursal) && (!soloPropias || s.propia));
  const hayPropias = series.some((s) => s.propia);

  return (
    <div className={ui.pila}>
      {!hayPropias && series.length > 0 && (
        <Franja tono="aviso">
          Todas las series actuales son externas: las usan otros sistemas del mismo RUC. Crea series propias por sucursal (por ejemplo F101, B101, FC11, BC11) para que la numeración de este sistema no se mezcle.
        </Franja>
      )}
      <div className={ui.encabezado}>
        <div className={ui.acciones} style={{ justifyContent: 'flex-start', alignItems: 'center' }}>
          <Selector value={String(filtroSucursal)} onChange={(e) => setFiltroSucursal(e.target.value)} aria-label="Filtrar por sucursal" opciones={[{ valor: '', texto: 'Todas las sucursales' }, ...sucursales.map((s) => ({ valor: String(s.id), texto: s.nombre }))]} />
          <Casilla etiqueta="Solo propias" checked={soloPropias} onChange={(e) => setSoloPropias(e.target.checked)} />
        </div>
        <div className={ui.acciones}>
          <Boton icono={RefreshCw} onClick={() => sincronizar.mutate()} cargando={sincronizar.isPending}>
            Sincronizar con API-PRO
          </Boton>
          {admin && (
            <Boton variante="primario" icono={Plus} onClick={() => setDialogo({ accion: 'crear' })}>
              Nueva serie
            </Boton>
          )}
        </div>
      </div>
      <Tabla
        filas={filas}
        clave={(s) => s.id}
        vacio="No hay series. Prueba la conexión o sincroniza con API-PRO."
        columnas={[
          { titulo: 'Tipo', celda: (s) => <>{NOMBRE_TIPO_SERIE[s.tipoDoc]}{s.aplicaA && <span className={ui.sub}>sobre {s.aplicaA === 'F' ? 'facturas' : 'boletas'}</span>}</> },
          { titulo: 'Serie', celda: (s) => <strong className="font-id">{s.serie}</strong> },
          { titulo: 'Sucursal', celda: (s) => s.sucursal?.nombre ?? <span className="muted">API-PRO {s.apiSucursal?.codLocal ?? '—'} (sin vincular)</span> },
          { titulo: 'Origen', celda: (s) => (s.propia ? <Chip tono="info">Propia</Chip> : <Chip>Externa</Chip>) },
          { titulo: 'Último N°', celda: (s) => s.ultimoCorrelativo, alinear: 'derecha' },
          { titulo: 'Estado', celda: (s) => (s.activo ? <Chip tono="ok">Activa</Chip> : <Chip tono="aviso">Inactiva</Chip>) },
          { titulo: 'POS', celda: (s) => (s.predeterminada ? <Chip tono="ok">Predeterminada</Chip> : '') },
          {
            titulo: '',
            celda: (s) =>
              admin && (
                <div className={ui.acciones}>
                  {s.propia && s.activo && !s.predeterminada && s.sucursal && (
                    <Boton chico onClick={() => setDialogo({ accion: 'predeterminada', serie: s })}>
                      Predeterminar
                    </Boton>
                  )}
                  {s.activo && (
                    <Boton chico onClick={() => setDialogo({ accion: 'correlativo', serie: s })}>
                      Correlativo
                    </Boton>
                  )}
                  <Boton chico onClick={() => setDialogo({ accion: 'mover', serie: s })}>
                    Mover
                  </Boton>
                  <Boton chico variante={s.activo ? 'plano' : 'secundario'} onClick={() => setDialogo({ accion: 'activar', serie: s })}>
                    {s.activo ? 'Desactivar' : 'Reactivar'}
                  </Boton>
                </div>
              ),
          },
        ]}
      />
      {dialogo && <OperacionDialogo {...dialogo} sucursales={sucursales} alCerrar={() => setDialogo(null)} />}
    </div>
  );
}

const TITULO: Record<Accion, string> = {
  crear: 'Nueva serie',
  correlativo: 'Cambiar correlativo',
  mover: 'Mover a otra sucursal',
  activar: 'Activar o desactivar',
  predeterminada: 'Serie predeterminada del POS',
};

function OperacionDialogo({ accion, serie, sucursales, alCerrar }: { accion: Accion; serie?: SerieDto; sucursales: SucursalDto[]; alCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const vinculadas = sucursales.filter((s) => s.activo && s.apiSucursalId);

  // Datos editables según la acción.
  const [tipoDoc, setTipoDoc] = useState<TipoSerie>('03');
  const [codigo, setCodigo] = useState('');
  const [sucursalId, setSucursalId] = useState<number>(vinculadas[0]?.id ?? 0);
  const [correlativoInicial, setCorrelativoInicial] = useState('0');
  const [correlativo, setCorrelativo] = useState(String((serie?.ultimoCorrelativo ?? 0) + 1));

  const [revision, setRevision] = useState<ResultadoValidacionSerie | null>(null);
  const [confirmacion, setConfirmacion] = useState('');
  const [reforzada, setReforzada] = useState(false);
  const [ocupado, setOcupado] = useState(false);

  const operacion = (): OperacionSerie => {
    switch (accion) {
      case 'crear':
        return { operacion: 'crear', tipoDoc, serie: codigo.toUpperCase(), sucursalId, correlativoInicial: Number(correlativoInicial) || 0 };
      case 'correlativo':
        return { operacion: 'correlativo', serieId: serie!.id, correlativo: Number(correlativo) };
      case 'mover':
        return { operacion: 'mover', serieId: serie!.id, sucursalId };
      case 'activar':
        return { operacion: 'activar', serieId: serie!.id, activo: !serie!.activo };
      case 'predeterminada':
        return { operacion: 'predeterminada', serieId: serie!.id };
    }
  };

  /** Cualquier cambio en los datos invalida la revisión previa. */
  const cambiar = <T,>(fijar: (v: T) => void) => (v: T) => {
    fijar(v);
    setRevision(null);
    setConfirmacion('');
  };

  const revisar = async () => {
    setOcupado(true);
    try {
      setRevision(await pedir<ResultadoValidacionSerie>('/series/validar', { cuerpo: operacion() }));
    } catch (err) {
      toast(mensajeError(err), 'error');
    } finally {
      setOcupado(false);
    }
  };

  const aplicar = async () => {
    setOcupado(true);
    try {
      await pedir('/series/operaciones', { cuerpo: { ...operacion(), confirmacion, confirmacionReforzada: reforzada || undefined }, idempotente: true });
      await qc.invalidateQueries({ queryKey: ['series'] });
      toast('Cambio aplicado en API-PRO', 'ok');
      alCerrar();
    } catch (err) {
      toast(mensajeError(err), 'error');
      setRevision(null);
    } finally {
      setOcupado(false);
    }
  };

  const listo = revision?.permitido && confirmacion.toUpperCase() === revision.confirmacionRequerida && (!revision.requiereConfirmacionReforzada || reforzada);
  const opcionesSucursal = vinculadas
    .filter((s) => accion !== 'mover' || s.id !== serie?.sucursal?.id)
    .map((s) => ({ valor: String(s.id), texto: `${s.nombre} (${s.codLocal})` }));

  let campos: ReactNode = null;
  if (accion === 'crear') {
    campos = (
      <div className={ui.form}>
        <Selector
          etiqueta="Tipo de comprobante"
          ancho="mitad"
          value={tipoDoc}
          onChange={(e) => cambiar(setTipoDoc)(e.target.value as TipoSerie)}
          opciones={TIPOS_SERIE.map((t) => ({ valor: t, texto: NOMBRE_TIPO_SERIE[t] }))}
        />
        <Campo etiqueta="Serie" ancho="cuarto" className="font-id" maxLength={4} value={codigo} onChange={(e) => cambiar(setCodigo)(e.target.value.toUpperCase())} ayuda={tipoDoc === '07' || tipoDoc === '08' ? 'FC.. / BC.. / FD.. / BD..' : `Empieza con ${tipoDoc === '01' ? 'F' : tipoDoc === '03' ? 'B' : 'T'}`} />
        <Campo etiqueta="Correlativo inicial" ancho="cuarto" inputMode="numeric" value={correlativoInicial} onChange={(e) => cambiar(setCorrelativoInicial)(e.target.value.replace(/\D/g, ''))} ayuda="0 = empieza en 1" />
        <Selector etiqueta="Sucursal" value={String(sucursalId)} onChange={(e) => cambiar(setSucursalId)(Number(e.target.value))} opciones={opcionesSucursal.length ? opcionesSucursal : [{ valor: '0', texto: 'No hay sucursales vinculadas' }]} />
      </div>
    );
  } else if (accion === 'correlativo') {
    campos = (
      <div className={ui.form}>
        <Campo etiqueta="Último número usado" value={String(serie!.ultimoCorrelativo)} readOnly ancho="mitad" ayuda="Se vuelve a leer de API-PRO al revisar" />
        <Campo etiqueta="Nuevo último número" inputMode="numeric" ancho="mitad" value={correlativo} onChange={(e) => cambiar(setCorrelativo)(e.target.value.replace(/\D/g, ''))} ayuda={`El próximo comprobante será ${serie!.serie}-${(Number(correlativo) || 0) + 1}`} />
      </div>
    );
  } else if (accion === 'mover') {
    campos = (
      <div className={ui.form}>
        <Selector etiqueta="Sucursal de destino" value={String(sucursalId)} onChange={(e) => cambiar(setSucursalId)(Number(e.target.value))} opciones={opcionesSucursal.length ? opcionesSucursal : [{ valor: '0', texto: 'No hay otra sucursal vinculada' }]} />
      </div>
    );
  }

  return (
    <Dialogo
      titulo={serie ? `${TITULO[accion]} · ${serie.serie}` : TITULO[accion]}
      abierto
      alCerrar={alCerrar}
      ancho
      pie={
        <>
          <Boton onClick={alCerrar}>Cancelar</Boton>
          {!revision?.permitido ? (
            <Boton variante="primario" onClick={revisar} cargando={ocupado}>
              Revisar
            </Boton>
          ) : (
            <Boton variante="primario" onClick={aplicar} cargando={ocupado} disabled={!listo}>
              {accion === 'predeterminada' ? 'Aplicar' : 'Aplicar en API-PRO'}
            </Boton>
          )}
        </>
      }
    >
      <div className={ui.pila}>
        {accion === 'activar' && <span>{serie!.activo ? `Desactivar la serie ${serie!.serie}.` : `Reactivar la serie ${serie!.serie} conservando su numeración.`}</span>}
        {accion === 'predeterminada' && <span>El punto de venta de {serie!.sucursal?.nombre} usará {serie!.serie} por defecto para {NOMBRE_TIPO_SERIE[serie!.tipoDoc].toLowerCase()}.</span>}
        {campos}
        {revision && (
          <>
            {revision.bloqueos.length > 0 && (
              <Franja tono="alerta">
                <strong>No se puede aplicar</strong>
                <ul>
                  {revision.bloqueos.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </Franja>
            )}
            {revision.advertencias.length > 0 && (
              <Franja tono="aviso">
                <ul style={{ marginTop: 0 }}>
                  {revision.advertencias.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </Franja>
            )}
            {revision.permitido && (
              <div className={ui.form}>
                <Campo
                  etiqueta={`Escribe ${revision.confirmacionRequerida} para confirmar`}
                  className="font-id"
                  autoComplete="off"
                  value={confirmacion}
                  onChange={(e) => setConfirmacion(e.target.value.toUpperCase())}
                />
                {revision.requiereConfirmacionReforzada && (
                  <Casilla etiqueta="Entiendo que esta serie la usan otros sistemas del mismo RUC" checked={reforzada} onChange={(e) => setReforzada(e.target.checked)} />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Dialogo>
  );
}
