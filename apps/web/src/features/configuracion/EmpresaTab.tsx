import { credencialesApiSchema, editarEmpresaSchema, type EmpresaDto, type ProbarConexionDto } from '@sv/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlugZap, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Boton, Campo, Casilla, Chip, Dialogo, Franja, Selector, Tabla, ui, useToast } from '../../components/ui';
import { useFormulario } from '../../lib/formulario';
import { ErrorHttp, mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';
import { Card } from '@/components/ui/card';
import { ConsultaDocumentos } from './ConsultaDocumentos';

const ORIGEN: Record<EmpresaDto['api']['origen'], string> = {
  base_datos: 'Guardadas cifradas en la base de datos',
  env: 'Tomadas de apps/api/.env (desarrollo)',
  ninguno: 'Sin configurar',
};

export function EmpresaTab() {
  const { puede } = useSesion();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: empresa } = useQuery({ queryKey: ['empresa'], queryFn: () => pedir<EmpresaDto>('/empresa') });
  const [prueba, setPrueba] = useState<ProbarConexionDto | null>(null);
  const [dialogoCredenciales, setDialogoCredenciales] = useState(false);
  const editable = puede('config.editar');

  const probar = useMutation({
    mutationFn: () => pedir<ProbarConexionDto>('/empresa/probar-conexion', { method: 'POST' }),
    onSuccess: (r) => {
      setPrueba(r);
      void qc.invalidateQueries({ queryKey: ['empresa'] });
      void qc.invalidateQueries({ queryKey: ['estado-integracion'] });
      void qc.invalidateQueries({ queryKey: ['series'] });
      toast('Conexión verificada', 'ok');
    },
    onError: (err) => toast(mensajeError(err), 'error'),
  });

  const f = useFormulario({ nombreComercial: '', modoEmision: 'simulacion' as 'simulacion' | 'real' });
  useEffect(() => {
    if (empresa) f.setValores({ nombreComercial: empresa.nombreComercial ?? '', modoEmision: empresa.modoEmision });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empresa]);

  const guardar = async () => {
    const datos = f.validar(editarEmpresaSchema);
    if (!datos) return;
    try {
      await f.enviar(async () => {
        await pedir('/empresa', { method: 'PUT', cuerpo: datos });
        await qc.invalidateQueries({ queryKey: ['empresa'] });
        await qc.invalidateQueries({ queryKey: ['estado-integracion'] });
      });
      toast('Datos guardados', 'ok');
    } catch (err) {
      toast(mensajeError(err), 'error');
    }
  };

  if (!empresa) return null;
  return (
    <div className={ui.pila}>
      <Card className="gap-3">
        <div className={ui.encabezado}>
          <h2>Empresa emisora</h2>
          <Boton variante="primario" icono={PlugZap} cargando={probar.isPending} onClick={() => probar.mutate()}>
            Probar conexión con API-PRO
          </Boton>
        </div>
        {!empresa.ruc ? (
          <Franja tono="aviso">Prueba la conexión para registrar los datos de la empresa desde API-PRO.</Franja>
        ) : (
          <div className={ui.form}>
            <Campo etiqueta="RUC" value={empresa.ruc} readOnly ancho="cuarto" className="font-id" />
            <Campo etiqueta="Razón social" value={empresa.razonSocial ?? ''} readOnly ancho="mitad" />
            <Campo etiqueta="IGV vigente" value={`${Number(empresa.tasaIgv)} %`} readOnly ancho="cuarto" ayuda="Lo informa API-PRO" />
            <Campo etiqueta="Nombre comercial" disabled={!editable} ancho="mitad" {...f.texto('nombreComercial')} />
            <Selector
              etiqueta="Modo de emisión"
              ancho="mitad"
              disabled={!editable}
              value={f.valores.modoEmision}
              onChange={(e) => f.fijar('modoEmision', e.target.value as 'simulacion' | 'real')}
              opciones={[
                { valor: 'simulacion', texto: 'Simulación (no envía a SUNAT)' },
                { valor: 'real', texto: 'Real (envía a API-PRO)' },
              ]}
              ayuda={empresa.api.entorno === 'beta' ? 'API-PRO está en el entorno beta: aun en modo real, los comprobantes no tienen validez tributaria.' : undefined}
            />
          </div>
        )}
        {empresa.ruc && editable && (
          <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'flex-end' }}>
            <Boton icono={Save} onClick={guardar} cargando={f.enviando}>
              Guardar
            </Boton>
          </div>
        )}
      </Card>

      {prueba && (
        <Card className="gap-3">
          <h2 style={{ marginBottom: '0.75rem' }}>Resultado de la prueba</h2>
          <div className={ui.pila}>
            <Franja tono="ok">
              {prueba.razonSocial} (RUC {prueba.ruc}) · entorno {prueba.entorno} · SUNAT {prueba.sunatDisponible ? 'disponible' : 'no disponible'} ·{' '}
              {prueba.seriesSincronizadas} series sincronizadas{prueba.rateLimitPorMinuto ? ` · límite ${prueba.rateLimitPorMinuto} solicitudes/min` : ''}
            </Franja>
            {prueba.avisos.map((a) => (
              <Franja key={a} tono="aviso">
                {a}
              </Franja>
            ))}
            <Tabla
              filas={prueba.sucursalesApi}
              clave={(s) => s.id}
              columnas={[
                { titulo: 'Sucursal en API-PRO', celda: (s) => <>{s.nombre}<span className={ui.sub}>id {s.id}</span></> },
                { titulo: 'Código de local', celda: (s) => <span className="font-id">{s.codLocal}</span> },
                { titulo: 'Series', celda: (s) => s.totalSeries, alinear: 'derecha' },
                { titulo: 'Vínculo', celda: (s) => (s.vinculadaA ? <Chip tono="ok">Vinculada</Chip> : <Chip>Sin vincular</Chip>) },
              ]}
            />
          </div>
        </Card>
      )}

      <Card className="gap-3">
        <div className={ui.encabezado}>
          <h2>Conexión con API-PRO</h2>
          {editable && <Boton onClick={() => setDialogoCredenciales(true)}>Cambiar credenciales</Boton>}
        </div>
        <div className={ui.form}>
          <Campo etiqueta="URL base" value={empresa.api.baseUrl} readOnly ancho="mitad" />
          <Campo etiqueta="API key" value={empresa.api.apiKey ?? '—'} readOnly ancho="cuarto" className="font-id" />
          <Campo etiqueta="Entorno SUNAT" value={empresa.api.entorno ?? '—'} readOnly ancho="cuarto" />
          <Campo etiqueta="Origen de las credenciales" value={ORIGEN[empresa.api.origen]} readOnly ancho="mitad" />
          <Campo etiqueta="Última verificación" value={empresa.api.verificadaEn ? new Date(empresa.api.verificadaEn).toLocaleString('es-PE') : 'Nunca'} readOnly ancho="mitad" />
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          El secreto nunca se muestra ni sale del servidor. Las credenciales solo se guardan si API-PRO las acepta.
        </p>
      </Card>

      <ConsultaDocumentos />

      <CredencialesDialogo abierto={dialogoCredenciales} alCerrar={() => setDialogoCredenciales(false)} baseUrl={empresa.api.baseUrl} />
    </div>
  );
}

