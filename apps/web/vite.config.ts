import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Alias de shadcn/ui: @/components/ui/button, @/lib/utils…
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    // Una sola copia de React en el monorepo (dos copias rompen los hooks: "Invalid hook call").
    dedupe: ['react', 'react-dom'],
  },
  build: {
    rolldownOptions: {
      output: {
        // Librerías en paquetes propios: cambian poco y el navegador las mantiene en caché entre
        // versiones de la app (solo se vuelve a descargar el código del sistema).
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler|react-router|@tanstack)[\\/]/ },
            { name: 'shadcn', test: /node_modules[\\/](radix-ui|@radix-ui|sonner|cmdk|tailwind-merge|clsx|class-variance-authority|lucide-react)[\\/]/ },
            { name: 'validacion', test: /node_modules[\\/](zod|decimal\.js)[\\/]|packages[\\/]shared[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // La SPA y la API comparten origen: /api se reenvía al backend.
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: false },
    },
  },
});
