# Manual de operación

Para quien instala, mantiene y vigila el sistema. El manual de uso diario está en
[05-manual-usuario.md](05-manual-usuario.md).

## 0. Piezas

| Pieza | Qué hace | Cómo se ejecuta |
|---|---|---|
| **api** (`apps/api/dist/server.js`) | API interna y, con `SERVIR_WEB=true`, también las pantallas | Un proceso, en `127.0.0.1:4000` |
| **worker** (`apps/api/dist/worker.js`) | Envía comprobantes, guías, resúmenes y anulaciones a API-PRO; reconcilia; resumen diario automático; alerta de atascados | **Un solo proceso** por base de datos |
| **MySQL 8** | Toda la información (incluida la cola de envíos) | Servicio de Laragon o de Windows |
| **Apache** | HTTPS hacia la api | Laragon, plantilla en `deploy/apache/` |

Si el worker se detiene, **las ventas siguen registrándose**: los comprobantes quedan pendientes y se
envían cuando vuelve.

## 1. Instalación en el servidor

1. Node.js 22 LTS, MySQL 8.4 y Apache (Laragon los incluye).
2. Copiar el proyecto y, en la raíz: `npm ci`.
3. Crear el usuario de MySQL propio del sistema (ver `deploy/env.produccion.example`).
4. `apps/api/.env` a partir de `deploy/env.produccion.example`:
   - claves **nuevas**, distintas a las de desarrollo:
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
   - la api **no arranca** en producción si `WEB_ORIGIN` no es `https://`, si `DB_USER` es `root`, sin
     contraseña o con una base `*_test`.
5. `npm run build` (compila shared, api y web).
6. `npm run db:migrate` y `npm run db:seed`.
7. Inicia la api y abre el sistema en el navegador. Si la base no tiene usuarios, aparece
   **Configuración inicial** para registrar al super administrador (una sola vez).
   - En producción pide un **código de instalación** que la api escribe en su log al arrancar
     (`pm2 logs ventas-api`).
   - Alternativa por consola: `npm run usuarios:crear-admin -w @sv/api`, que genera una contraseña temporal
     que se cambia al primer ingreso.

## 2. Servicios (api y worker)

**Opción A: PM2** (recomendada)

```
npm install -g pm2 pm2-windows-startup
pm2-startup install
pm2 start deploy/ecosystem.config.cjs
pm2 save
```

Comandos: `pm2 status`, `pm2 logs ventas-worker`, `pm2 restart ventas-api`.

**Opción B: servicio de Windows con NSSM.** Un servicio por proceso, con *Application* = `node.exe`,
*Arguments* = `dist\server.js` (o `dist\worker.js`), *Startup directory* = `apps\api` y la variable
`NODE_ENV=production`. En la pestaña *I/O*, la salida va a `apps\api\storage\logs\`. En *Rotation*,
activar la rotación por tamaño (20 MB).

**Actualizar una versión:** respaldo → detener api y worker → copiar el código → `npm ci` →
`npm run build` → `npm run db:migrate` → iniciar. Las pantallas se ven nuevas al recargar el navegador
(`index.html` nunca se guarda en caché).

## 3. HTTPS

1. Copiar `deploy/apache/sistema-ventas.conf` a `C:\laragon\etc\apache2\sites-enabled\`.
2. Reemplazar el nombre del sitio y las rutas del certificado. El nombre debe ser el mismo que `WEB_ORIGIN`.
3. Activar `mod_ssl`, `mod_proxy`, `mod_proxy_http`, `mod_headers` y `mod_rewrite`, y reiniciar Apache.
4. Comprobar `https://<sitio>/api/health` → `{"estado":"ok","baseDatos":"ok"}`.

No abras el puerto 4000 en el firewall: la api solo escucha en `127.0.0.1`.

## 4. Respaldos

| Comando (`-w @sv/api`) | Qué hace |
|---|---|
| `npm run respaldo` | `mysqldump --single-transaction` comprimido en `RESPALDO_DIR` (por defecto `apps/api/storage/respaldos`); borra los de más de `RESPALDO_DIAS` días |
| `npm run respaldo:probar` | Restaura el último respaldo en `<base>_restauracion`, compara el número de filas de ventas, pagos, comprobantes, caja, stock, cuentas por cobrar, guías y auditoría, y borra la base temporal |

Programación: `deploy/windows/registrar-tareas.ps1` (como administrador) registra el respaldo diario a las
23:45 y la prueba de restauración los domingos a las 03:00. Las salidas quedan en
`apps/api/storage/logs/respaldo.log` y `respaldo:probar.log`.

**Copia fuera del servidor:** deja `RESPALDO_DIR` en otro disco o en una carpeta sincronizada (OneDrive,
NAS). Un respaldo en el mismo disco no protege contra la pérdida del disco.

**Restaurar de verdad** (desastre): detener api y worker →
`mysql -u … sistema_ventas < respaldo.sql` (descomprimido) → `npm run db:migrate` → iniciar.
Después, en Comprobantes → "Solo los que requieren atención", usa "Consultar a SUNAT" en los que estaban
en curso. API-PRO conserva el estado real y las claves de idempotencia evitan duplicados.

Los PDF, XML y CDR en caché (`apps/api/storage/cpe`) no hace falta respaldarlos: se vuelven a descargar
de API-PRO.

Las **imágenes de los productos** (`apps/api/storage/productos`) **sí**: no están en MySQL ni en API-PRO.
Inclúyelas en la copia fuera del servidor (son pocas y pesan poco: se reducen a 800 px al subirlas). Si se
pierden, los productos siguen funcionando sin foto.

## 5. Secretos

