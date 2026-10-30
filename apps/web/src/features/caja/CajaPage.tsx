import { movimientoCajaSchema, type Moneda, type ResumenTurnoDto } from '@sv/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownCircle, ArrowUpCircle, Lock, Plus, Printer, Unlock } from 'lucide-react';
import { useState } from 'react';
import { FilaTicket, SeparadorTicket, Ticket, ZonaImpresion } from '../../components/Ticket';
import { Boton, Campo, Chip, Dialogo, Encabezado, Franja, Selector, Tabla, ui, useToast, Vacio } from '../../components/ui';
import { useCajaActiva, useMetodosPago } from '../../lib/caja';
import { dinero, fechaHora } from '../../lib/formato';
import { mensajeError, pedir } from '../../lib/http';
import { useSesion } from '../../lib/sesion';
import estilos from './caja.module.css';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';

export function CajaPage() {
  const { puede } = useSesion();
  const { cajas, caja, elegir, cargando, refrescar } = useCajaActiva();
  const [nuevaCaja, setNuevaCaja] = useState(false);

  if (cargando) return null;
  return (
    <>
      <Encabezado titulo="Caja">
        {cajas.length > 1 && (
          <Selector value={String(caja?.id ?? '')} onChange={(e) => elegir(Number(e.target.value))} aria-label="Caja" opciones={[...cajas.map((c) => ({ valor: String(c.id), texto: c.nombre }))]} />
        )}
        {puede('config.editar') && (
          <Boton icono={Plus} onClick={() => setNuevaCaja(true)}>
            Nueva caja
          </Boton>
        )}
      </Encabezado>
      {!caja ? (
        <Vacio texto={puede('config.editar') ? 'Esta sucursal aún no tiene cajas. Crea la primera.' : 'Esta sucursal aún no tiene cajas. Pide a un administrador que cree una.'} />
      ) : caja.turnoAbierto ? (
        <TurnoAbierto turnoId={caja.turnoAbierto.id} alCerrar={() => void refrescar()} />
      ) : (
        <AbrirTurno cajaId={caja.id} nombre={caja.nombre} alAbrir={() => void refrescar()} />
      )}
      {nuevaCaja && <NuevaCaja alCerrar={() => setNuevaCaja(false)} alCrear={(id) => (elegir(id), void refrescar())} />}
    </>
  );
}

function NuevaCaja({ alCerrar, alCrear }: { alCerrar: () => void; alCrear: (id: number) => void }) {
  const toast = useToast();
  const [nombre, setNombre] = useState('Caja 1');
  const [enviando, setEnviando] = useState(false);
  const crear = async () => {
    setEnviando(true);
    try {
      const r = await pedir<{ id: number }>('/cajas', { cuerpo: { nombre } });
      alCrear(r.id);
      alCerrar();
    } catch (err) {
      toast(mensajeError(err), 'error');
    } finally {
      setEnviando(false);
    }
  };
  return (
    <Dialogo titulo="Nueva caja" abierto alCerrar={alCerrar} pie={<><Boton onClick={alCerrar}>Cancelar</Boton><Boton variante="primario" onClick={crear} cargando={enviando}>Crear</Boton></>}>
      <div className={ui.form}>
        <Campo etiqueta="Nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} />
      </div>
    </Dialogo>
  );
}

