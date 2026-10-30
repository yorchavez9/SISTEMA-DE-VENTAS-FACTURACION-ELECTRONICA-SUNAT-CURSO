// La misma fuente que ferretería: IBM Plex Sans variable (pesos 100–700).
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import './styles/globals.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { router } from './app/router';
import { ErrorGeneral } from './components/ErrorGeneral';
import { ProveedorToasts } from './components/ui';
import { ProveedorSesion } from './lib/sesion';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false } },
});

const raiz = document.getElementById('root');
if (!raiz) throw new Error('No existe #root');

createRoot(raiz).render(
  <StrictMode>
    <ErrorGeneral>
    <QueryClientProvider client={queryClient}>
      <ProveedorToasts>
        <ProveedorSesion>
          <RouterProvider router={router} />
        </ProveedorSesion>
      </ProveedorToasts>
    </QueryClientProvider>
    </ErrorGeneral>
  </StrictMode>,
);
