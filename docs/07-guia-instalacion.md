# Guía de instalación paso a paso

Sistema de ventas, inventario y facturación electrónica SUNAT (CMA STORE).
Esta guía va desde un equipo vacío hasta el sistema funcionando. La **parte A** es para una
computadora de desarrollo o pruebas; la **parte B**, para dejarlo en un servidor de producción.

> Ninguna clave real (API-PRO, json.pe, MIGO) va en este documento ni en git. Se escriben solo en
> `apps/api/.env` o en la pantalla de Configuración del sistema.

---

## Requisitos

| Programa | Versión | Para qué |
|---|---|---|
| **Node.js** | 20.11 o superior (recomendado 22 LTS) | api, worker y web |
| **MySQL** | 8.0 o superior (Laragon trae 8.4) | base de datos |
| **Laragon** (Windows) | Full | trae MySQL y Apache en un solo instalador |
| Navegador | Chrome, Edge o Firefox actuales | usar el sistema |

Comprueba Node en una terminal:

```bash
node -v   # v20.11.0 o mayor
npm -v
```

---

## Parte A · Instalación local (desarrollo o pruebas)

### Paso 1. Instalar Laragon y encender MySQL

1. Descarga e instala **Laragon Full** (queda en `C:\laragon`).
2. Abre Laragon y pulsa **Iniciar todo**. Debe verse MySQL en verde (puerto **3306**).
3. Por defecto el usuario de MySQL es `root` sin contraseña. Así sirve para desarrollo.

### Paso 2. Descargar el proyecto

Abre una terminal en `C:\laragon\www` y clona el repositorio:

```bash
cd C:\laragon\www
git clone https://github.com/yorchavez9/SISTEMA-DE-VENTAS-FACTURACION-ELECTRONICA-SUNAT-CURSO.git sistemas-ventas-curso
cd sistemas-ventas-curso
```

(Sin git: en GitHub, **Code → Download ZIP**, descomprímelo en `C:\laragon\www\sistemas-ventas-curso` y
abre una terminal en esa carpeta.)

### Paso 3. Instalar las dependencias

```bash
npm install
```

Instala las tres partes del monorepo de una vez: `packages/shared`, `apps/api` y `apps/web`.

### Paso 4. Crear el archivo de configuración `.env`

```bash
copy apps\api\.env.example apps\api\.env
```

(En Git Bash: `cp apps/api/.env.example apps/api/.env`.)

Abre `apps/api/.env` y completa:

| Variable | Qué poner |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` | Datos de MySQL. Con Laragon: `127.0.0.1`, `3306`, `root` y vacío |
| `DB_NAME` | `sistema_ventas` (se crea sola en el paso 5) |
| `APP_ENC_KEY` | Clave para cifrar secretos en la base. Genérala (abajo) |
| `SESSION_SECRET` | Texto aleatorio de 32 caracteres o más. Genéralo (abajo) |
| `APIPRO_BASE_URL` | `https://sunat.kodevo.es/api/v1` |
| `APIPRO_KEY`, `APIPRO_SECRET` | Opcional: también se pueden cargar después desde la pantalla de Configuración |

Genera las dos claves (cada comando da un valor distinto; copia cada uno en su variable):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # → APP_ENC_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"   # → SESSION_SECRET
```

> **Guarda `APP_ENC_KEY` en un lugar seguro.** Con ella se cifran las credenciales de API-PRO y los
> tokens de json.pe/MIGO; si se pierde, hay que volver a ingresarlos.

### Paso 5. Crear la base de datos

```bash
npm run db:migrate   # crea la base sistema_ventas y todas sus tablas
npm run db:seed      # roles, permisos, unidades, medios de pago y ajustes iniciales
```

Si sale `ER_ACCESS_DENIED` o `ECONNREFUSED`, revisa que MySQL esté encendido en Laragon y los datos
`DB_*` del `.env`.

### Paso 6. Levantar el sistema

```bash
npm run dev
```

Arranca tres procesos juntos:

| Proceso | Dirección | Qué hace |
|---|---|---|
| **web** | http://localhost:5173 | las pantallas (React) |
| **api** | http://localhost:4000 | el servidor; `http://localhost:4000/api/health` responde `ok` |
| **worker** | (sin puerto) | envía los comprobantes a SUNAT en segundo plano |

