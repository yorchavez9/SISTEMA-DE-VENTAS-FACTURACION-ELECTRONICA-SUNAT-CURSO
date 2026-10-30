import {
  ArrowLeftRight, BarChart3, FileText, LayoutDashboard, Package, ReceiptText, RotateCcw,
  Settings, ShoppingCart, Truck, Users, Wallet, CreditCard, ShoppingBag, type LucideIcon,
} from 'lucide-react';

export interface ItemMenu {
  ruta: string;
  texto: string;
  icono: LucideIcon;
  /** Permiso requerido (se aplica a partir de la fase 4). */
  permiso: string;
}

export interface GrupoMenu {
  titulo: string;
  items: ItemMenu[];
}

// Estructura de docs/04-prototipos.md §3.
export const MENU: GrupoMenu[] = [
  {
    titulo: 'Operación',
    items: [
      { ruta: '/', texto: 'Inicio', icono: LayoutDashboard, permiso: 'dashboard.ver' },
      { ruta: '/vender', texto: 'Vender', icono: ShoppingCart, permiso: 'ventas.crear' },
      { ruta: '/caja', texto: 'Caja', icono: Wallet, permiso: 'caja.ver' },
    ],
  },
  {
    titulo: 'Ventas',
    items: [
      { ruta: '/comprobantes', texto: 'Comprobantes', icono: ReceiptText, permiso: 'comprobantes.ver' },
      { ruta: '/notas', texto: 'Notas', icono: RotateCcw, permiso: 'notas.crear' },
      { ruta: '/resumenes', texto: 'Resumen diario', icono: FileText, permiso: 'resumenes.ver' },
      { ruta: '/cuentas-por-cobrar', texto: 'Cuentas por cobrar', icono: CreditCard, permiso: 'cxc.ver' },
      { ruta: '/clientes', texto: 'Clientes', icono: Users, permiso: 'clientes.ver' },
    ],
  },
  {
    titulo: 'Almacén',
    items: [
      { ruta: '/productos', texto: 'Productos', icono: Package, permiso: 'productos.ver' },
      { ruta: '/inventario', texto: 'Inventario', icono: ArrowLeftRight, permiso: 'inventario.ver' },
      { ruta: '/compras', texto: 'Compras', icono: ShoppingBag, permiso: 'compras.ver' },
      { ruta: '/guias', texto: 'Guías', icono: Truck, permiso: 'guias.ver' },
    ],
  },
  {
    titulo: 'Administración',
    items: [
      { ruta: '/reportes', texto: 'Reportes', icono: BarChart3, permiso: 'reportes.ver' },
      { ruta: '/configuracion', texto: 'Configuración', icono: Settings, permiso: 'config.ver' },
    ],
  },
];
