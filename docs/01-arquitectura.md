# 01 · Arquitectura del sistema

Estado: **propuesta para aprobación** (fase 2, paso 1). Este documento se basa en `00-plan-implementacion.md` (§0 y §7).

---

## 1. Vista general

```
┌──────────────────────────┐  HTTPS · JSON · cookie de sesión (httpOnly) + X-CSRF-Token
│  apps/web (React + TS)   │──────────────────────────────────────────┐
│  SPA, una por sucursal   │                                          ▼
└──────────────────────────┘                          ┌────────────────────────────────┐
                                                      │ apps/api (Express + TS)        │
                                                      │ módulos por dominio            │
                                                      │ routes → controller → service  │
                                                      │        → repository (Knex)     │
                                                      └──────┬──────────────┬──────────┘
                                         transacciones ACID  │              │ proxy PDF/XML/CDR
                                                             ▼              │ (caché en archivos_cpe)
                                                ┌───────────────────────┐   │
                                                │ MySQL 8 (InnoDB)      │   │
                                                │ incluye outbox_trabajos│  │
                                                └──────────┬────────────┘   │
                                    SELECT … FOR UPDATE    │                │
                                    SKIP LOCKED            ▼                │
                                                ┌───────────────────────┐   │
                                                │ apps/api worker       │   │
                                                │ (mismo código, otro   │   │
                                                │  proceso)             │   │
                                                └──────────┬────────────┘   │
                                X-Api-Key / X-Api-Secret   │                │
                                Idempotency-Key            ▼                ▼
                                                ┌──────────────────────────────────┐
                                                │ API-PRO https://sunat.kodevo.es  │──► SUNAT
                                                │ /api/v1 (no se modifica)         │
                                                └──────────────────────────────────┘
```

**Principios**
1. **El POS nunca depende de SUNAT.** La venta se confirma en MySQL; la emisión es asíncrona.
2. **Una sola fuente de verdad por dato:**
   - MySQL local para ventas, stock, caja y cartera;
   - API-PRO para la numeración, el XML, el CDR y el estado tributario.
3. **Solo el backend conoce las credenciales de API-PRO.**
4. **Ningún efecto se aplica dos veces:** índices únicos por origen, claves de idempotencia y UPDATE condicionales.
5. **Los documentos emitidos no se editan ni se borran:** se compensan con notas, bajas o resúmenes.

---

## 2. Registro de decisiones (ADR)

