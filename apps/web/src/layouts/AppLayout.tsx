import { LogOut, Moon, Store, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu,
  SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar,
} from '@/components/ui/sidebar';
import { AvisoPausa, EstadoSistema } from '../components/EstadoSistema';
import { Selector, useToast } from '../components/ui';
import { MiPinDialogo } from '../features/auth/MiPinDialogo';
import { mensajeError } from '../lib/http';
import { useSesion } from '../lib/sesion';
import { useTema } from '../lib/tema';
import css from './AppLayout.module.css';
import { nombreRol } from '../lib/roles';
import { MENU } from './navegacion';

/** Estado del menú (abierto o plegado a íconos) guardado por el Sidebar de shadcn en la cookie sidebar_state. */
function menuAbierto(): boolean {
  const m = /(?:^|;\s*)sidebar_state=(true|false)/.exec(document.cookie);
  return m ? m[1] === 'true' : true;
}

/** Ítem del menú como ferretería: sin fondo al pasar ni al estar activo; el activo va en naranja oscuro y negrita, con el icono en primario. */
const ITEM = 'font-semibold [&>svg]:size-4';

/** Menú lateral (Sidebar de shadcn): grupos de navegación según los permisos del usuario. */
function MenuLateral({ alMiPin }: { alMiPin: () => void }) {
  const { sesion, puede, salir } = useSesion();
  const { pathname } = useLocation();
  const { isMobile, setOpenMobile } = useSidebar();

  // En el celular el menú es un panel (Sheet): cualquier navegación lo cierra.
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [pathname, isMobile, setOpenMobile]);

  const menu = MENU.map((g) => ({ ...g, items: g.items.filter((i) => puede(i.permiso)) })).filter((g) => g.items.length);
  const activo = (ruta: string) => (ruta === '/' ? pathname === '/' : pathname === ruta || pathname.startsWith(`${ruta}/`));

  return (
    <Sidebar collapsible="icon" aria-label="Menú principal">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="CMA STORE" className="">
              <NavLink to="/">
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
                  <Store className="size-[1.1rem]" aria-hidden />
                </span>
                <span className="grid flex-1 text-left leading-tight">
                  <strong className="truncate text-[0.9375rem] tracking-[-0.01em]">CMA STORE</strong>
                  <span className="truncate text-[0.6875rem] font-semibold text-muted-foreground">{sesion?.dispositivo ? sesion.dispositivo.nombre : 'Punto de venta'}</span>
                </span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {menu.map((g) => (
          <SidebarGroup key={g.titulo}>
            <SidebarGroupLabel>{g.titulo}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {g.items.map((i) => (
                  <SidebarMenuItem key={i.ruta}>
                    <SidebarMenuButton asChild isActive={activo(i.ruta)} tooltip={i.texto} className={ITEM}>
                      <NavLink to={i.ruta} end={i.ruta === '/'}>
                        <i.icono aria-hidden />
                        <span>{i.texto}</span>
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      {/* Pie como ferretería: el usuario (abre "Mi PIN") y Salir. */}
      {sesion && (
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" tooltip="Cambiar mi PIN" title="Cambiar mi PIN" onClick={alMiPin}>
                <span className="grid size-8 shrink-0 place-items-center rounded-md bg-campo text-sm font-bold text-marca" aria-hidden>
                  {sesion.operador.nombre.charAt(0).toUpperCase()}
                </span>
                <span className="grid min-w-0 flex-1 text-left leading-tight">
                  <span className="truncate font-bold">{sesion.operador.nombre}</span>
                  <span className="truncate text-xs font-semibold text-muted-foreground">{nombreRol(sesion.operador.rol)}</span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Salir" className={ITEM} onClick={() => void salir()}>
                <LogOut aria-hidden />
                <span>Salir</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      )}
      <SidebarRail />
    </Sidebar>
  );
}

export function AppLayout() {
  const [dialogoPin, setDialogoPin] = useState(false);
  const { oscuro, alternar } = useTema();
  const { pathname } = useLocation();
  const toast = useToast();
  const { sesion, puede, elegirSucursal } = useSesion();

  if (!sesion) return null;

  const actual = MENU.flatMap((g) => g.items)
    .filter((i) => puede(i.permiso))
    .find((i) => (i.ruta === '/' ? pathname === '/' : pathname.startsWith(i.ruta)));

  return (
    <SidebarProvider defaultOpen={menuAbierto()}>
      <MenuLateral alMiPin={() => setDialogoPin(true)} />
      <SidebarInset>
        <header className={css.barra}>
          <SidebarTrigger className="-ml-1" aria-label="Mostrar u ocultar el menú (Ctrl+B)" />
          <div className={css.migas}>
            {sesion.sucursales.length > 1 && !sesion.dispositivo ? (
              <Selector
                aria-label="Sucursal activa"
                className="h-8 min-w-0 border-0 bg-transparent px-2 shadow-none"
                value={String(sesion.sucursalActiva?.id ?? '')}
                onChange={(e) => elegirSucursal(Number(e.target.value)).catch((err) => toast(mensajeError(err), 'error'))}
                opciones={sesion.sucursales.map((s) => ({ valor: String(s.id), texto: s.nombre }))}
              />
            ) : (
              <span>{sesion.sucursalActiva?.nombre ?? 'Sin sucursal'}</span>
            )}
            <span aria-hidden>·</span>
            <strong>{actual?.texto ?? 'Inicio'}</strong>
          </div>
          <div className={css.espaciador} />
          <EstadoSistema />
          <Button variant="ghost" size="icon" onClick={alternar} aria-label={oscuro ? 'Tema claro' : 'Tema oscuro'}>
            {oscuro ? <Sun /> : <Moon />}
          </Button>
        </header>
        <main className={css.contenido}>
          <AvisoPausa />
          <Outlet />
        </main>
      </SidebarInset>
      <MiPinDialogo abierto={dialogoPin} alCerrar={() => setDialogoPin(false)} />
    </SidebarProvider>
  );
}
