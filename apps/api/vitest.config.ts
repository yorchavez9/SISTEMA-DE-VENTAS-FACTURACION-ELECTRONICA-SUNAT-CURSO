import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Base de datos propia de las pruebas: nunca se toca sistema_ventas.
    env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', DB_NAME: 'sistema_ventas_test' },
    // Las pruebas de integración comparten la misma base: se ejecutan en serie.
    fileParallelism: false,
    // `npm run test:cobertura`. Umbral del plan (fase 9): >80 % en impuestos, inventario, ventas y facturación.
    coverage: {
      provider: 'v8',
      allowExternal: true,
      include: ['src/**/*.ts', '../../packages/shared/dist/calculo/**/*.js'],
      exclude: ['src/test/**', '**/*.test.ts', '**/*.d.ts', 'src/server.ts', 'src/worker.ts', 'src/types/**'],
      reporter: ['text-summary', 'html'],
      thresholds: {
        'src/modules/inventario/**': { lines: 80 },
        'src/modules/ventas/**': { lines: 80 },
        'src/modules/facturacion/**': { lines: 80 },
        'src/modules/guias/**': { lines: 80 },
        '../../packages/shared/dist/calculo/**/*.js': { lines: 80 },
      },
    },
  },
});