| # | Decisión | Alternativas descartadas | Motivo |
|---|---|---|---|
| ADR-01 | **TypeScript** en web, api y shared | JavaScript | Lo decidió el usuario. Contratos tipados y lógica tributaria más segura |
| ADR-02 | **Monorepo npm workspaces**: `apps/web`, `apps/api`, `packages/shared` | Repos separados | Esquemas zod y enums compartidos sin publicar paquetes |
| ADR-03 | **React 18 + Vite**, React Router 6, TanStack Query, react-hook-form + zod, TanStack Table, lucide-react, Recharts | Next.js; Redux | SPA interna, sin SEO; la caché de servidor la cubre Query; el estado local es mínimo |
| ADR-04 | **CSS con tokens** (variables) + CSS Modules, tokens portados de ferretería | Tailwind, MUI | Fidelidad exacta a la identidad visual de referencia y sin dependencia de un kit |
| ADR-05 | **Express 4** + helmet, cors, express-rate-limit, pino, zod | NestJS, Fastify | Es lo que pide el prompt; equipo pequeño; la modularidad se logra por convención |
| ADR-06 | **Knex + mysql2** para migraciones y consultas | Prisma, TypeORM | Control explícito de `FOR UPDATE`, `SKIP LOCKED` y transacciones; migraciones maduras |
| ADR-07 | **MySQL 8.0+** obligatorio | 5.7 / MariaDB | `SKIP LOCKED`, `CHECK`, JSON y columnas generadas |
| ADR-08 | **Sesión de servidor en MySQL** con una cookie `httpOnly; Secure; SameSite=Strict` + CSRF de doble envío | JWT en localStorage | Revocación inmediata (desactivar a un cajero), sin exposición del token a XSS |
| ADR-09 | **Login con usuario y contraseña (argon2id) + PIN rápido en el POS** en dispositivos registrados | Solo PIN | Lo decidió el usuario. El PIN cambia el operador del turno y autoriza acciones de supervisor |
| ADR-10 | **Patrón outbox en MySQL + worker en un proceso aparte** | BullMQ/Redis; emitir dentro de la petición | Sin infraestructura extra; atómico con la venta; reintentos persistentes |
| ADR-11 | **Adaptador `integrations/apiPro`** como único punto de contacto con API-PRO, con un **simulador** intercambiable | Llamadas dispersas; usar el SDK de API-PRO directamente | Aísla los bugs conocidos (B1, B2, B4, B7, B8, B11), normaliza las respuestas, permite probar sin la red. El SDK `API-PRO/sdk/ts` sirve como referencia de tipos |
| ADR-12 | **Dinero: `DECIMAL` en BD y `decimal.js` en el código** (nunca `number` para importes) | Céntimos enteros (ferretería) | Hay precios con 6 decimales y conversión de moneda; decimal.js evita errores sin perder precisión |
| ADR-13 | **Fechas en UTC (`DATETIME`)**; la fecha tributaria (`fecha_emision DATE`) se calcula en `America/Lima` | DATETIME en hora local | Servidores y backups portables; SUNAT usa la hora de Perú |
| ADR-14 | **Secretos cifrados con AES-256-GCM** (clave maestra en `.env`) | Texto plano; libsodium | Viene en `node:crypto` sin dependencias nativas |
| ADR-15 | **Las series de API-PRO las crea y actualiza el sistema**, con advertencias; las externas, solo lectura | Gestión manual en el panel | Lo decidió el usuario; las reglas de bloqueo están en el plan §0.10-c |
| ADR-16 | **Resumen diario solo con boletas propias** mediante comprobación previa y posterior | Confiar en la API | La API no filtra por serie (verificado) y no se modifica |
| ADR-17 | **Presupuesto de llamadas a API-PRO**: un token bucket de 25 req/min (de 30) en el worker, compartido entre emisión, polling y descargas | Sin control | Rate limit real verificado: 30 req/min |
| ADR-18 | **Stock sin negativos**: validación con `FOR UPDATE` + `CHECK (cantidad >= 0)` | Permitir y alertar | Lo decidió el usuario |

**Supuestos por defecto, cambiables** (pendientes del plan §0.9):
- **S-1:** el tipo de cambio se ingresa a mano cada día.
- **S-2:** el producto tiene un precio en USD opcional; sin él, se convierte desde PEN.
- **S-3:** límite de crédito opcional por cliente y bloqueo si tiene cuotas vencidas, como interruptor de configuración.
- **S-4:** sin detracción en el MVP.

---

## 3. Estructura del repositorio

```
sistemas-ventas-curso/
├─ apps/
│  ├─ web/
│  │  ├─ index.html
│  │  └─ src/
│  │     ├─ main.tsx
│  │     ├─ app/            router.tsx, providers.tsx, guards (RequireAuth, RequirePermission)
│  │     ├─ layouts/        AppLayout (Sidebar, Topbar), AuthLayout, PosLayout
│  │     ├─ components/ui/  Button, IconButton, Field, Input, MoneyInput, Select, Dialog,
│  │     │                  ConfirmDialog, TypedConfirm, Toaster, DataTable, StatusChip,
│  │     │                  KpiCard, Tabs, EmptyState, Banner, PinPad, DateRange
│  │     ├─ features/       auth, dashboard, branches, users, settings, series, catalog,
│  │     │                  customers, suppliers, purchases, inventory, pos, cash,
│  │     │                  receivables, documents, notes, voids, summaries, dispatch, reports, audit
│  │     │   └─ <feature>/  pages/*.tsx, components/*.tsx, api.ts, hooks.ts
│  │     ├─ lib/            http.ts, money.ts, dates.ts, cpe.ts, permissions.ts, print.ts
│  │     └─ styles/         tokens.css, base.css, print.css
│  └─ api/
│     ├─ .env.example       (sin valores reales; .env está en .gitignore)
│     └─ src/
│        ├─ server.ts       arranque HTTP
│        ├─ worker.ts       arranque del worker (outbox y jobs programados)
│        ├─ app.ts          ensamblado de Express (middlewares y routers)
│        ├─ config/         env.ts (zod), logger.ts
│        ├─ database/       knexfile.ts, db.ts, migrations/, seeds/
│        ├─ middlewares/    session, csrf, requireAuth, requirePermission, branchContext,
│        │                  validate, rateLimit, errorHandler, requestId
│        ├─ integrations/apiPro/
│        │                  client.ts, simulator.ts, budget.ts (token bucket), mappers.ts,
│        │                  errors.ts, guards.ts, types.ts
│        ├─ modules/<modulo>/  *.routes.ts, *.controller.ts, *.service.ts, *.repository.ts, *.schemas.ts
│        ├─ jobs/           emitirComprobante, reconciliarEstados, enviarResumenDiario,
│        │                  reconciliarResumen, reconciliarBaja, reconciliarGuia, alertasAtascados
│        └─ shared/         money.ts, tax.ts, crypto.ts, errors.ts, dates.ts, idempotency.ts
├─ packages/shared/src/      schemas/*.ts (zod), enums.ts, catalogos.ts, dto.ts
├─ docs/
└─ package.json              workspaces + scripts (dev, build, test, lint, db:migrate)
```

