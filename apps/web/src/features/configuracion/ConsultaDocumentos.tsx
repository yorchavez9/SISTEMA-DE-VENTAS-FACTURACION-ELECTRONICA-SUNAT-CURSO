import { PROVEEDORES_DOCUMENTO, type ProveedorDocumento, type ProveedorDocumentoDto, type PruebaProveedorDocumentoDto } from '@sv/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, IdCard, Save, Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alternador, Boton, Campo, Casilla, Chip, Franja, Selector, ui, useToast } from '../../components/ui';
import { ErrorHttp, mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

// Proveedores para buscar DNI y RUC al vender o registrar clientes. Se prueba primero el
// principal; si no encuentra o falla, el otro, y al final API-PRO.

const SITIO: Record<ProveedorDocumento, string> = { jsonpe: 'https://json.pe', migo: 'https://migo.pe' };
const CODIGOS = Object.keys(PROVEEDORES_DOCUMENTO) as ProveedorDocumento[];

interface Edicion {
  activo: boolean;
  token: string;
  quitarToken: boolean;
}

export function ConsultaDocumentos() {
  const { puede } = useSesion();
  const editable = puede('config.editar');
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['consulta-documentos'], queryFn: () => pedir<ProveedorDocumentoDto[]>('/configuracion/consulta-documentos') });
  const [principal, setPrincipal] = useState<ProveedorDocumento>('jsonpe');
  const [edicion, setEdicion] = useState<Record<ProveedorDocumento, Edicion>>({ jsonpe: { activo: false, token: '', quitarToken: false }, migo: { activo: false, token: '', quitarToken: false } });
  const [errores, setErrores] = useState<Record<string, string>>({});
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (!data) return;
    setPrincipal(data[0]?.codigo ?? 'jsonpe');
    setEdicion(Object.fromEntries(CODIGOS.map((c) => [c, { activo: data.find((p) => p.codigo === c)?.activo ?? false, token: '', quitarToken: false }])) as Record<ProveedorDocumento, Edicion>);
  }, [data]);

  if (!data) return null;
  const guardado = (c: ProveedorDocumento) => data.find((p) => p.codigo === c);
  const fijar = (c: ProveedorDocumento, cambio: Partial<Edicion>) => setEdicion((e) => ({ ...e, [c]: { ...e[c], ...cambio } }));

  const guardar = async () => {
    setErrores({});
    setGuardando(true);
    try {
      const proveedores = CODIGOS.map((c) => ({ codigo: c, activo: edicion[c].activo, ...(edicion[c].token.trim() ? { token: edicion[c].token.trim() } : {}), ...(edicion[c].quitarToken ? { quitarToken: true } : {}) }));
      const nuevos = await pedir<ProveedorDocumentoDto[]>('/configuracion/consulta-documentos', { method: 'PUT', cuerpo: { principal, proveedores } });
      qc.setQueryData(['consulta-documentos'], nuevos);
      toast('Consulta de DNI y RUC guardada', 'ok');
    } catch (err) {
      if (err instanceof ErrorHttp && err.campos) setErrores(err.campos);
      toast(mensajeError(err), 'error');
    } finally {
      setGuardando(false);
    }
  };

  return (
    <Card className="gap-4">
      <div className={ui.encabezado} style={{ marginBottom: 0 }}>
        <div>
          <h2 className="flex items-center gap-2">
            <IdCard className="size-5 text-primary" aria-hidden /> Consulta de DNI y RUC
          </h2>
          <p className="muted" style={{ margin: '0.25rem 0 0' }}>
            Completa el nombre y la dirección del cliente al escribir su DNI o RUC. Puedes usar json.pe, MIGO o los dos: si el principal no encuentra el número o falla, se usa el otro y, al final, API-PRO.
          </p>
        </div>
      </div>

      <div className="grid gap-2">
        <span className="text-sm font-medium">Proveedor principal</span>
        <Alternador
          etiqueta="Proveedor principal"
          valor={principal}
          alCambiar={setPrincipal}
          opciones={CODIGOS.map((c) => ({ valor: c, texto: PROVEEDORES_DOCUMENTO[c], icono: principal === c ? Star : undefined, deshabilitado: !editable }))}
        />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {CODIGOS.map((c) => {
          const g = guardado(c);
          const e = edicion[c];
          return (
            <section key={c} className="grid content-start gap-3" aria-label={PROVEEDORES_DOCUMENTO[c]}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="m-0 flex items-center gap-2 text-base font-semibold">
                  {PROVEEDORES_DOCUMENTO[c]}
                  {principal === c && <Chip tono="info">Principal</Chip>}
                </h3>
                <Chip tono={g?.activo ? 'ok' : undefined}>{g?.activo ? 'En uso' : 'Sin usar'}</Chip>
              </div>
              <Casilla etiqueta={`Usar ${PROVEEDORES_DOCUMENTO[c]}`} checked={e.activo} disabled={!editable} onChange={(ev) => fijar(c, { activo: ev.target.checked })} />
              <div className={ui.form}>
                <Campo
                  etiqueta="Token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!editable}
                  placeholder={g?.token && !e.quitarToken ? `Guardado ${g.token} · escribe otro para cambiarlo` : 'Pega aquí tu token'}
                  value={e.token}
                  error={errores[`token.${c}`] ?? errores[`proveedores.${CODIGOS.indexOf(c)}.token`]}
                  ayuda={
                    <>
                      Se guarda cifrado y no se vuelve a mostrar. Obtén el tuyo en{' '}
                      <a href={SITIO[c]} target="_blank" rel="noreferrer noopener">
                        {SITIO[c].replace('https://', '')}
                      </a>
                      .
                    </>
                  }
                  onChange={(ev) => fijar(c, { token: ev.target.value, quitarToken: false })}
                />
              </div>
              {editable && g?.token && !e.token && (
                <Button variant="link" className="h-auto justify-self-start p-0 text-sm text-muted-foreground" onClick={() => fijar(c, { quitarToken: !e.quitarToken, activo: e.quitarToken ? e.activo : false })}>
                  {e.quitarToken ? 'Conservar el token guardado' : 'Quitar el token guardado'}
                </Button>
              )}
              {editable && g?.token && <Probar codigo={c} />}
            </section>
          );
        })}
      </div>

      {editable && (
        <div className="flex justify-end">
          <Boton variante="primario" icono={Save} onClick={guardar} cargando={guardando}>
            Guardar
          </Boton>
        </div>
      )}
    </Card>
  );
}

