import { Building2, Coins, ListOrdered, MonitorSmartphone, SlidersHorizontal, Store, Users } from 'lucide-react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Encabezado, Pestanas, Vacio } from '../../components/ui';
import { useSesion } from '../../lib/sesion';
import { AjustesTab } from './AjustesTab';
import { DispositivosTab } from './DispositivosTab';
import { EmpresaTab } from './EmpresaTab';
import { SeriesTab } from './SeriesTab';
import { SucursalesTab } from './SucursalesTab';
import { TipoCambioTab } from './TipoCambioTab';
import { UsuariosTab } from './UsuariosTab';

const PESTANAS = [
  { ruta: 'empresa', texto: 'Empresa y conexión', icono: Building2, permiso: 'config.ver', el: <EmpresaTab /> },
  { ruta: 'sucursales', texto: 'Sucursales', icono: Store, permiso: 'config.ver', el: <SucursalesTab /> },
  { ruta: 'series', texto: 'Series', icono: ListOrdered, permiso: 'series.ver', el: <SeriesTab /> },
  { ruta: 'usuarios', texto: 'Usuarios', icono: Users, permiso: 'usuarios.ver', el: <UsuariosTab /> },
  { ruta: 'dispositivos', texto: 'Dispositivos de caja', icono: MonitorSmartphone, permiso: 'config.ver', el: <DispositivosTab /> },
  { ruta: 'tipo-cambio', texto: 'Tipo de cambio', icono: Coins, permiso: 'tipocambio.editar', el: <TipoCambioTab /> },
  { ruta: 'ajustes', texto: 'Ajustes', icono: SlidersHorizontal, permiso: 'config.ver', el: <AjustesTab /> },
];

export function ConfiguracionPage() {
  const { puede } = useSesion();
  const visibles = PESTANAS.filter((p) => puede(p.permiso));
  if (!visibles.length) return <Vacio texto="No tienes permiso para ver la configuración." />;
  return (
    <>
      <Encabezado titulo="Configuración" />
      <Pestanas items={visibles.map((p) => ({ ruta: `/configuracion/${p.ruta}`, texto: p.texto, icono: p.icono }))} />
      <Routes>
        {visibles.map((p) => (
          <Route key={p.ruta} path={p.ruta} element={p.el} />
        ))}
        <Route path="*" element={<Navigate to={visibles[0]!.ruta} replace />} />
      </Routes>
    </>
  );
}