**Módulos del backend** (`apps/api/src/modules`):
- `auth`, `users`, `roles`, `branches`, `devices`, `settings`, `series`, `exchange-rates`;
- `catalog` (categorías, unidades, productos), `customers`, `suppliers`, `purchases`, `inventory`;
- `cash`, `sales`, `receivables`;
- `invoicing` (comprobantes, emisión, reconciliación, archivos), `notes` (NC y ND), `voids` (RA), `summaries` (RC de envío y de anulación), `dispatch` (guía 09);
- `reports`, `dashboard`, `audit`.

**Regla de dependencias:**
- un módulo solo llama a otro a través de su `service` (nunca al repository ajeno);
- `invoicing`, `notes`, `voids`, `summaries` y `dispatch` son los únicos que importan `integrations/apiPro`;
- `inventory.service` y `cash.service` exponen funciones que **reciben la transacción (`trx`)** del llamador.

---

## 4. Comunicación entre capas

### 4.1 Web → API interna
- Base `/api`, JSON, **sesión por cookie**. El frontend envía `X-CSRF-Token` en los métodos de escritura y `X-Sucursal-Id` (la sucursal activa, validada contra las sucursales del usuario).
- **Formato de error único:**
  ```json
  { "error": "mensaje legible", "codigo": "STOCK_INSUFICIENTE", "campos": { "items.0.cantidad": "Solo hay 3" }, "requestId": "..." }
  ```
- **Paginación única:** `?page=1&pageSize=25&q=&sort=campo:asc` → `{ data: [...], page, pageSize, total }`.
- **Idempotencia en las escrituras críticas** (ventas, cobros, compras, notas, anulaciones): cabecera `Idempotency-Key` generada en el navegador. El backend la guarda en un índice único de la tabla de origen.

### 4.2 API interna → MySQL
- Pool `mysql2` con `timezone: 'Z'` y `dateStrings` para DATE.
- Toda operación con efectos usa `db.transaction(async trx => …)`, con un orden de bloqueo fijo (stock por producto_id ascendente) para evitar deadlocks.
- **Reintento automático solo ante deadlock** (`ER_LOCK_DEADLOCK`), hasta 3 veces.

### 4.3 Worker → API-PRO
- El worker ejecuta en bucle:
  1. `SELECT … FROM outbox_trabajos WHERE estado='pendiente' AND ejecutar_en<=NOW() ORDER BY prioridad, id LIMIT n FOR UPDATE SKIP LOCKED`;
  2. marca `en_proceso` con `bloqueado_hasta`;
  3. ejecuta el job;
  4. lo deja `hecho`, o lo reprograma con backoff.
- **Jobs programados** (por cron interno):
  - reconciliación de los comprobantes en curso;
  - resumen diario por sucursal a la hora configurada;
  - alertas de documentos atascados;
  - limpieza de sesiones.
- **Cliente HTTP:** `fetch` nativo de Node 20 con `AbortController`, 10 s de conexión y 30 s en total.
- **Cabeceras:** `Accept`, `Content-Type`, `X-Api-Key`, `X-Api-Secret` e `Idempotency-Key` (solo en POST y PUT).
- **Registro:** cada llamada queda en `integracion_intentos`, sin secretos y con el cuerpo de la respuesta, truncado si es binario.

