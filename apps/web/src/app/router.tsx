import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import { CambiarPasswordPage } from '../features/auth/CambiarPasswordPage';
import { LoginPage } from '../features/auth/LoginPage';
import { EnConstruccion } from '../features/EnConstruccion';
import { AppLayout } from '../layouts/AppLayout';
import { MENU } from '../layouts/navegacion';
import { RequierePermiso, RequiereSesion } from './guardas';

// Cada pantalla se descarga al entrar por primera vez (code splitting): el POS no espera a reportes
// ni a configuración. Login y el layout van en el paquete inicial.
const diferida = <M extends Record<string, unknown>>(carga: () => Promise<M>, nombre: keyof M) =>
  lazy(async () => ({ default: (await carga())[nombre] as ComponentType }));

const InicioPage = diferida(() => import('../features/inicio/InicioPage'), 'InicioPage');
const ReportesPage = diferida(() => import('../features/reportes/ReportesPage'), 'ReportesPage');
const ProductosPage = diferida(() => import('../features/productos/ProductosPage'), 'ProductosPage');
const InventarioPage = diferida(() => import('../features/inventario/InventarioPage'), 'InventarioPage');
const ClientesPage = diferida(() => import('../features/terceros/ClientesPage'), 'ClientesPage');
const ComprasPage = diferida(() => import('../features/compras/ComprasPage'), 'ComprasPage');
const PosPage = diferida(() => import('../features/pos/PosPage'), 'PosPage');
const CajaPage = diferida(() => import('../features/caja/CajaPage'), 'CajaPage');
const CxcPage = diferida(() => import('../features/cxc/CxcPage'), 'CxcPage');
const ComprobantesPage = diferida(() => import('../features/comprobantes/ComprobantesPage'), 'ComprobantesPage');
const NotasPage = diferida(() => import('../features/comprobantes/ComprobantesPage'), 'NotasPage');
const ResumenesPage = diferida(() => import('../features/resumenes/ResumenesPage'), 'ResumenesPage');
const GuiasPage = diferida(() => import('../features/guias/GuiasPage'), 'GuiasPage');
const ConfiguracionPage = diferida(() => import('../features/configuracion/ConfiguracionPage'), 'ConfiguracionPage');

const PANTALLAS: Record<string, ReactNode> = {
  '/': <InicioPage />,
  '/reportes': <ReportesPage />,
  '/productos': <ProductosPage />,
  '/inventario': <InventarioPage />,
  '/clientes': <ClientesPage />,
  '/compras': <ComprasPage />,
  '/vender': <PosPage />,
  '/caja': <CajaPage />,
  '/cuentas-por-cobrar': <CxcPage />,
  '/comprobantes': <ComprobantesPage />,
  '/notas': <NotasPage />,
  '/resumenes': <ResumenesPage />,
  '/guias': <GuiasPage />,
  '/configuracion': <ConfiguracionPage />,
};

const cargando = <span className="muted">Cargando…</span>;

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/cambiar-password', element: <CambiarPasswordPage /> },
  {
    path: '/',
    element: (
      <RequiereSesion>
        <AppLayout />
      </RequiereSesion>
    ),
    children: MENU.flatMap((g) => g.items).map((i) => {
      const pantalla = <Suspense fallback={cargando}>{PANTALLAS[i.ruta] ?? <EnConstruccion titulo={i.texto} />}</Suspense>;
      if (i.ruta === '/') return { index: true, element: <RequierePermiso permiso={i.permiso}>{pantalla}</RequierePermiso> };
      // Configuración aplica sus propios permisos por pestaña.
      const elemento = i.ruta === '/configuracion' ? pantalla : <RequierePermiso permiso={i.permiso}>{pantalla}</RequierePermiso>;
      return { path: `${i.ruta.slice(1)}/*`, element: elemento };
    }),
  },
]);