Abre **http://localhost:5173**. Para detener todo: **Ctrl + C** en la terminal.

> Si aparece que el puerto 4000 o 5173 está ocupado, el sistema ya está corriendo en otra terminal:
> ciérrala primero.

### Paso 7. Crear el super administrador (solo la primera vez)

Con la base vacía, el sistema muestra **Configuración inicial**:

1. Escribe tu nombre, un usuario y una contraseña (mínimo 8 caracteres, con letras y números).
2. Pulsa **Crear administrador e ingresar**. Esto solo se puede hacer una vez.

Alternativa por consola: `npm run usuarios:crear-admin -w @sv/api` (genera una contraseña temporal
que se cambia al primer ingreso).

### Paso 8. Configurar el sistema

Entra a **Configuración** y completa, en este orden:

1. **Empresa y conexión**
   - **Cambiar credenciales** de API-PRO (si no las pusiste en el `.env`) y **Probar conexión con
     API-PRO**: trae el RUC y la razón social de la empresa.
   - **Modo de emisión**: empieza en **simulación** (los comprobantes no van a SUNAT). Pásalo a
     **real** solo cuando tengas series propias en API-PRO y quieras emitir de verdad.
   - **Consulta de DNI y RUC** (opcional): pega el token de **json.pe** y/o **MIGO**, elige el
     principal, guarda y pulsa **Probar**. Si no configuras ninguno, se usa API-PRO.
2. **Sucursales**: créalas o **impórtalas** desde API-PRO.
3. **Series**: revisa las series de boleta (B…) y factura (F…) de cada sucursal.
4. **Usuarios**: crea cajeros y almaceneros y asígnales su sucursal. Cada uno crea su **PIN** al
   entrar (botón con su nombre, al pie del menú lateral) y desde entonces ingresa eligiéndose en la
   lista y escribiendo el PIN.
5. **Dispositivos de caja** (opcional): registra el navegador de cada caja.
6. **Tipo de cambio** y **Ajustes** (inactividad, mensaje del ticket, crédito).

Después: **Productos** (con su stock en **Inventario**) y **Caja → Abrir caja**. Ya puedes vender en
**Vender**.

### Paso 9 (opcional). Verificar con las pruebas

```bash
npm test
```

Usa una base aparte, `sistema_ventas_test`, que se borra y se crea en cada corrida: **nunca toca
`sistema_ventas`**. Tarda unos 5 minutos.

---

## Parte B · Instalación en un servidor (producción)

El detalle completo está en el [manual de operación](06-manual-operacion.md). Resumen:

### B1. Preparar el servidor

1. Instala **Node.js 22 LTS** y **Laragon** (MySQL 8.4 + Apache).
2. Copia el proyecto (por ejemplo, `C:\laragon\www\sistemas-ventas-curso`) y en la raíz:
   ```bash
   npm ci
   ```

### B2. Usuario propio de MySQL

En producción **no se usa `root`**. Crea un usuario solo para el sistema (desde HeidiSQL o la consola
de MySQL), con una contraseña fuerte:

```sql
CREATE USER 'ventas'@'localhost' IDENTIFIED BY 'una-contraseña-fuerte';
GRANT ALL PRIVILEGES ON sistema_ventas.* TO 'ventas'@'localhost';
FLUSH PRIVILEGES;
```

### B3. Archivo `.env` de producción

```bash
copy deploy\env.produccion.example apps\api\.env
```

Complétalo con:

- `NODE_ENV=production` y `SERVIR_WEB=true` (la api sirve también las pantallas).
- `WEB_ORIGIN=https://tu-dominio` (con **https**).
- `DB_USER=ventas` y su contraseña.
- `APP_ENC_KEY` y `SESSION_SECRET` **nuevas**, distintas a las de desarrollo.
- `RESPALDO_DIR` (carpeta de respaldos, idealmente en otro disco) y `MYSQL_BIN`.

La api **se niega a arrancar** si en producción `WEB_ORIGIN` no es https, el usuario es `root`, no hay
contraseña o la base termina en `_test`.

### B4. Compilar y crear la base

```bash
npm run build
npm run db:migrate
npm run db:seed
```