function CredencialesDialogo({ abierto, alCerrar, baseUrl }: { abierto: boolean; alCerrar: () => void; baseUrl: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const f = useFormulario({ baseUrl, apiKey: '', apiSecret: '', password: '', confirmarCambioRuc: false });
  const [rucNuevo, setRucNuevo] = useState<string | null>(null);

  const cerrar = () => {
    f.setValores({ baseUrl, apiKey: '', apiSecret: '', password: '', confirmarCambioRuc: false });
    setRucNuevo(null);
    alCerrar();
  };

  const guardar = async () => {
    const datos = f.validar(credencialesApiSchema);
    if (!datos) return;
    try {
      await f.enviar(() => pedir('/empresa/credenciales-api', { method: 'PUT', cuerpo: datos }));
      await qc.invalidateQueries({ queryKey: ['empresa'] });
      await qc.invalidateQueries({ queryKey: ['estado-integracion'] });
      toast('Credenciales verificadas y guardadas', 'ok');
      cerrar();
    } catch (err) {
      if (err instanceof ErrorHttp && err.codigo === 'EMPRESA_DISTINTA') {
        setRucNuevo((err.cuerpo.detalle as { rucNuevo?: string } | undefined)?.rucNuevo ?? '?');
      } else toast(mensajeError(err), 'error');
    }
  };

  return (
    <Dialogo
      titulo="Cambiar credenciales de API-PRO"
      abierto={abierto}
      alCerrar={cerrar}
      pie={
        <>
          <Boton onClick={cerrar}>Cancelar</Boton>
          <Boton variante="primario" onClick={guardar} cargando={f.enviando} disabled={Boolean(rucNuevo) && !f.valores.confirmarCambioRuc}>
            Probar y guardar
          </Boton>
        </>
      }
    >
      <div className={ui.pila}>
        <Franja tono="aviso">Las credenciales nuevas reemplazan a las actuales en todas las cajas. Se prueban antes de guardarse.</Franja>
        {rucNuevo && (
          <Franja tono="alerta">
            Estas credenciales son del RUC {rucNuevo}, distinto del configurado. Si continúas, el sistema emitirá a nombre de otra empresa.
            <div style={{ marginTop: '0.5rem' }}>
              <Casilla etiqueta="Entiendo y quiero cambiar de empresa" checked={f.valores.confirmarCambioRuc} onChange={(e) => f.fijar('confirmarCambioRuc', e.target.checked)} />
            </div>
          </Franja>
        )}
        <div className={ui.form}>
          <Campo etiqueta="URL base" {...f.texto('baseUrl')} />
          <Campo etiqueta="API key" autoComplete="off" {...f.texto('apiKey')} />
          <Campo etiqueta="API secret" type="password" autoComplete="off" {...f.texto('apiSecret')} />
          <Campo etiqueta="Tu contraseña" type="password" autoComplete="current-password" ayuda="Para confirmar el cambio" {...f.texto('password')} />
        </div>
      </div>
    </Dialogo>
  );
}