function AbrirTurno({ cajaId, nombre, alAbrir }: { cajaId: number; nombre: string; alAbrir: () => void }) {
  const { puede } = useSesion();
  const toast = useToast();
  const [pen, setPen] = useState('0');
  const [usd, setUsd] = useState('0');
  const [enviando, setEnviando] = useState(false);
  const [clave] = useState(() => crypto.randomUUID());

  const abrir = async () => {
    setEnviando(true);
    try {
      await pedir('/turnos/abrir', { cuerpo: { cajaId, saldosIniciales: [{ moneda: 'PEN', monto: pen || '0' }, { moneda: 'USD', monto: usd || '0' }] }, idempotente: clave });
      toast(`${nombre} abierta`, 'ok');
      alAbrir();
    } catch (err) {
      toast(mensajeError(err), 'error');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Card className="gap-3" style={{ maxWidth: '32rem' }}>
      <div className={ui.pila}>
        <h2>
          <Lock size={16} strokeWidth={2.5} style={{ verticalAlign: '-2px' }} /> {nombre} está cerrada
        </h2>
        <span className="muted">Cuenta el efectivo con el que empiezas el turno.</span>
        <div className={ui.form}>
          <Campo etiqueta="Efectivo inicial S/" inputMode="decimal" ancho="mitad" value={pen} onChange={(e) => setPen(e.target.value.replace(',', '.'))} />
          <Campo etiqueta="Efectivo inicial US$" inputMode="decimal" ancho="mitad" value={usd} onChange={(e) => setUsd(e.target.value.replace(',', '.'))} />
        </div>
        {puede('caja.abrir') ? (
          <Boton variante="primario" icono={Unlock} onClick={abrir} cargando={enviando}>
            Abrir caja
          </Boton>
        ) : (
          <Franja tono="aviso">No tienes permiso para abrir la caja.</Franja>
        )}
      </div>
    </Card>
  );
}

function TurnoAbierto({ turnoId, alCerrar }: { turnoId: number; alCerrar: () => void }) {
  const { puede } = useSesion();
  const { data: r } = useQuery({ queryKey: ['turno', turnoId], queryFn: () => pedir<ResumenTurnoDto>(`/turnos/${turnoId}`), refetchInterval: 30_000 });
  const [dialogo, setDialogo] = useState<'ingreso' | 'egreso' | 'cerrar' | null>(null);
  const [arqueo, setArqueo] = useState<ResumenTurnoDto | null>(null);

  if (arqueo) return <ArqueoCerrado resumen={arqueo} alContinuar={() => (setArqueo(null), alCerrar())} />;
  if (!r) return null;
  return (
    <div className={ui.pila}>
      <div className={ui.encabezado}>
        <span>
          {r.turno.caja.nombre} · abierta por <strong>{r.turno.abiertoPor}</strong> el {fechaHora(r.turno.abiertoEn)}
        </span>
        <div className={ui.acciones}>
          {puede('caja.movimientos') && (
            <>
              <Boton icono={ArrowDownCircle} onClick={() => setDialogo('ingreso')}>
                Ingreso
              </Boton>
              <Boton icono={ArrowUpCircle} onClick={() => setDialogo('egreso')}>
                Egreso
              </Boton>
            </>
          )}
          {puede('caja.cerrar') && (
            <Boton variante="primario" icono={Lock} onClick={() => setDialogo('cerrar')}>
              Cerrar caja
            </Boton>
          )}
        </div>
      </div>
      <div className={estilos.tarjetas}>
        {r.efectivo.map((e) => (
          <Card key={e.moneda} className="gap-3">
            <span className="muted">Efectivo {e.moneda}</span>
            <strong className={`${estilos.monto} num`}>{dinero(e.esperado, e.moneda)}</strong>
            <span className={ui.sub}>
              inicial {dinero(e.inicial, e.moneda)} · +{dinero(e.entradas, e.moneda)} · −{dinero(e.salidas, e.moneda)}
            </span>
          </Card>
        ))}
        <Card className="gap-3">
          <span className="muted">Otros medios</span>
          {r.porMetodo.filter((p) => p.tipo !== 'efectivo').length === 0 && <strong className={estilos.monto}>—</strong>}
          {r.porMetodo
            .filter((p) => p.tipo !== 'efectivo')
            .map((p) => (
              <div key={`${p.metodo}-${p.moneda}`} className={estilos.linea}>
                <span>{p.metodo}</span>
                <strong className="num">{dinero(p.total, p.moneda)}</strong>
              </div>
            ))}
        </Card>
      </div>
      <Tabla
        filas={[...r.movimientos].reverse()}
        clave={(m) => m.id}
        vacio="Aún no hay movimientos en este turno."
        columnas={[
          { titulo: 'Hora', celda: (m) => new Date(m.fecha).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' }) },
          { titulo: 'Tipo', celda: (m) => <Chip tono={Number(m.monto) < 0 ? 'aviso' : 'ok'}>{m.tipo}</Chip> },
          { titulo: 'Concepto', celda: (m) => <>{m.concepto}{m.referencia && <span className={ui.sub}>Op. {m.referencia}</span>}</> },
          { titulo: 'Medio', celda: (m) => m.metodo },
          { titulo: 'Importe', celda: (m) => <span style={{ color: Number(m.monto) < 0 ? 'var(--danger)' : undefined }}>{dinero(m.monto, m.moneda)}</span>, alinear: 'derecha' },
          { titulo: 'Usuario', celda: (m) => m.usuario },
        ]}
      />
      {(dialogo === 'ingreso' || dialogo === 'egreso') && <MovimientoDialogo tipo={dialogo} turnoId={turnoId} alCerrar={() => setDialogo(null)} />}
      {dialogo === 'cerrar' && <CerrarDialogo resumen={r} alCerrar={() => setDialogo(null)} alCerrado={(res) => (setDialogo(null), setArqueo(res))} />}
    </div>
  );
}

function MovimientoDialogo({ tipo, turnoId, alCerrar }: { tipo: 'ingreso' | 'egreso'; turnoId: number; alCerrar: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: metodos = [] } = useMetodosPago();
  const [datos, setDatos] = useState({ metodoPagoId: '', moneda: 'PEN' as Moneda, monto: '', concepto: '', referencia: '' });
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [clave] = useState(() => crypto.randomUUID());
  const metodoId = datos.metodoPagoId || String(metodos[0]?.id ?? '');

  const guardar = async () => {
    const r = movimientoCajaSchema.safeParse({ ...datos, tipo, metodoPagoId: metodoId, referencia: datos.referencia || undefined });
    if (!r.success) return setError(r.error.issues[0]?.message ?? 'Datos inválidos');
    setEnviando(true);
    setError(null);
    try {
      await pedir(`/turnos/${turnoId}/movimientos`, { cuerpo: r.data, idempotente: clave });
      await qc.invalidateQueries({ queryKey: ['turno', turnoId] });
      toast(tipo === 'ingreso' ? 'Ingreso registrado' : 'Egreso registrado', 'ok');
      alCerrar();
    } catch (err) {
      setError(mensajeError(err));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialogo titulo={tipo === 'ingreso' ? 'Registrar ingreso' : 'Registrar egreso'} abierto alCerrar={alCerrar} pie={<><Boton onClick={alCerrar}>Cancelar</Boton><Boton variante="primario" onClick={guardar} cargando={enviando}>Registrar</Boton></>}>
      <div className={ui.pila}>
        {error && <Franja tono="alerta">{error}</Franja>}
        <div className={ui.form}>
          <Selector etiqueta="Medio" ancho="mitad" value={metodoId} onChange={(e) => setDatos({ ...datos, metodoPagoId: e.target.value })} opciones={metodos.map((m) => ({ valor: String(m.id), texto: m.nombre }))} />
          <Selector etiqueta="Moneda" ancho="cuarto" value={datos.moneda} onChange={(e) => setDatos({ ...datos, moneda: e.target.value as Moneda })} opciones={[{ valor: 'PEN', texto: 'S/' }, { valor: 'USD', texto: 'US$' }]} />
          <Campo etiqueta="Importe" ancho="cuarto" inputMode="decimal" value={datos.monto} onChange={(e) => setDatos({ ...datos, monto: e.target.value.replace(',', '.') })} />
          <Campo etiqueta="Concepto" placeholder={tipo === 'ingreso' ? 'Sencillo, reposición…' : 'Movilidad, pago a proveedor…'} value={datos.concepto} onChange={(e) => setDatos({ ...datos, concepto: e.target.value })} />
          <Campo etiqueta="N° de operación" opcional value={datos.referencia} onChange={(e) => setDatos({ ...datos, referencia: e.target.value })} />
        </div>
      </div>
    </Dialogo>
  );
}

function CerrarDialogo({ resumen, alCerrar, alCerrado }: { resumen: ResumenTurnoDto; alCerrar: () => void; alCerrado: (r: ResumenTurnoDto) => void }) {
  const qc = useQueryClient();
  const [contado, setContado] = useState<Record<string, string>>({});
  const [nota, setNota] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const monedas = resumen.efectivo.filter((e) => Number(e.esperado) > 0 || Number(e.inicial) > 0);

  const cerrar = async () => {
    setEnviando(true);
    setError(null);
    try {
      const r = await pedir<ResumenTurnoDto>(`/turnos/${resumen.turno.id}/cerrar`, {
        cuerpo: { contado: monedas.map((e) => ({ moneda: e.moneda, monto: contado[e.moneda] || '0' })), nota: nota || undefined },
      });
      await qc.invalidateQueries({ queryKey: ['cajas'] });
      alCerrado(r);
    } catch (err) {
      setError(mensajeError(err));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialogo titulo={`Cerrar ${resumen.turno.caja.nombre}`} abierto alCerrar={alCerrar} pie={<><Boton onClick={alCerrar}>Cancelar</Boton><Boton variante="primario" onClick={cerrar} cargando={enviando}>Cerrar turno</Boton></>}>
      <div className={ui.pila}>
        {error && <Franja tono="alerta">{error}</Franja>}
        <span className="muted">Cuenta el efectivo de la caja. Los demás medios (Yape, tarjeta…) no se cuentan.</span>
        <Tabla
          filas={monedas}
          clave={(e) => e.moneda}
          numerar={false}
          columnas={[
            { titulo: 'Moneda', celda: (e) => e.moneda },
            { titulo: 'Esperado', alinear: 'derecha', celda: (e) => dinero(e.esperado, e.moneda) },
            { titulo: 'Contado', fija: true, celda: (e) => <Input className="w-28" inputMode="decimal" value={contado[e.moneda] ?? ''} aria-label={`Contado ${e.moneda}`} onChange={(ev) => setContado({ ...contado, [e.moneda]: ev.target.value.replace(',', '.') })} /> },
            {
              titulo: 'Diferencia',
              alinear: 'derecha',
              celda: (e) => {
                const dif = contado[e.moneda] ? Number(contado[e.moneda]) - Number(e.esperado) : null;
                return <span style={{ color: dif && Math.abs(dif) >= 0.005 ? 'var(--danger)' : undefined }}>{dif === null ? '—' : dinero(dif.toFixed(2), e.moneda)}</span>;
              },
            },
          ]}
        />
        <div className={ui.form}>
          <Campo etiqueta="Nota" opcional placeholder="Explica cualquier diferencia" value={nota} onChange={(e) => setNota(e.target.value)} />
        </div>
      </div>
    </Dialogo>
  );
}

function ArqueoCerrado({ resumen, alContinuar }: { resumen: ResumenTurnoDto; alContinuar: () => void }) {
  return (
    <Card className="gap-3" style={{ maxWidth: '36rem' }}>
      <div className={ui.pila}>
        <h2>Turno cerrado</h2>
        <Tabla
          filas={resumen.efectivo}
          clave={(e) => e.moneda}
          columnas={[
            { titulo: 'Moneda', celda: (e) => e.moneda },
            { titulo: 'Esperado', celda: (e) => dinero(e.esperado, e.moneda), alinear: 'derecha' },
            { titulo: 'Contado', celda: (e) => dinero(e.contado, e.moneda), alinear: 'derecha' },
            { titulo: 'Diferencia', celda: (e) => <span style={{ color: Number(e.diferencia) !== 0 ? 'var(--danger)' : 'var(--ok-strong)' }}>{dinero(e.diferencia, e.moneda)}</span>, alinear: 'derecha' },
          ]}
        />
        <div className={ui.acciones}>
          <Boton icono={Printer} onClick={() => window.print()}>
            Imprimir arqueo
          </Boton>
          <Boton variante="primario" onClick={alContinuar}>
            Continuar
          </Boton>
        </div>
      </div>
      <ZonaImpresion>
        <Ticket>
          <h3>ARQUEO DE CAJA</h3>
          <p>{resumen.turno.caja.nombre}</p>
          <SeparadorTicket />
          <FilaTicket izquierda="Apertura" derecha={fechaHora(resumen.turno.abiertoEn)} />
          <FilaTicket izquierda="Cierre" derecha={fechaHora(resumen.turno.cerradoEn)} />
          <FilaTicket izquierda="Cerró" derecha={resumen.turno.cerradoPor ?? ''} />
          <SeparadorTicket />
          {resumen.efectivo.map((e) => (
            <div key={e.moneda}>
              <FilaTicket izquierda={`Efectivo ${e.moneda}`} fuerte />
              <FilaTicket izquierda="Esperado" derecha={dinero(e.esperado, e.moneda)} />
              <FilaTicket izquierda="Contado" derecha={dinero(e.contado, e.moneda)} />
              <FilaTicket izquierda="Diferencia" derecha={dinero(e.diferencia, e.moneda)} />
            </div>
          ))}
          <SeparadorTicket />
          {resumen.porMetodo.map((p) => (
            <FilaTicket key={`${p.metodo}-${p.moneda}`} izquierda={p.metodo} derecha={dinero(p.total, p.moneda)} />
          ))}
          {resumen.turno.nota && (
            <>
              <SeparadorTicket />
              <p>{resumen.turno.nota}</p>
            </>
          )}
        </Ticket>
      </ZonaImpresion>
    </Card>
  );
}