### B5. Dejar la api y el worker como servicios

Con **PM2** (recomendado):

```bash
npm install -g pm2 pm2-windows-startup
pm2-startup install
pm2 start deploy/ecosystem.config.cjs
pm2 save
```

Útiles: `pm2 status`, `pm2 logs ventas-api`, `pm2 restart ventas-api`.
(Alternativa: servicios de Windows con NSSM; ver el manual de operación §2.)

### B6. HTTPS con Apache

1. Copia `deploy/apache/sistema-ventas.conf` a `C:\laragon\etc\apache2\sites-enabled\`.
2. Cambia el nombre del sitio y las rutas del certificado (el mismo dominio que `WEB_ORIGIN`).
3. Activa `mod_ssl`, `mod_proxy`, `mod_proxy_http`, `mod_headers` y `mod_rewrite`; reinicia Apache.
4. Comprueba `https://tu-dominio/api/health` → `{"estado":"ok","baseDatos":"ok"}`.

No abras el puerto 4000 en el firewall: la api solo escucha en `127.0.0.1`.

### B7. Primer ingreso en producción

Abre `https://tu-dominio`. En **Configuración inicial** se pide además un **código de instalación**,
que la api escribe en su log al arrancar:

```bash
pm2 logs ventas-api
```

Luego sigue el **paso 8** de la parte A.

### B8. Tareas programadas (respaldos y alertas)

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\registrar-tareas.ps1
```

Registra el **respaldo diario** de MySQL (23:45) y la **prueba de restauración** semanal (domingo 03:00). Puedes lanzarlos a mano:
`npm run respaldo -w @sv/api` y `npm run respaldo:probar -w @sv/api`.

### Actualizar a una versión nueva

Respaldo → `pm2 stop all` → copiar el código nuevo → `npm ci` → `npm run build` →
`npm run db:migrate` → `pm2 start all`.

---

## Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| `ECONNREFUSED 127.0.0.1:3306` | MySQL apagado: **Iniciar todo** en Laragon |
| `ER_ACCESS_DENIED_ERROR` | Usuario o contraseña de MySQL incorrectos en `apps/api/.env` |
| `APP_ENC_KEY` / `SESSION_SECRET` inválida al arrancar | Falta generarlas (paso 4); `APP_ENC_KEY` debe ser de 32 bytes en base64 |
| `EADDRINUSE :4000` o `:5173` | El sistema ya corre en otra terminal: ciérrala o usa esa |
| La pantalla queda en blanco tras actualizar | Recarga con **Ctrl + F5**; si sigue, `npm install` y vuelve a `npm run dev` |
| "Invalid hook call" en la consola del navegador | Dependencias mezcladas: borra `node_modules` y `apps/web/node_modules/.vite`, luego `npm install` |
| No aparecen sucursales | Créalas o pulsa **Importar** en Configuración → Sucursales |
| Las ventas salen "Simulado" y sin PDF | Es el **modo simulación**: cámbialo a real en Configuración → Empresa cuando tengas series propias |
| La búsqueda de DNI/RUC no completa datos | Revisa el token en **Consulta de DNI y RUC** con **Probar**; si todos fallan, se puede escribir a mano |

---

## Comandos de referencia

| Comando | Qué hace |
|---|---|
| `npm run dev` | Levanta api, worker y web en desarrollo |
| `npm run build` | Compila todo para producción |
| `npm run db:migrate` · `npm run db:rollback` | Aplica · revierte migraciones |
| `npm run db:seed` | Carga roles, permisos y datos iniciales |
| `npm test` | Pruebas (base `sistema_ventas_test`) |
| `npm run typecheck` | Verifica tipos de todo el proyecto |
| `npm run apipro:probar -w @sv/api` | Prueba de solo lectura de la conexión con API-PRO |
| `npm run usuarios:crear-admin -w @sv/api` | Crea un administrador desde la consola |
| `npm run respaldo -w @sv/api` | Respaldo comprimido de MySQL |
| `npm run secretos:rotar -w @sv/api` | Cambia `APP_ENC_KEY` y vuelve a cifrar los secretos |

Más información: [manual de usuario](05-manual-usuario.md) · [manual de operación](06-manual-operacion.md).