/** Consulta de prueba con el token guardado (gasta una consulta del plan del proveedor). */
function Probar({ codigo }: { codigo: ProveedorDocumento }) {
  const [tipoDoc, setTipoDoc] = useState<'1' | '6'>('6');
  const [numDoc, setNumDoc] = useState('');
  const [resultado, setResultado] = useState<PruebaProveedorDocumentoDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [probando, setProbando] = useState(false);
  const valido = (tipoDoc === '1' ? /^\d{8}$/ : /^\d{11}$/).test(numDoc);

  const probar = async () => {
    setProbando(true);
    setError(null);
    setResultado(null);
    try {
      setResultado(await pedir<PruebaProveedorDocumentoDto>('/configuracion/consulta-documentos/probar', { cuerpo: { codigo, tipoDoc, numDoc } }));
    } catch (err) {
      setError(mensajeError(err));
    } finally {
      setProbando(false);
    }
  };

  return (
    <div className="grid gap-2">
      <div className={ui.form}>
        <Selector etiqueta="Probar con" ancho="cuarto" value={tipoDoc} onChange={(e) => (setTipoDoc(e.target.value as '1' | '6'), setResultado(null))} opciones={[{ valor: '6', texto: 'RUC' }, { valor: '1', texto: 'DNI' }]} />
        <Campo etiqueta="Número" ancho="mitad" inputMode="numeric" maxLength={tipoDoc === '1' ? 8 : 11} value={numDoc} onChange={(e) => (setNumDoc(e.target.value.replace(/\D/g, '')), setResultado(null))} onKeyDown={(e) => e.key === 'Enter' && valido && void probar()} />
        <div className={`${ui.campo} ${ui.cuarto} justify-end`}>
          <Boton icono={FlaskConical} disabled={!valido} cargando={probando} onClick={probar}>
            Probar
          </Boton>
        </div>
      </div>
      {error && <Franja tono="alerta">{error}</Franja>}
      {resultado?.resultado === 'encontrado' && (
        <Franja tono="ok">
          {resultado.razonSocial}
          {resultado.direccion ? ` · ${resultado.direccion}` : ''} ({resultado.duracionMs} ms)
        </Franja>
      )}
      {resultado && resultado.resultado !== 'encontrado' && <Franja tono={resultado.resultado === 'error' ? 'alerta' : 'aviso'}>{resultado.mensaje}</Franja>}
    </div>
  );
}
