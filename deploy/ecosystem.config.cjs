// PM2: api y worker como procesos de producción (manual de operación §2).
//   npm install -g pm2 pm2-windows-startup && pm2-startup install
//   npm run build            (en la raíz del proyecto)
//   pm2 start deploy/ecosystem.config.cjs && pm2 save
//   pm2 install pm2-logrotate                      (rotación de logs, ver abajo)
//   pm2 set pm2-logrotate:max_size 20M
//   pm2 set pm2-logrotate:retain 30
//   pm2 set pm2-logrotate:compress true
// La configuración (BD, claves, API-PRO) se lee de apps/api/.env; aquí solo va lo del proceso.
const path = require('node:path');

const api = path.join(__dirname, '..', 'apps', 'api');
const logs = path.join(api, 'storage', 'logs');

module.exports = {
  apps: [
    {
      name: 'ventas-api',
      cwd: api,
      script: 'dist/server.js',
      // Un solo proceso: las sesiones y el presupuesto de API-PRO viven en MySQL, pero el
      // limitador de solicitudes por IP es en memoria.
      instances: 1,
      env: { NODE_ENV: 'production', SERVIR_WEB: 'true' },
      out_file: path.join(logs, 'api.log'),
      error_file: path.join(logs, 'api.error.log'),
      merge_logs: true,
      time: true,
      max_memory_restart: '512M',
      kill_timeout: 10_000,
    },
    {
      name: 'ventas-worker',
      cwd: api,
      script: 'dist/worker.js',
      // Debe haber UN solo worker por base de datos (el envío programado del resumen diario se
      // ejecuta en cada worker; el outbox usa SKIP LOCKED, pero no conviene duplicarlo).
      instances: 1,
      env: { NODE_ENV: 'production' },
      out_file: path.join(logs, 'worker.log'),
      error_file: path.join(logs, 'worker.error.log'),
      merge_logs: true,
      time: true,
      max_memory_restart: '384M',
      // Señal SIGINT: el worker termina el lote en curso antes de salir.
      kill_timeout: 30_000,
    },
  ],
};