| Secreto | Dónde | Rotación |
|---|---|---|
| `APP_ENC_KEY` | `.env` | Genera una nueva → detén api y worker → `NUEVA_APP_ENC_KEY=<nueva> npm run secretos:rotar -w @sv/api` → reemplázala en `.env` → inicia. Se hace en una transacción: si falla, todo queda como estaba |
| Credenciales de API-PRO | BD, cifradas | Regéneralas en el panel de API-PRO y regístralas en Configuración → Empresa y conexión (prueba la conexión antes de guardar) |
| Contraseña de MySQL | `.env` | `ALTER USER` → actualiza `.env` → reinicia |
| Contraseñas y PIN de usuarios | BD (argon2) | El administrador los restablece desde Configuración → Usuarios |

**Pendiente de seguridad:** la colección de Postman del proyecto tiene las credenciales de API-PRO en
texto plano (está excluida de git). **Rota esas credenciales** antes de producción.

## 6. Monitoreo y alertas

- **`GET /api/health`**: para un monitor externo (cada minuto). 503 = sin base de datos.
- **Chip del encabezado**: estado de API-PRO y de la emisión. **Franja "Emisión pausada"**: credenciales,
  licencia o cupo de API-PRO. Se reintenta solo cada 15 minutos; "Reanudar ahora" adelanta la cola.
- **Franja "Requiere revisión"** (alerta de atascados), y el worker deja una línea `warn` en su log cada
  15 minutos mientras dure:
  - comprobantes o guías sin avanzar más de `alertas.comprobante_atascado_min` minutos (Configuración →
    Ajustes, por defecto 30);
  - boletas de días anteriores sin resumen diario. SUNAT da un plazo corto: envíalas desde Resumen diario;
  - tareas del worker fallidas en la última semana.
- **Reportes → Envíos a API-PRO**: cada llamada, con su HTTP y su error ("Solo errores").
- **Reportes → Auditoría**: quién hizo qué (ventas, anulaciones, cambios de configuración).

**Logs:** con PM2 se rotan con `pm2-logrotate` (20 MB, 30 archivos, comprimidos); con NSSM, con su
rotación por tamaño. Los logs nunca contienen contraseñas, PIN, cookies ni credenciales de API-PRO
(se ocultan antes de escribir).

## 7. Paso de beta a producción en API-PRO (checklist)

Hazlo con el sistema en **modo simulación** hasta el último paso.

- [ ] Licencia de API-PRO vigente y plan con cupo suficiente (`Configuración → Empresa y conexión → Probar conexión`
      muestra el límite de solicitudes por minuto).
- [ ] **Certificado digital** vigente cargado en API-PRO y usuario SOL secundario con permisos de emisión.
      Revisa la fecha de vencimiento del certificado y anótala.
- [ ] `client_id` y `client_secret` de SUNAT (API REST de guías) registrados en API-PRO, si se emitirán guías.
- [ ] Empresa en API-PRO con `entorno: production` (lo cambia quien administra API-PRO; este sistema no lo hace).
- [ ] **Series propias** del sistema creadas por sucursal (p. ej. F101/B101, FC11/BC11, FD11/BD11, T101),
      desde Configuración → Series, con las advertencias del sistema. No reutilices F001/B001 ni las de
      otros sistemas del mismo RUC.
- [ ] Cada sucursal vinculada a su establecimiento de API-PRO (código de local), con dirección y ubigeo.
- [ ] Credenciales de API-PRO **rotadas** (ver §5) y registradas en Configuración → Empresa y conexión.
- [ ] Respaldo probado (`npm run respaldo` y `npm run respaldo:probar`).
- [ ] Usuarios reales creados, PIN asignados y dispositivos POS registrados; usuarios de prueba desactivados.
- [ ] Modo de boletas por sucursal decidido: individual (recomendado) o resumen diario.
- [ ] Cambiar `Configuración → Empresa y conexión → Modo de emisión` a **real**.
- [ ] **Primer comprobante real:** una boleta de monto bajo. Espera a ver **Aceptado** en Comprobantes y
      descarga el PDF y el CDR. Luego una factura. Si algo sale rechazado, vuelve a modo simulación y revisa
      Reportes → Envíos a API-PRO.

Riesgos conocidos: la licencia de API-PRO o el certificado vencidos **pausan la emisión** (franja roja).
Las ventas siguen y los comprobantes salen al resolverlo, dentro del plazo de SUNAT.

## 8. Incidencias frecuentes

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| Franja roja "Emisión pausada" | Credenciales, licencia o cupo de API-PRO | Resolver en API-PRO → "Reanudar ahora" |
| Comprobante "Por verificar" mucho tiempo | API-PRO no respondió y se reintenta con la misma clave | Esperar; si persiste, "Reintentar" (no duplica) |
| "Sin respuesta" (comprobante o guía) | SUNAT no resolvió el ticket a tiempo | "Consultar a SUNAT" más tarde |
| Boletas "Para el resumen" de ayer | El worker estuvo detenido a la hora del resumen | Resumen diario → Enviar |
| La api no arranca: "Configuración insegura" | `.env` de producción incompleto | Corregir lo que indica el mensaje |
| La api no arranca: "Configuración inválida" | Falta una variable o tiene un formato incorrecto | El mensaje nombra la variable (nunca muestra su valor) |
| Cierre de caja con diferencia | Conteo o movimientos sin registrar | Reportes → Cierres de caja y Movimientos por medio de pago |

## 9. Pruebas

`npm test` (unitarias e integración, sobre `sistema_ventas_test`), `npm run test:cobertura -w @sv/api`
(umbral del 80 % en impuestos, inventario, ventas, facturación y guías) y `npm run test:rendimiento -w @sv/api`
(100 000 ventas). Las pruebas **nunca** usan la base real ni la API-PRO real: usan una API-PRO simulada.