### 4.4 Mapeo de errores de API-PRO → acción del worker

| Respuesta | Acción |
|---|---|
| 200/201 | Aplicar el resultado |
| 401 | **Pausar toda la cola** de la empresa y alertar ("credenciales inválidas") |
| 403 `codigo_error` de licencia o suscripción | Pausar la cola y alertar |
| 404 | Error de lógica: registrarlo y marcar el trabajo `fallido` |
| 409 | Reintentar en 10–30 s (idempotencia en curso) |
| 422 | Documento `error_validacion` con `errores`; **no reintentar** |
| 429 `limit_reached` | Pausar la emisión, alertar "cupo de la API alcanzado"; se reanuda a mano o cada 15 min |
| 429 throttle | Respetar `Retry-After` y reducir el presupuesto |
| 5xx / timeout / red | `por_verificar` y reintento con **la misma** Idempotency-Key, con backoff 30 s → 2 min → 10 min → 30 min → 2 h |

### 4.5 Guardas obligatorias del adaptador (bugs de API-PRO)
- **B1:** prohibido llamar a `GET /anulaciones/{id}/estado` y a `GET /guias-remision/{id}/estado`; se usa `GET /{recurso}/{id}`.
- **B2:** `POST /{doc}/{id}/enviar|reenviar` solo después de leer el estado remoto y confirmar `pendiente` o `rechazado`.
- **B4:** prohibido `POST /consultar-cdr`; se usa `GET /consultar-cpe` (`fecha_emision` dd/mm/aaaa, `monto`).
- **B7:** el payload nunca incluye totales ni montos calculados.
- **B8:** `PUT` solo sobre `rechazado` o `pendiente`, con el payload completo construido desde las instantáneas.
- **B9 y seguridad:** solo `/api/v1`. Prohibidos `/api/sunat/*` y `DELETE /empresa`.
- **PDF:** siempre `?format=` (nunca `formato`).
- **Resumen:** comprobación previa de las boletas pendientes ajenas (ADR-16).

---

## 5. Seguridad (resumen operativo)

| Área | Medida |
|---|---|
| Credenciales de API-PRO | En desarrollo, `apps/api/.env` (`APIPRO_BASE_URL`, `APIPRO_KEY`, `APIPRO_SECRET`). En producción, cifradas en la tabla `empresa` con AES-256-GCM (`APP_ENC_KEY` en `.env`). Nunca se devuelven al frontend (solo `••••` + los últimos 4) ni van a los logs |
| Contraseñas y PIN | argon2id; bloqueo progresivo; PIN solo en dispositivos registrados |
| Sesión | Cookie `sid` httpOnly, Secure, SameSite=Strict; expiración por inactividad configurable; revocable |
| CSRF | Token en la sesión, enviado en `X-CSRF-Token` |
| Autorización | `requirePermission('ventas.crear')` en cada ruta, más una comprobación de la sucursal permitida |
| Entrada | zod en cada endpoint (body, query, params); consultas parametrizadas de Knex; nunca SQL concatenado con datos |
| XSS | React escapa por defecto; prohibido `dangerouslySetInnerHTML`; CSP con helmet |
| Abuso | Rate limit en el login, el PIN y la búsqueda de documentos |
| Logs | pino con `redact` (`*.secret`, `*.password`, `*.pin`, `authorization`, `x-api-secret`) |
| Archivos | Los PDF, XML y CDR solo se sirven a través del backend con permiso; caché en disco privado |
| Respaldos | mysqldump diario con retención y una prueba de restauración mensual |

---

## 6. Convenciones de código
- **Nombres:**
  - en el código, inglés para la técnica (`service`, `repository`) y **español para el dominio** (`venta`, `comprobante`, `cuota`), igual que la API y la normativa;
  - tablas y columnas en `snake_case` español.
- **Rutas REST internas** en español: `/api/ventas`, `/api/comprobantes/:id/pdf`.
- **Validación:** los esquemas zod viven en `packages/shared` y se usan en el formulario y en el backend.
- **Pruebas:** Vitest (unitarias), Supertest (integración con la BD de prueba en Docker o en el MySQL de Laragon con otra base) y Playwright (E2E).
- **Commits** convencionales; ramas por fase.
