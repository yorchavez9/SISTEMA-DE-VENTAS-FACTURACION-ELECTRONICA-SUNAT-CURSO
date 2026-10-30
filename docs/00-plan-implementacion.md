# Informe de análisis y plan de implementación
## Sistema de ventas, inventario y facturación electrónica SUNAT (React + Node.js + MySQL)

Fecha: 2026-10-28 · Estado: **para revisión, no se ha creado ni modificado nada en los proyectos**.

**Leyenda de confiabilidad**
- **[V]** Verificado leyendo el código o el archivo.
- **[I]** Inferido del código; hay que validarlo en el entorno beta.
- **[R]** Recomendación propia.
- **[P]** Pendiente de confirmar por ti.

Informes de detalle de cada fuente (en la carpeta temporal de la sesión):
- `analisis-api-pro.md`: contrato completo de API-PRO, con rutas de archivo y líneas.
- `analisis-postman.md`: inventario de las 317 solicitudes de la colección.
- `analisis-ferreteria.md`: diseño (tokens exactos), pantallas, esquema e integración.

---

## 0. Actualización (28-10-2026): decisiones confirmadas y verificación de credenciales

### 0.1 Decisiones del usuario
| Tema | Decisión |
|---|---|
| API | `https://sunat.kodevo.es/api/v1` (la instancia publicada), empresa **COMPANY CMA SAC**, RUC 20161515648 |
| Credenciales | Par X-Api-Key / X-Api-Secret entregado por el usuario. **Solo vivirá en `apps/api/.env`** (ignorado por git) y, en producción, cifrado en la BD. Nunca en el código, la documentación ni el frontend |
| Sucursales | **Varias sucursales desde el MVP** |
| Boletas | **Dos modos configurables**: envío individual y envío por resumen diario (RC) |
| Alcance MVP ampliado | Notas de crédito, **notas de débito**, **guía de remisión remitente (09)**, **comunicación de baja (RA)** y **anulación de boletas por RC** |
| Sistemas de referencia | **No se modifican** API-PRO ni ferretería. Los bugs de API-PRO se rodean desde el adaptador del nuevo sistema |

### 0.2 Verificación de las credenciales (solo lecturas GET, sin modificar nada) [V]
- `GET /empresa` → 200. Empresa activa, **entorno `beta`**, régimen `mype`, `tasa_igv_vigente` 18, certificado cargado, Clave SOL cargada, `client_id` y `client_secret` GRE cargados (necesarios para la guía 09), sin webhook.
- `GET /sunat/estado` → SUNAT disponible, circuito cerrado, entorno beta.
- `GET /sucursales` → 2 sucursales:
  - id 46, `cod_local 0000`, principal, **sin series**;
  - id 14, `cod_local 0001`, 19 series.
- `GET /series` (todas en la sucursal 0001):
  - facturas F001 (último 719), F020, F065, F988;
  - boletas B001 (240), B020, B065, B067;
  - NC BC01, BC20, FC01, FC20; ND BD01, FD01;
  - guías remitente T001, T009; guía transportista V001; retención R001; percepción P001.
- **Hallazgos importantes:**
  1. *(Corregido en §0.10-a: en beta la emisión es ilimitada y estas cabeceras son solo informativas.)* **Cupo mensual casi agotado.** Las cabeceras dicen `X-Usage-Documents: 496/600`, `X-Usage-Remaining: 104` y `X-Usage-Warning: approaching_limit`. A la vez, `GET /empresa` dice `max_documentos_mes 500` y `documentos_este_mes 240`: **son datos contradictorios**. El código local indicaba que en beta no hay cupos, pero la instancia publicada sí los cuenta [V]. → Las pruebas automáticas deben usar el **simulador**, y las emisiones reales de prueba tienen que ser pocas y planificadas.
  2. **Rate limit real: 30 req/min** (`X-RateLimit-Limit: 30`) aunque el plan es `pro`. El código local daba 120 a pro → **la instancia publicada difiere del código local**. Se diseña con un presupuesto de 30 req/min, compartido entre emisión, polling y descargas.
  3. **El RUC es compartido con otros sistemas**: F001 ya va por 719 y B001 por 240. Por eso:
     - el nuevo sistema debe usar **series propias por sucursal** (p. ej. F101/B101 para la sucursal 1, F102/B102 para la 2) para no mezclar la numeración;
     - el resumen diario es **por empresa y por fecha** (`POST /resumenes {fecha_resumen}` toma **todas** las boletas `pendiente` de esa fecha del RUC), así que podría incluir boletas pendientes de otros sistemas (ver §0.4).
  4. La sucursal `0000` (principal) no tiene series y todas están en `0001`. Para cada sucursal nueva hay que crear sucursal y series en API-PRO (`POST /sucursales`, `POST /series`). El sistema lo ofrecerá desde Configuración, solo para administradores y con confirmación.

### 0.3 Multisucursal
- **Tabla local `sucursales`** con `api_sucursal_id` y `cod_local` (relación 1:1 con la sucursal de API-PRO).
- **Series:** el espejo local `series` lleva la `sucursal_id`; el POS solo muestra las series de la sucursal del usuario. En la emisión se envían la `serie` y el `cod_local` de la sucursal.
- **Inventario:** stock por (producto, sucursal), con kardex por sucursal. Las **transferencias entre sucursales** pasan a la 2.ª etapa (en el MVP: salida en una sucursal y entrada en la otra, enlazadas).
- **Usuarios** asignados a una o varias sucursales (`usuario_sucursales`), con la sucursal activa en la sesión. El administrador ve todas.
- **Caja:** cajas y turnos por sucursal.
- **Reportes y dashboard** con filtro por sucursal, más un consolidado.
- **Datos maestros compartidos** (productos, precios base, clientes, proveedores) entre sucursales. Los precios por sucursal pasan a la 2.ª etapa.

### 0.4 Boletas: envío individual y por resumen diario
- **Configuración:**
  - modo por defecto en cada sucursal: `individual | resumen`;
  - en el modal de cobro, el usuario con permiso `boletas.elegir_modo` puede cambiarlo para esa boleta.
- **Modo individual:** `POST /boletas` normal; se reconcilia igual que la factura.
- **Modo resumen:**
  1. `POST /boletas` con `solo_registro=true`: la API la registra, le asigna el número y la deja `pendiente`. Estado local: **`pendiente_resumen`** (ya tiene número, se puede imprimir el PDF, todavía no está declarada).
  2. **Envío del RC:**
     - un job programado (hora configurable, p. ej. 23:00) y un botón manual en la pantalla "Resumen diario" ejecutan `POST /resumenes {fecha_resumen}`;
     - el sistema guarda `id_resumen`, `identifier` (RC-AAAAMMDD-NNN) y la lista `documentos` que devuelve la API;
     - **concilia esa lista con sus propias boletas** y avisa si el RC incluyó boletas que no son de este sistema.
  3. **Seguimiento:** `GET /resumenes/{id}/estado` (lee la BD de la API, es seguro). Cuando el RC queda `aceptado`, sus boletas pasan a `aceptado`; si sale `rechazado`, la pantalla lo muestra para actuar.
  4. **Plazo:** la API admite `fecha_resumen` entre hoy-7 y hoy. El sistema alerta de las boletas `pendiente_resumen` con más de 1 día y bloquea ofrecer el RC fuera de plazo.
- **Riesgos de este modo:**
  - **R-RC1 (RUC compartido):** un RC puede arrastrar boletas pendientes de otros sistemas del mismo RUC. Hay que confirmar si los otros sistemas usan `solo_registro` [P]. Mitigación: conciliación y alerta. La solución de fondo (un RC por serie o por lista de ids) requiere cambiar API-PRO, que está fuera del alcance.
  - **R-RC2 (bug B11 [I]):** mientras el ticket del RC está en proceso, las boletas quedan `enviado`, y si tarda más de 15 min el scheduler de la API podría reenviarlas de forma individual. Mitigación: comprobarlo con **una prueba controlada en beta** antes de habilitar el modo en producción, y vigilar el `sunat_status` de las boletas del RC.
  - Una boleta ya enviada de forma individual **no** puede ir después en un RC (la API solo toma las `pendiente`).
- **Las NC y ND sobre boletas** se envían siempre de forma individual (la API solo resume boletas).

### 0.5 Notas de débito (08)
- Endpoint `POST /notas-debito`: igual que la NC, con `cod_motivo` del catálogo 10 según la validación de la API. Los campos `doc_afectado_*` son obligatorios salvo el caso de penalidades que admite la API; no admite descuentos globales.
- **Series:** FD01 para facturas y BD01 para boletas. Hacen falta series propias por sucursal.
- **Efecto:** aumenta lo que el cliente debe; **no mueve stock**. Si se cobra, genera un ingreso en la caja del turno.
- **Tablas:** se reutilizan `comprobantes` (tipo 08), `comprobante_items` y `notas`.

### 0.6 Guía de remisión remitente (09)
- Endpoint `POST /guias-remision`. Obligatorios:
  - `serie` (T###), `fecha_emision`, `destinatario{tipo_doc, num_doc, razon_social}`;
  - `cod_traslado` (Cat. 20), `mod_traslado` (01 público / 02 privado), `fecha_traslado`, `peso_total`;
  - `partida_ubigeo/direccion`, `llegada_ubigeo/direccion`, `items[]`.
- **Reglas condicionales:** transporte público (01) exige `transportista{tipo_doc, num_doc, razon_social, nro_mtc}`; transporte privado (02) exige `vehiculo{placa}` + `conductor{…licencia}`. Hay reglas por motivo (p. ej. traslado entre establecimientos de la misma empresa: el destinatario es el propio RUC).
- **Seguimiento:** el envío es asíncrono con ticket. **Por el bug B1, no se usa `GET /guias-remision/{id}/estado`**: se lee `GET /guias-remision/{id}` con backoff.
- **Descargas:** PDF, XML y CDR.
- **Corrección:** `PUT /guias-remision/{id}` solo si está `pendiente` o `rechazado`, con el payload completo.
- **Pantallas:**
  - "Nueva guía", con origen desde una venta (copia los ítems y el destinatario) o manual (p. ej. traslado entre sucursales);
  - datos maestros de **transportistas, vehículos y conductores**;
  - ubigeo con el catálogo `GET /catalogos/ubigeo/*`, guardado localmente.
- **Tablas nuevas:** `guias` (instantáneas, estado, api_id, ticket), `guia_items`, `transportistas`, `vehiculos`, `conductores`.
- **Inventario:** la guía **no mueve stock por sí misma**; el stock lo mueve la venta o la transferencia que la origina.
- **Series:** T001 y T009 existen en la sucursal 0001; harán falta propias por sucursal.

### 0.7 Anulaciones
| Documento | Mecanismo | Endpoint | Plazo y condición |
|---|---|---|---|
| Factura 01, NC 07, ND 08 | Comunicación de baja (RA) | `POST /anulaciones {fecha_generacion, fecha_comunicacion, detalles[{tipo_documento, serie, correlativo, motivo}]}` | `aceptado` y ≤7 días |
| Boleta 03 (y las NC y ND de boletas, según lo que admita la API) | Resumen diario con anulación | `POST /resumenes {fecha_resumen, anular:[{id, motivo}]}` (id interno de la API) | `aceptado`, ≤7 días, sin NC asociada |
| Fuera de plazo | Nota de crédito (motivo 01) | `POST /notas-credito` | — |

- **Seguimiento:** RA con `GET /anulaciones/{id}` (no `/estado`, por B1); RC con `GET /resumenes/{id}/estado`.
- **Efecto local en dos pasos:**
  1. Al solicitar: el comprobante pasa a `anulacion_en_proceso` y **todavía no se mueven el stock ni la caja**.
  2. Al confirmarse `anulado`, en una transacción: devolución de stock (tipo `anulacion`, índice único por origen), egreso o extorno de caja y venta `anulada`.
  - Si SUNAT rechaza la baja, el comprobante vuelve a `aceptado` sin haber tocado el inventario.
- **Guarda B2:** el adaptador **prohíbe** `POST /enviar|/reenviar` sobre cualquier comprobante `anulado` o `anulacion_en_proceso`.
- **Permiso:** `comprobantes.anular` (administrador o supervisor), con motivo obligatorio y auditoría.

### 0.8 Ajustes al plan de fases
- **Fase 4:** añade la gestión multisucursal (local ↔ API-PRO) y la creación asistida de series por sucursal.
- **Fase 5:** stock por sucursal; maestros de transportistas, vehículos y conductores; caché de ubigeos.
- **Fase 7, dividida en subfases:**
  - **7a:** adaptador, simulador, worker y reconciliación; factura y boleta individual;
  - **7b:** boleta por resumen diario (job y pantalla del RC);
  - **7c:** NC y ND;
  - **7d:** anulaciones RA y RC;
  - **7e:** guía de remisión remitente.
- **Emisiones reales en beta:** sin tope de cupo (§0.10-a), pero limitadas a 30 req/min. Las pruebas automáticas de CI usan el simulador; las pruebas de contrato en beta se ejecutan con su propio ritmo.
- **Nuevos módulos:** cuentas por cobrar y multimoneda (fase 6), gestión de series con advertencias (fase 4) y la comprobación previa del RC (fase 7b).

### 0.10 Segunda ronda de decisiones (28-10-2026)

| Tema | Decisión |
|---|---|
| Acceso | Inicio de sesión con usuario y contraseña, más **PIN rápido en el POS** para cambiar o confirmar de cajero sin cerrar la sesión |
| Lenguaje | **TypeScript** en frontend y backend |
| Stock | **No se permite stock negativo** (bloqueo duro en el servidor) |
| Crédito | **Ventas al crédito en PEN y en USD** |
| Series | El sistema **crea y actualiza** series en API-PRO, con advertencias |
| Resumen diario | **Solo debe incluir boletas de este sistema** |
| Emisión | **Ilimitada** |

#### a) Emisión ilimitada (corrige el hallazgo 1 de §0.2) [V]
- `EmissionPolicyService.php` decide en este orden:
  1. el switch global "emisión ilimitada";
  2. **el entorno `beta`, que siempre es ilimitado**;
  3. la empresa marcada como ilimitada;
  4. el cupo del plan (plan ilimitado o límite `-1`).
- Las cabeceras `X-Usage-*` son **solo informativas**: en beta **no se bloquea ninguna emisión**. Las pruebas en beta no tienen tope.
- **Producción:** el nuevo sistema no impone ningún límite. La API sí lo aplicará salvo que la empresa quede como **emisión ilimitada** (o con un plan ilimitado) **en la administración de API-PRO**. Es un ajuste de configuración que tú haces en tu panel, no un cambio de código; sin él, al llegar al cupo, la API respondería 429 `codigo_error: limit_reached`.
- El adaptador trata ese 429 como una **pausa de la cola con alerta**: nunca pierde la venta y la reintenta cuando se levante el límite.
- **El rate limit de 30 req/min sigue aplicando**: es un throttle separado del cupo. Se diseña con ese presupuesto; si en tu panel se puede subir por empresa, conviene hacerlo [P].

#### b) Resumen diario solo con boletas de este sistema
- **Limitación verificada [V]:** `POST /resumenes {fecha_resumen}` toma **todas** las boletas `pendiente` del RUC en esa fecha (`SummaryController.php:152-154`). No acepta lista de ids ni filtro por serie, y no se modificará API-PRO.
- **Garantía construida en el nuevo sistema:**
  1. **Series exclusivas:** las boletas de este sistema solo usan series creadas y marcadas como propias (§c).
  2. **Comprobación previa obligatoria** antes de cada RC: `GET /boletas?fecha_desde=F&fecha_hasta=F&sunat_status=pendiente` (paginado). Si aparece **cualquier boleta pendiente que no sea de este sistema** (otra serie o un id que no esté en la BD local), **no se envía el RC** y se alerta al administrador con el detalle.
  3. **Verificación posterior:** se compara la lista `documentos` que devuelve el RC con las boletas locales. Si entró una boleta ajena (una carrera de milisegundos entre la comprobación y el envío), se registra un incidente crítico.
  4. **Respaldo si el RC queda bloqueado:** para no vencer el plazo, el sistema ofrece **enviar sus propias boletas pendientes de forma individual** (`POST /boletas/{id}/enviar`, válido sobre `pendiente`), igualmente sin tocar las ajenas.
  - **Riesgo residual:** la ventana de carrera del paso 3. La única solución total sería un filtro por ids en API-PRO, que está fuera del alcance.

#### c) Gestión de series y sucursales en API-PRO, con advertencias
- **Lo que permite la API [V]:**
  - `POST /series`: `tipo`, `serie` de 4 caracteres con el prefijo según el tipo, `sucursal_id` y `correlativo_inicial`;
  - `PUT /series/{id}`: `activo`, `correlativo`, `sucursal_id`;
  - `DELETE /series/{id}`: solo desactiva;
  - `POST /sucursales` y `PUT /sucursales/{id}`.
- **Reglas y advertencias del nuevo sistema:**

| Acción | Regla o advertencia |
|---|---|
| Crear una serie | Se valida el prefijo (F/B; FC/BC o F/B para NC; FD/BD para ND; T para la guía 09) y que no exista ya en el RUC. Se marca **"propia"**. Hay que confirmarlo |
| Ver series ajenas (F001, B001…) | Se muestran como **"externas, solo lectura"**, con la advertencia "la usan otros sistemas del RUC". No se pueden asignar a una sucursal del nuevo sistema sin una confirmación reforzada |
| Cambiar el correlativo | **Bloqueado si es menor o igual al último usado**: la API lo aceptaría y provocaría números duplicados o errores 500. Si es mayor, se advierte que se saltan números (SUNAT no exige continuidad, pero queda registrado) y se pide escribir el nombre de la serie para confirmar |
| Mover una serie a otra sucursal | Advierte que los documentos ya emitidos conservan su `cod_local`. Bloqueado si hay boletas `pendiente_resumen` o documentos en curso con esa serie |
| Desactivar | Bloqueado si hay documentos pendientes o en curso de esa serie. Advierte que el POS dejará de ofrecerla |
| Todas las acciones | Solo con el permiso `series.administrar`, auditadas (antes y después), mostrando el mensaje literal de la API si responde un error |

#### d) Ventas al crédito en PEN y USD
- **API [V]:** factura y boleta aceptan `forma_pago: "Credito"` con `cuotas[{monto, fecha_pago}]` (obligatorias) y `tipo_moneda` PEN, USD o EUR.
- **Nuevo módulo "Cuentas por cobrar":**
  - **Tablas:** `cuentas_por_cobrar` (venta, cliente, moneda, total, saldo, estado), `cuotas` (número, monto, vencimiento, saldo) y `cobros` (pago contra cuotas, medio de pago, turno de caja, moneda, tipo de cambio aplicado).
  - **Límite de crédito por cliente** y bloqueo de clientes con cuotas vencidas, configurable [P]. Requiere un permiso específico.
  - **Pantallas:** cartera por cliente, antigüedad de la deuda (vencido 0-30, 31-60, más de 60) y registrar cobro (parcial o total, con impresión de la constancia).
- **Monedas:**
  - Cada venta lleva `moneda` y `tipo_cambio` (venta del día, registrado en la tabla `tipos_cambio` por fecha, con ingreso manual en el MVP) [P: la fuente del tipo de cambio].
  - **Precios:** el producto tiene precio en PEN y opcionalmente en USD. Si no tiene precio USD, se convierte con el tipo de cambio del día redondeando a 2 decimales, y la regla queda visible en el cobro [P].
  - **Caja** por moneda: el turno lleva saldos separados de PEN y USD; el arqueo se hace por moneda.
  - **Cobro en otra moneda** (p. ej. pagar en soles una factura en dólares): se registra con el tipo de cambio aplicado y la diferencia de cambio en el reporte.
  - **Reportes** por moneda original, más un consolidado en PEN.
- **Reglas de negocio:**
  - La suma de las cuotas debe ser igual al total del comprobante, salvo detracción o retención, que no entran en el MVP; y las fechas de las cuotas deben ser posteriores a la emisión.
  - **Boleta mayor a S/ 700:** la API compara el importe sin convertir la moneda (700 USD pasaría), así que el nuevo sistema exige el documento si el **equivalente en PEN** supera S/ 700.
  - **Crédito parcial:** una cuota inicial pagada al contado más el resto en cuotas.
- **Limitación [V]:** la NC no admite cuotas, así que el **motivo 13 (corregir fechas o montos de las cuotas) no se puede emitir**. Si se emitió mal, se corrige con una NC 01 (anulación) y una factura nueva. El cobro "a crédito" de la API (`/facturas/{id}/pagos`) **no se usa**: la cartera vive en el nuevo sistema.
- **Detracción, retención y percepción:** fuera del MVP. Si el negocio vende servicios sujetos a detracción, hay que confirmarlo [P].

#### e) Stock sin negativos
- `inventory.mover()` valida `stock - cantidad >= 0` con `SELECT … FOR UPDATE` en la misma transacción. Responde 409 con los productos y el stock disponible.
- Hay además un `CHECK (cantidad >= 0)` en la tabla `stock` como segunda barrera.
- Los servicios no inventariables no se validan.
- Una NC de devolución y la anulación confirmada suman stock; una ND no mueve stock.

#### f) PIN rápido en el POS
- Login normal con usuario y contraseña (argon2id) por dispositivo o navegador.
- **En el POS:**
  - "Cambiar cajero" con un teclado de PIN de 4–6 dígitos, que cambia el usuario activo del turno sin cerrar la sesión del dispositivo;
  - el PIN también **autoriza acciones sensibles** (descuento, anulación, apertura de cajón) con el PIN de un supervisor.
- **Protecciones:** PIN con hash, bloqueo progresivo tras fallos, válido solo en dispositivos registrados de la sucursal y cierre por inactividad.

### 0.11 Cambios al modelo de datos por la segunda ronda
Tablas nuevas o ampliadas:
- **`series`:** `propia`, `api_serie_id`.
- **`resumenes`:** `api_id`, `identifier`, `fecha_resumen`, `estado`, `documentos_json`, `incidente`.
- **`resumen_boletas`:** comprobante_id.
- **`tipos_cambio`:** `fecha`, `compra`, `venta`, `fuente`; UNIQUE por fecha.
- **`productos`:** `precio_venta_usd` opcional.
- **`ventas` y `comprobantes`:** `moneda`, `tipo_cambio`, `forma_pago`.
- **Cuentas por cobrar:** `cuentas_por_cobrar`, `cuotas`, `cobros`.
- **`turnos_caja`:** saldos por moneda.
- **Accesos:** `dispositivos` (registro de terminales del POS) y `pin_intentos`.

### 0.9 Decisiones que siguen pendientes [P]
> Ya resueltas en §0.10: el acceso, el lenguaje, el stock, el crédito y la moneda, las series, el resumen y la emisión. Quedan:
1. **Fuente del tipo de cambio:** ingreso manual diario (MVP) o una fuente automática más adelante.
2. **Precios en USD:** ¿precio propio por producto o siempre conversión desde PEN?
3. **Límite de crédito por cliente** y si se bloquea a los clientes con cuotas vencidas.
4. **Detracciones:** ¿el negocio vende bienes o servicios sujetos a detracción?
5. **Rate limit:** ¿se puede subir el límite de 30 req/min de esta empresa en tu panel?
6. **Producción:** marcar la empresa como "emisión ilimitada" en la administración de API-PRO al pasar a producción.

### (Histórico) Lista original de la primera ronda
1. **Inicio de sesión:** usuario y contraseña (recomendado), o además un PIN rápido en el POS.
2. **Lenguaje:** TypeScript en front y back (recomendado).
3. **Stock:** ¿se permite stock negativo? Método de costo: promedio ponderado (recomendado).
4. **Venta a crédito con cuotas y moneda USD:** ¿entran en el MVP o en la 2.ª etapa?
5. **Series propias:** ¿autorizas crear series dedicadas por sucursal en API-PRO (p. ej. F101/B101, FC11/BC11, FD11/BD11, T101) y, si hace falta, sucursales nuevas? Son operaciones de escritura en la API.
6. **RUC compartido:** ¿otros sistemas emiten boletas con `solo_registro` en este RUC? (afecta al modo resumen).
7. **Cupo mensual:** confirmar el límite real (600 según las cabeceras o 500 según `/empresa`) y si se amplía para las pruebas.

---

## 1. Resumen ejecutivo

**Objetivo.** Un sistema web multiusuario para un negocio peruano que cubre:
- catálogo, clientes y proveedores;
- compras e inventario con kardex;
- punto de venta con varios medios de pago y caja;
- emisión de comprobantes electrónicos a través de tu API **API-PRO**, que es la que firma, envía a SUNAT y guarda XML y CDR.

**Conclusiones clave**
1. **Contrato de integración.** API-PRO es un servicio Laravel 12 multiempresa con autenticación por las cabeceras `X-Api-Key` + `X-Api-Secret` [V].
   - **La API asigna el correlativo, calcula los impuestos y emite de forma asíncrona.** Responde `201` con estado `enviado` y un job resuelve después `aceptado` o `rechazado` [V].
   - El sistema de ventas **no debe** replicar la numeración, la firma ni la lógica SUNAT. Solo debe construir bien el payload, guardar la trazabilidad y reconciliar estados.
2. **Ferretería es una referencia de alta calidad**, mejor de lo esperado.
   - Ya integra API-PRO (boletas, facturas, NC, PDF/XML/CDR) y resuelve bien la idempotencia, el dinero en céntimos, el kardex y los estados.
   - Su diseño (paleta naranja `#f48c06`, IBM Plex, estilo "sin bordes") se puede trasladar casi directamente.
   - Le faltan caja, compras, proveedores, varios medios de pago y multisucursal, que hay que diseñar desde cero.
3. **La colección de Postman es útil pero no es la fuente de verdad.**
   - No tiene ejemplos de respuesta y contiene **6 solicitudes con credenciales reales escritas en claro**.
   - Tiene varias diferencias de nombres de parámetros con el código.
   - Manda el código de API-PRO.
4. **Hay bugs en API-PRO** que obligan a evitar ciertos endpoints o a usarlos con cuidado (ver §2.8). El plan los rodea sin modificar API-PRO.
5. **Arquitectura recomendada:**
   - un monorepo TypeScript (React + Vite / Express);
   - MySQL 8 con migraciones Knex;
   - un **worker de emisión** separado del servidor HTTP, alimentado por una tabla *outbox* en MySQL, sin Redis en el MVP.

---

## 2. Diagnóstico de API-PRO

### 2.1 Stack y estructura [V]
- Laravel 12. Las rutas REST están en `routes/api.php`, con el prefijo `/api/v1`.
- Controladores en `app/Http/Controllers/Api/V1`, validación en `app/Http/Requests/Api/V1` y cálculo en `app/Services/DocumentCalculationService.php`.
- La integración con SUNAT usa Greenter (`app/Services/Greenter`), con jobs en la cola `sunat`.
- Hay un **SDK oficial TypeScript** en `API-PRO/sdk/ts`, con `fetch` (Node 18.17+), idempotencia y verificación de webhooks. Sirve de referencia o se puede usar directamente.

### 2.2 Autenticación y empresa [V]
- Cada petición lleva `X-Api-Key` y `X-Api-Secret`. Hay un par por empresa (RUC) y no existen usuarios ni scopes: **quien tenga el par controla la empresa completa**, incluido `DELETE /empresa`.
- **Alta:** `POST /registro` (público, multipart) con RUC, razón social, dirección, ubigeo, usuario y clave SOL, certificado `.pfx/.p12/.pem` (≤100 KB), contraseña del certificado y `entorno` (`beta` por defecto o `production`).
  - Devuelve `api_key` y `api_secret`. **Es la única vez que el secret se ve en claro**; también se obtiene al regenerar o recuperar credenciales.
- **Configuración posterior obligatoria:**
  - crear una sucursal (`POST /sucursales`, `cod_local` de 4 dígitos);
  - crear las series (`POST /series` o `POST /series/init-defaults`, que crea F001 y B001);
  - sin una serie activa, la emisión responde 422.
- **Producción:** requiere una licencia válida de la instalación de API-PRO. En beta no se exigen ni licencia ni cupos.
- El tenant se cachea 600 s por api_key, así que los cambios hechos desde el panel web pueden tardar hasta 10 min en aplicarse.

### 2.3 Comprobantes disponibles (implementados en código) [V]

| Documento | Endpoint | Envío a SUNAT | Notas |
|---|---|---|---|
| Factura 01 | `POST /facturas` (+ `/facturas/masivo` ≤100) | Individual, asíncrono | RUC obligatorio salvo exportación |
| Boleta 03 | `POST /boletas` | Individual por defecto; `solo_registro=true` la deja para el resumen | >S/ 700 sin documento → 422 |
| Nota de crédito 07 | `POST /notas-credito` | Individual | **No soporta el motivo 13** (no admite cuotas) |
| Nota de débito 08 | `POST /notas-debito` | Individual | Motivo 13 sin documento afectado |
| Resumen diario RC | `POST /resumenes` | Ticket asíncrono | Solo boletas. También **anula boletas** (`anular:[{id,motivo}]`) |
| Comunicación de baja RA | `POST /anulaciones` | Ticket asíncrono | 01/07/08/20/40, **nunca boletas**, ≤7 días |
| Guía remitente 09 / transportista 31 | `POST /guias-remision`, `/guias-remision-transportista` | Ticket REST (OAuth GRE) | Requiere client_id y client_secret de SUNAT |
| Retención 20, percepción 40, reversión RR, liquidación de compra 04 | sus endpoints | — | Fuera del alcance de una tienda típica |
| Cotizaciones y notas de venta | `/cotizaciones`, `/notas-venta` | No van a SUNAT | Documentos internos de la API |

### 2.4 Contrato de emisión (factura y boleta) [V]
- **Obligatorios:**
  - `serie` (`^F…` / `^B…`, registrada y activa) y `fecha_emision`;
  - `cliente{tipo_doc, num_doc, razon_social}`;
  - `items[]{descripcion, unidad (Cat. 03), cantidad>0, precio_unitario≥0}`.
- **Opcionales útiles:**
  - `correlativo` (no enviarlo), `tipo_operacion` (por defecto 0101), `tipo_moneda` (PEN/USD/EUR);
  - `forma_pago` (`Contado`/`Credito`; con `Credito` las **cuotas son obligatorias**);
  - por ítem: `codigo`, `tip_afe_igv` (Cat. 07, por defecto 10), `cod_producto_sunat`, `descuentos[]`;
  - `cliente.direccion/email`, `observacion`, `enviar_automatico` (por defecto true).
- **Semántica de precios:**
  - `precio_unitario` **incluye IGV** para la afectación 10/17;
  - para 20/30/40 es el valor sin impuesto;
  - la tasa de IGV depende del régimen de la empresa (`GET /empresa` → `tasa_igv_vigente`).
- ⚠️ **Si envías totales o montos calculados, reemplazan a los de la API.** Envía solo cantidad, precio y afectación [V].
- **Respuesta 201:** `{estado:"exito", mensaje, datos:{id, serie, correlativo, numero_completo, totales{…}, items, sunat{estado, codigo, descripcion, notas, hash_cpe}, archivos{xml, cdr, pdf}, …}}`.
- **Error:** `{estado:"error", mensaje, errores{campo:[…]}}` y, en reglas de negocio, `codigo_error` + `siguiente_accion`.
- **Códigos HTTP:** 200, 201, 401, 403 (licencia o suscripción), 404, 409 (idempotencia en curso), 422, 429 (rate limit o cupo, se distinguen por `codigo_error`), 500.

### 2.5 Estados y respuestas de SUNAT [V]
- **Estados de 01/03/07/08:** `pendiente`, `enviado`, `aceptado`, `rechazado`, `anulado`, `anulacion_en_proceso`.
- **Clasificación del CDR:**
  - `0` → aceptado;
  - `≥4000` → **aceptado con observaciones** (en `sunat.notas`);
  - `1000–3999` → rechazado;
  - errores de red: 20 reintentos (unas 15 h) y luego `pendiente` + `codigo=SUNAT_TIMEOUT`.
- **No existe `/estado` para 01/03/07/08:** el estado se lee con `GET /{recurso}/{id}`.
- **Webhook opcional** (`PUT /empresa {url_webhook}`), firmado con `X-Signature: sha256=HMAC(rawBody, api_secret)`.
  - Eventos: `document.sent` (también con observaciones; hay que mirar `sunat_status`), `document.rejected`, `document.timeout_sunat`, etc.
  - Un webhook fallido aparentemente no se reintenta [I], así que siempre hace falta polling de respaldo.

### 2.6 Descargas [V]
- `GET /{tipo}/{id}/xml` → `application/xml`.
- `GET /{tipo}/{id}/cdr` → `application/zip`.
- `GET /{tipo}/{id}/pdf` → `application/pdf`, en línea.
- Todo es un stream binario autenticado: no hay base64 ni URL pública. Si el archivo no existe responde 404 JSON.
- **Parámetro del formato de PDF (inconsistencia verificada):**
  - facturas y liquidaciones aceptan `formato` o `format`;
  - **boletas, NC, ND y guías solo leen `format`**;
  - ferretería envía `formato`, así que el formato se ignora en sus boletas y sale siempre el A4 por defecto;
  - **usar siempre `format=a4|a5|ticket-80|ticket-58`**.

### 2.7 Series, correlativos e idempotencia [V]
- La API numera con bloqueo de fila y un índice único `(tenant, serie, correlativo)`.
- **El sistema de ventas no debe llevar contadores propios**: solo refleja las series (`GET /series`) para que el usuario elija.
- **`Idempotency-Key`:**
  - con la misma key y el mismo cuerpo, devuelve la respuesta guardada (`Idempotency-Replayed: true`);
  - con la misma key y otro cuerpo → 422;
  - si la primera petición sigue en curso → 409;
  - las respuestas 5xx liberan la key.

### 2.8 Limitaciones y bugs que afectan la integración

| # | Problema | Mitigación en el nuevo sistema |
|---|---|---|
| B1 [V] | `GET /anulaciones/{id}/estado` y `GET /guias-remision/{id}/estado` marcan **rechazado** cuando SUNAT responde 98 ("en proceso") | No llamarlos. Leer `GET /anulaciones/{id}` y `GET /guias-remision/{id}` (solo BD) y dejar que los jobs resuelvan |
| B2 [V] | `POST /{doc}/{id}/enviar` y `/reenviar` reabren documentos `anulado` o `anulacion_en_proceso` y no bloquean `enviado` | Llamarlos solo si el estado remoto es `rechazado` o `pendiente`, comprobado justo antes |
| B3 [V] | Con `QUEUE_CONNECTION=sync` el estado final queda sobrescrito con `enviado` | Requisito de despliegue de API-PRO: worker y scheduler activos |
| B4 [I] | `POST /consultar-cdr` llama a la operación equivocada | No usarlo; usar `GET /consultar-cpe` |
| B5 [V] | El panel web y el bridge muestran el secret **cifrado**, que no sirve como `X-Api-Secret` | Obtener el secret de `/registro`, de regenerar o de recuperar |
| B7 [V] | Los totales que manda el cliente pisan el cálculo | No enviar totales |
| B8 [V] | `PUT /facturas/{id}` no valida (500 si faltan campos) y no bloquea `anulado` | Usar PUT solo para corregir un `rechazado` y con el payload completo |
| B9 [V] | Los alias `/api/sunat/*` se saltan la idempotencia y la licencia | Usar solo `/api/v1` |
| B11 [I] | Las boletas de un RC en curso pueden reenviarse de forma individual | Preferir el envío individual de boletas (el modo por defecto) |
| B12 [V] | Paginación y formatos distintos según el recurso | Adaptador con normalizadores por recurso |
| — [V] | Rate limit de 30, 120 o 300 req/min por plan, incluidos el polling y las descargas | Presupuesto de polling y caché local de PDF/XML/CDR |
| — [V] | `DELETE /empresa` borra la empresa solo con la api key | No implementarlo nunca en el adaptador |

### 2.9 Configuración y secretos (solo ubicación)
- `API-PRO\.env` y `.env.mysql.backup`: credenciales locales, ignoradas por git.
- `config/facturacion.php:39-42`: valores por defecto de credenciales GRE beta, versionados en el código.
- Tabla `tenants`: campos cifrados con APP_KEY; si APP_KEY cambia, todos los secrets dejan de valer.
- `storage/app/private/certificates/{ruc}/`: PEM **con la clave privada**.
- `APP_DEBUG=true` en local expone `/api/debug/lookup`; en producción debe ser false.

---

## 3. Matriz de endpoints de la colección de Postman

**Datos de la colección** [V]
- Formato Postman v2.1, 317 solicitudes y 34 carpetas.
- Las dos copias (este proyecto y API-PRO) son idénticas byte a byte (SHA-256 iguales).
- `base_url = https://sunat.kodevo.es/api/v1`. El README de API-PRO indica como producción `https://apisunatv2.kodevo.es` **[P]**.
- **No hay respuestas de ejemplo ni scripts**: las respuestas de la matriz salen del código de API-PRO.
- Autenticación en todas las solicitudes: cabeceras `X-Api-Key: {{api_key}}` y `X-Api-Secret: {{api_secret}}`, con las variables vacías.

| Funcionalidad | Endpoint real | Método | Datos requeridos | Respuesta esperada | Módulo del sistema |
|---|---|---|---|---|---|
| Registrar empresa | `/registro` | POST (multipart) | ruc, razon_social, direccion, ubigeo, sol_user, sol_pass, certificado, contrasena_certificado, entorno | 201 `datos{tenant_id, api_key, api_secret,…}` | Configuración (manual, fuera del sistema) |
| Perfil y entorno de la empresa | `/empresa` | GET / PUT | — / campos a cambiar (`entorno`, `url_webhook`, `client_id`…) | `datos{ruc, razon_social, entorno, tax_regime, tasa_igv_vigente, tiene_certificado…}` | Configuración → "Probar conexión" |
| Certificado y logo | `/empresa/certificado`, `/empresa/logo` | POST multipart | archivo (+ contraseña) | 200 | Configuración (opcional; mejor en el panel de API-PRO) |
| Regenerar credenciales | `/empresa/credenciales/regenerar` | POST | — | nuevo par | Configuración (solo admin, con confirmación) |
| Sucursales | `/sucursales` | CRUD | nombre, cod_local (4), direccion, ubigeo | recurso | Configuración |
| Series | `/series`, `/series/init-defaults` | GET / POST | tipo, serie, sucursal_id | `[{serie, tipo, activo, siguiente_numero}]` | Configuración / POS |
| Buscar RUC/DNI | `/buscar-documento?tipo=&numero=` | GET | tipo (1/4/6/7/0), numero | datos del contribuyente o persona | Clientes / POS |
| Emitir factura | `/facturas` | POST | serie, fecha_emision, cliente{…}, items[…] | 201 `datos{id, numero_completo, sunat{estado:"enviado"}…}` | Ventas → Facturación |
| Emitir boleta | `/boletas` | POST | igual (serie B…) | igual | Ventas → Facturación |
| Listar o consultar comprobantes | `/{facturas\|boletas\|notas-credito\|notas-debito}` y `/{id}` | GET | filtros: fecha_desde/hasta, serie, correlativo, sunat_status, por_pagina | `datos{datos[], paginacion}` / recurso con `sunat.estado` | Historial / reconciliación |
| Corregir rechazado | `/{tipo}/{id}` | PUT | payload completo | recurso (se reenvía) | Facturación (reintento) |
| Enviar o reenviar | `/{tipo}/{id}/enviar` | POST | — | 200 | Facturación (solo `rechazado`/`pendiente`) |
| Descargas | `/{tipo}/{id}/xml`, `/cdr`, `/pdf?format=` | GET | — | binario (xml, zip, pdf) | Documentos |
| Nota de crédito | `/notas-credito` | POST | serie, fecha, cliente, doc_afectado_tipo/serie/correlativo, cod_motivo (Cat. 09), des_motivo, items | 201 | Notas |
| Nota de débito | `/notas-debito` | POST | igual con Cat. 10 | 201 | Notas (2.ª etapa) |
| Resumen diario | `/resumenes` | POST | fecha_resumen [+ anular[{id, motivo}]] | 201 `datos{id_resumen, identifier, documentos…}` | Anulación de boletas |
| Estado del resumen | `/resumenes/{id}/estado` | GET | — | estado guardado en BD | Anulación de boletas |
| Comunicación de baja | `/anulaciones` | POST | fecha_generacion, fecha_comunicacion, detalles[{tipo_documento, serie, correlativo, motivo}] | 201 `datos{id_anulacion, identifier…}` | Anulación de facturas |
| Consultar validez del CPE | `/consultar-cpe` | GET | tipo_doc, serie, correlativo, fecha_emision **dd/mm/aaaa**, **`monto`** | estado SUNAT | Soporte / auditoría |
| Pagos de un comprobante | `/{facturas\|boletas}/{id}/pagos` | GET / POST / DELETE | metodo, monto | — | **No usar**: la caja vive en el sistema de ventas |
| Guías de remisión | `/guias-remision`, `/guias-remision-transportista` | POST | destinatario, traslado, ubigeos, items, transportista o vehículo + conductor | 201 | Guías (opcional) |
| Panel y reportes de la API | `/panel/*`, `/reportes/*` | GET | fechas | JSON / excel / pdf | No hace falta: los reportes salen de la BD local |
| Exportar ZIP | `/comprobantes/exportar-zip` | GET | filtros | zip | Contabilidad (opcional) |
| Catálogos | `/catalogos/producto-sunat/*`, `/catalogos/ubigeo/*` | GET | — | listas | Productos (código SUNAT) / dirección |
| Estado del servicio SUNAT | `/sunat/estado` | GET | — | `{disponible, circuit…}` | Indicador del encabezado |

**Inconsistencias entre Postman y el código**

| Tema | Postman | Código (manda) |
|---|---|---|
| Formato del PDF | `formato=` y `format=` mezclados | `format` funciona en todos; `formato` solo en factura y liquidación |
| Consultar CPE | `monto_total` | `monto` (obligatorio), fecha `dd/mm/aaaa` |
| Paginación | `por_pagina` y `per_page` | Depende del recurso (B12) |
| Filtro de estado | `sunat_status`, `estado`, `estado_sunat` | `sunat_status` en 01/03 |
| CRUD de clientes de la API | `tipo_documento` / `numero_documento` | Comprobantes: `tipo_doc` / `num_doc` |
| Motivos de los ejemplos | ND "penalidad" con motivo 02; NC de devolución parcial con 06 | Penalidad = 03 (Cat. 10); devolución parcial = 07 (Cat. 09) |
| Documentación referida | archivos .md antiguos | Ahora está en `API-PRO/documentacion/...` |

**Seguridad de la colección [V]**
- Hay valores literales (no variables) en:
  - "Registrar empresa": usuario y clave SOL, contraseña del certificado, client_id, client_secret;
  - "Subir certificado": contraseña;
  - "Recuperar credenciales (verificar token)" y "Crear suscripción pagada": tokens;
  - "Activar SIRE": usuario y clave SOL, client_id, client_secret.
- No reproduzco los valores. **Recomendación:** rotarlos si la colección se compartió, y convertirlos en variables secretas.

**Imprescindibles para el MVP:**
- `GET /empresa`, `GET /series`;
- `POST /facturas`, `POST /boletas`, `GET /{tipo}/{id}`, `PUT /{tipo}/{id}` y `POST /{tipo}/{id}/enviar` (con guardas);
- las descargas xml, cdr y pdf;
- `POST /notas-credito`;
- `/buscar-documento` (opcional pero muy útil en el POS).

**Orden de dependencias:**
1. Registro (manual, fuera del sistema).
2. Sucursal y series en API-PRO.
3. "Probar conexión" (`GET /empresa` + `GET /series`).
4. Emisión, luego reconciliación (polling o webhook), luego descargas.
5. Si sale rechazado: corregir con PUT o `/enviar`.
6. Si ya está aceptado y hay que revertir:
   - NC (cualquier plazo);
   - baja RA para facturas (≤7 días);
   - RC con anulación para boletas (≤7 días).

---

## 4. Diagnóstico del proyecto ferretería

**Stack:** PHP 8.3 sin framework, MySQL 8 y una SPA en JavaScript vanilla con rutas por `#hash` y componentes propios (`public/assets/js/ui.js`).

**Calidad alta [V]:**
- PDO con parámetros en todas las consultas;
- transacciones con `FOR UPDATE`;
- importes en céntimos enteros y recálculo en el servidor;
- CSRF, roles y permisos, PIN con bloqueo;
- llaves de la API cifradas (libsodium) y de solo escritura;
- CSP estricta;
- kardex con índice único por origen;
- doble idempotencia (UUID de venta + `Idempotency-Key` por comprobante).

**Reutilizar conceptualmente**
- **Diseño:**
  - colores: primario `#f48c06`, `brand-strong` `#8a4c00`, fondo `#fbfeff`, texto `#08181d`, muted `#5c7077`, relleno de controles `#eef3f5`, borde de campos `#cdd8dc`, peligro `#ff5f73`, éxito `#02713a`, aviso `#7a5602`, info `#1f5f99`;
  - **tema oscuro completo** (fondo `#060b11`, card `#0c1219`);
  - IBM Plex Sans y Mono, interfaz a 14px en semibold, radio 0.7rem, controles de 36px (44px en táctil);
  - estilo "sin bordes, solo sombra"; iconos Lucide con stroke 2.5.
- **Marco:** menú lateral agrupado (Operación, Ventas, Almacén, Administración) que se pliega a iconos, va siempre plegado en tablet y es un cajón en móvil. Encabezado sticky con blur, migas, estado de red y tema.
- **Tabla responsive** sin scroll horizontal: las columnas secundarias pasan a una fila desplegable "+".
- **POS:**
  - catálogo con búsqueda (Enter con código exacto = lector de barras) y píldoras de categoría;
  - carrito con aspecto de papel de ticketera;
  - modal de cobro en dos columnas, con Boleta/Factura, cliente que se autocompleta y vuelto;
  - modal de éxito con sondeo del estado del CPE;
  - conmutador "Productos | Venta" en móvil.
- **Reglas peruanas:** unidades enteras o fraccionables, boleta sin documento hasta S/ 700, RUC con módulo 11, descuento con permiso y motivo.
- **Cálculo** (`app/Servicios/Calculo.php`): replica el redondeo de la API y reparte el descuento global entre las líneas para cuadrar al céntimo. Hay que portarlo a TypeScript con sus pruebas.
- **Estados de CPE con textos y tonos**, el simulador de la API (`SunatSimulador.php`, `tests/api_simulada.php`) y el ticket de 80mm con `@page`.

**No copiar / rehacer**
- La construcción del DOM a mano con variables globales y los controladores estáticos con lógica de dominio.
- Los ítems de la NC guardados en `respuesta_json` en lugar de una tabla.
- La emisión dentro de la petición HTTP, sin cola, y el sondeo manual.
- Los listados sin paginación en el servidor.
- El código muerto del proyecto "Restaurante" (mesas, cocina, propinas).
- La configuración clave/valor que mezcla datos con secretos.
- El envío de `formato` en el PDF (ver §2.6).

**Ausente en ferretería:** proveedores, compras, caja y turnos, varios medios de pago, multisucursal, multimoneda, auditoría, notas de débito y gráficos.

**Estado de su integración:** su log registra respuestas 401 "Credenciales de API inválidas" en la prueba de conexión, así que **la integración real no está demostrada** [V]. Antes de la fase 7 hay que tener credenciales beta válidas.

**Datos sensibles (solo ubicación):**
- `ferreteria/.env` (credenciales de la BD);
- `storage/clave-cifrado.key`;
- tabla `configuracion` (llaves cifradas);
- `storage/sunat/*` (comprobantes reales con RUC). No copiarlos al nuevo repositorio.

---

## 5. Requisitos

### 5.1 Funcionales (resumen)
- **RF-01** Inicio de sesión con usuario y contraseña (y PIN rápido opcional en el POS); cierre por inactividad; roles y permisos por operación.
- **RF-02** Datos de la empresa y una o varias sucursales; conexión con API-PRO (URL, key y secret cifrados), con botón "Probar conexión".
- **RF-03** CRUD de productos y servicios:
  - código interno y de barras, categoría, unidad (Cat. 03), afectación IGV (Cat. 07);
  - precio de venta con IGV, costo, stock mínimo, inventariable sí/no, código SUNAT opcional.
- **RF-04** Categorías y unidades de medida (catálogo con el código SUNAT y si la unidad es fraccionable).
- **RF-05** Clientes: DNI, RUC, CE y pasaporte, con validación (módulo 11) y consulta `/buscar-documento`.
- **RF-06** Proveedores y compras: documento del proveedor (registro interno, no electrónico), detalle, costo y entrada al kardex.
- **RF-07** Inventario: entradas, salidas, ajustes con motivo, kardex por producto, alertas de stock mínimo.
- **RF-08** POS: búsqueda o escaneo, carrito, descuentos con permiso, Boleta/Factura, cliente, **varios medios de pago** y vuelto.
- **RF-09** Emisión, reconciliación de estados, reintentos seguros, PDF A4 o ticket, XML y CDR.
- **RF-10** Notas de crédito 01, 06 y 07 con devolución de stock; anulación de facturas (RA) y boletas (RC) dentro de los 7 días.
- **RF-11** Caja: apertura, ingresos y egresos, cierre con arqueo por medio de pago.
- **RF-12** Dashboard y reportes: por fechas, producto, cliente, usuario, medio de pago, estado del CPE, kardex, compras y cierres; exportación a Excel o CSV.
- **RF-13** Auditoría de acciones y de intentos de emisión.

### 5.2 No funcionales
- **RNF-01 Seguridad:**
  - los secretos solo viven en el backend, cifrados en reposo;
  - HTTPS, OWASP (SQLi, XSS, CSRF), rate limit en el login, cabeceras seguras (helmet).
- **RNF-02 Integridad:**
  - transacciones ACID en venta, compra, ajuste y caja;
  - idempotencia de extremo a extremo;
  - cero duplicados de venta, comprobante o movimiento de stock.
- **RNF-03 Exactitud monetaria:** DECIMAL en BD y aritmética decimal en el código; los totales deben coincidir al céntimo con API-PRO.
- **RNF-04 Rendimiento:** POS con búsqueda <300 ms con 10 000 productos y paginación en el servidor.
- **RNF-05 Disponibilidad:** el POS vende aunque API-PRO o SUNAT estén caídos; la emisión se encola y se reconcilia.
- **RNF-06 Responsive:** desde 360px hasta escritorio, controles de 44px en táctil, tema claro y oscuro.
- **RNF-07 Mantenibilidad:** TypeScript, módulos por dominio, esquemas de validación compartidos, pruebas automáticas y logs estructurados.
- **RNF-08 Zona horaria:** las fechas se guardan en UTC (`DATETIME`) y la fecha de emisión tributaria se calcula en America/Lima.

---

## 6. Módulos definitivos y prioridad

| Módulo | MVP | 2.ª etapa | Futuro |
|---|---|---|---|
| Autenticación, usuarios, roles y permisos | ✅ login, roles fijos, permisos por operación | recuperar acceso por email, roles editables | 2FA |
| Configuración (empresa, sucursal, API-PRO, impresión) | ✅ una empresa, una sucursal | varias sucursales y series por sucursal | multiempresa |
| Categorías y unidades | ✅ | — | — |
| Productos y servicios | ✅ | imágenes, código SUNAT obligatorio, listas de precios | variantes, lotes y vencimientos |
| Clientes | ✅ + `/buscar-documento` | historial y crédito | — |
| Proveedores y compras | ✅ registro básico + entrada de stock | costo promedio, cuentas por pagar | órdenes de compra |
| Inventario y kardex | ✅ | inventario físico por conteo | varios almacenes y transferencias |
| POS y ventas | ✅ Contado, varios medios de pago | crédito con cuotas, ventas en USD | ventas sin conexión |
| Facturación (factura, boleta) | ✅ emisión, reconciliación, descargas, reintento | webhook | — |
| Notas de crédito | ✅ 01, 06 y 07 | otros motivos (excepto 13, no soportado) | — |
| Boletas por resumen diario (además del envío individual) | ✅ (decisión del usuario) | — | — |
| Anulaciones (RA facturas, NC y ND / RC boletas) | ✅ (decisión del usuario) | — | — |
| Notas de débito | ✅ (decisión del usuario) | — | — |
| Guía de remisión remitente (09) | ✅ (decisión del usuario) | guía transportista (31) | — |
| Multisucursal | ✅ (decisión del usuario) | transferencias formales, precios por sucursal | — |
| Caja y turnos | ✅ apertura, cierre y arqueo | egresos categorizados, varias cajas | — |
| Dashboard | ✅ indicadores básicos | gráficos y comparativos | — |
| Reportes | ✅ ventas por fecha y estado de CPE, stock bajo | todos los de §6.12 del prompt + Excel | — |
| Auditoría | ✅ intentos de emisión + acciones críticas | visor con filtros | — |
| Respaldos | ✅ script mysqldump programado | restauración guiada | — |

---

## 7. Arquitectura recomendada

```
 Navegador (React SPA)
     │  HTTPS, JSON, cookie de sesión httpOnly + CSRF
     ▼
 API Node/Express  ──────────────┐
  (módulos por dominio)          │ lee/escribe
     │  transacciones            ▼
     ├──────────────────────► MySQL 8 ◄────────────┐
     │  inserta en el outbox                       │ toma trabajos (SKIP LOCKED)
     │                                             │
     │                                     Worker de facturación (Node)
     │                                             │ HTTPS + X-Api-Key/Secret + Idempotency-Key
     │                                             ▼
     │  POST /webhooks/api-pro (2.ª etapa) ◄─── API-PRO (Laravel) ───► SUNAT
     └── proxy de PDF/XML/CDR (con caché en disco o en BD) ─┘
```

**Decisiones y justificación [R]**
- **TypeScript en frontend y backend.** Hay mucha lógica tributaria y de dinero, los tipos evitan errores de contrato y permiten compartir **esquemas zod** entre los dos lados (paquete `shared`).
- **Frontend:**
  - React 18 + Vite, React Router y TanStack Query (caché y reintentos);
  - react-hook-form + zod, TanStack Table, lucide-react, Recharts;
  - CSS con variables (tokens de ferretería) y CSS Modules, sin un framework visual pesado, para conservar fielmente la identidad.
- **Backend:**
  - Express 4/5 con helmet, cors restringido, express-rate-limit y pino (logs);
  - capas: routes → controller → service → repository;
  - manejador central de errores con la forma `{error, codigo, campos}`.
- **Acceso a datos:** **Knex + mysql2**. Migraciones y seeds maduros, SQL explícito, `forUpdate()` y transacciones claras; menos magia que un ORM para la lógica de stock y caja.
- **Autenticación:**
  - sesión con cookie `httpOnly; Secure; SameSite=Strict`, guardada en MySQL, más un token CSRF;
  - se prefiere a un JWT en localStorage porque evita el robo de tokens por XSS y permite revocar sesiones al momento (útil para desactivar a un cajero).
- **Emisión asíncrona con outbox en MySQL:**
  - la venta y el comprobante `pendiente` y su trabajo se insertan **en la misma transacción**;
  - un proceso worker los toma con `SELECT … FOR UPDATE SKIP LOCKED`, emite, reconcilia y reintenta con backoff;
  - no exige Redis en el MVP; BullMQ puede venir después si hace falta.
- **Adaptador `apiPro`:** el único módulo que conoce API-PRO. Se encarga de las cabeceras, los timeouts (10 s de conexión, 30 s total), los normalizadores de respuesta por recurso, el mapeo de errores, los binarios a Buffer, las guardas anti-bug (§2.8) y un **modo simulación** (port del simulador de ferretería) para el desarrollo y las pruebas sin credenciales.
- **React nunca llama a API-PRO.** Los PDF, XML y CDR se sirven a través del backend, con control de permisos.

---

## 8. Estructura de carpetas propuesta

```
sistemas-ventas-curso/
├─ apps/
│  ├─ web/                      React + Vite + TS
│  │  └─ src/
│  │     ├─ app/                router, providers (QueryClient, Auth, Theme, Toasts)
│  │     ├─ layouts/            AppLayout (sidebar, topbar), AuthLayout
│  │     ├─ components/ui/      Button, Field, MoneyInput, Dialog, DataTable, StatusChip, KpiCard, Tabs, EmptyState, Banner, PinPad
│  │     ├─ features/           auth, dashboard, products, categories, customers, suppliers,
│  │     │                      purchases, inventory, pos, documents (comprobantes), cash, reports, settings, users
│  │     │   └─ <feature>/      pages/, components/, api.ts, hooks.ts
│  │     ├─ lib/                http.ts, money.ts, dates.ts, cpe.ts, permissions.ts
│  │     └─ styles/             tokens.css (claro/oscuro), base.css, print.css
│  └─ api/                      Express + TS
│     └─ src/
│        ├─ modules/            auth, users, settings, catalog (products, categories, units),
│        │                      customers, suppliers, purchases, inventory, sales, cash,
│        │                      invoicing (comprobantes, notas, anulaciones), reports, audit
│        │   └─ <module>/       *.routes.ts, *.controller.ts, *.service.ts, *.repository.ts, *.schemas.ts
│        ├─ integrations/apiPro/ client.ts, mappers.ts, errors.ts, simulator.ts, types.ts
│        ├─ workers/            invoicing.worker.ts (outbox), reconcile.job.ts
│        ├─ middlewares/        auth, permissions, csrf, validate, errorHandler, requestId
│        ├─ config/             env.ts (validado con zod), logger.ts
│        ├─ database/           knexfile.ts, migrations/, seeds/
│        └─ shared/             money.ts (decimal), tax.ts (port de Calculo), crypto.ts, http-errors.ts
├─ packages/shared/             esquemas zod, enums (estados, catálogos), tipos de DTO
├─ docs/                        este plan, contrato de API interna, ADRs
└─ package.json                 workspaces (npm o pnpm)
```

Se descartan del boceto del prompt las carpetas `src/routes` globales y `src/validators` sueltas: las rutas y los esquemas viven dentro de cada módulo o feature, para evitar duplicar.

---

## 9. Modelo de base de datos (MySQL 8, InnoDB, utf8mb4)

**Convenciones**
- PK `BIGINT UNSIGNED AUTO_INCREMENT`.
- Importes `DECIMAL(12,2)`; precio unitario `DECIMAL(14,6)`; cantidades `DECIMAL(12,3)`.
- Fechas `DATETIME` en UTC más `fecha_emision DATE` en hora de Lima.
- `created_at`, `updated_at` y, donde aplique, `created_by`.
- Las desactivaciones son lógicas (`activo`). **Los documentos emitidos nunca se borran ni se editan.**

| Tabla | Campos principales | Relaciones y restricciones |
|---|---|---|
| `empresa` | ruc, razon_social, nombre_comercial, direccion, telefono, logo, tasa_igv_cache, api_url, api_key_enc, api_secret_enc, entorno, modo_emision (simulacion/real) | 1 fila en el MVP; secretos cifrados con AES-256-GCM, clave en `.env` |
| `sucursales` | empresa_id, nombre, cod_local (4), direccion, ubigeo, activo | UNIQUE(empresa_id, cod_local) |
| `series` (espejo) | sucursal_id, tipo_doc (01/03/07/08), serie, activo, sincronizado_en | UNIQUE(serie, tipo_doc). **Sin contador**: la numeración es de la API |
| `usuarios` | nombre, usuario (único), email, password_hash (argon2id), pin_hash, rol_id, sucursal_id, activo, intentos_fallidos, bloqueado_hasta | FK rol, sucursal |
| `roles`, `permisos`, `rol_permisos` | codigo, nombre | N:M; permisos como `ventas.crear`, `comprobantes.anular`… |
| `sesiones` | id (hash), usuario_id, expira_en, ip, user_agent | índice por usuario |
| `categorias` | nombre (único), activo | — |
| `unidades` | codigo_sunat (Cat. 03, único), nombre, fraccionable | semilla NIU, ZZ, KGM, MTR, LTR, GLL, BX… |
| `productos` | codigo (único), codigo_barras (único, NULL), nombre, categoria_id, unidad_id, tipo (bien/servicio), inventariable, tip_afe_igv (Cat. 07), cod_producto_sunat, precio_venta (con IGV), costo_promedio, stock_minimo, activo | FK; CHECK precio ≥ 0; índice FULLTEXT o por nombre |
| `stock` | producto_id, sucursal_id, cantidad | PK(producto_id, sucursal_id); solo lo modifica `inventory.service` |
| `movimientos_stock` (kardex) | producto_id, sucursal_id, tipo (compra, venta, devolucion, ajuste_entrada, ajuste_salida, anulacion), cantidad (con signo), costo_unitario, stock_resultante, origen_tipo, origen_id, usuario_id, nota, fecha | **UNIQUE(origen_tipo, origen_id, producto_id)** contra la doble aplicación; índice (producto_id, fecha) |
| `clientes` | tipo_doc (Cat. 06), num_doc, razon_social, direccion, email, telefono, activo | UNIQUE(tipo_doc, num_doc) |
| `proveedores` | tipo_doc, num_doc, razon_social, contacto, telefono, email, activo | UNIQUE(tipo_doc, num_doc) |
| `compras` | proveedor_id, sucursal_id, tipo_doc_compra, serie_numero, fecha, moneda, subtotal, igv, total, estado (registrada/anulada), usuario_id | UNIQUE(proveedor_id, tipo_doc_compra, serie_numero) |
| `compra_items` | compra_id, producto_id, cantidad, costo_unitario, total | FK |
| `metodos_pago` | codigo, nombre (Efectivo, Tarjeta, Yape/Plin, Transferencia…), requiere_referencia, afecta_caja, activo | configurable |
| `cajas` | sucursal_id, nombre, activo | — |
| `turnos_caja` | caja_id, usuario_apertura, monto_inicial, abierto_en, usuario_cierre, cerrado_en, estado, totales_esperados_json, totales_contados_json, diferencia | un solo turno abierto por caja (índice único sobre una columna generada) |
| `movimientos_caja` | turno_id, tipo (ingreso/egreso/venta/devolucion), metodo_pago_id, monto, concepto, origen_tipo, origen_id, usuario_id | UNIQUE(origen_tipo, origen_id, metodo_pago_id) |
| `ventas` | clave_idempotencia CHAR(36) **UNIQUE**, sucursal_id, turno_id, usuario_id, cliente_id NULL, fecha, moneda, subtotal, descuento, descuento_motivo, op_gravada, op_exonerada, op_inafecta, igv, total, estado (confirmada/anulada) | FK; la venta es el hecho comercial |
| `venta_items` | venta_id, producto_id, **instantánea** (codigo, descripcion, unidad, tip_afe_igv), cantidad, precio_unitario (con IGV y el descuento repartido), igv, total | los cambios de precio no afectan al histórico |
| `pagos` | venta_id, metodo_pago_id, monto, monto_recibido, vuelto, referencia | SUM(pagos) = total (validado en el servicio) |
| `comprobantes` | venta_id NULL, tipo_doc (01/03/07/08), serie, correlativo NULL, numero_completo, **instantánea del cliente**, fecha_emision, moneda, totales, estado_local, api_id, sunat_codigo, sunat_descripcion, sunat_notas JSON, hash_cpe, idempotency_key CHAR(36) UNIQUE, intentos, proximo_intento_en, ultimo_error, simulado | UNIQUE(tipo_doc, serie, correlativo, simulado) para los no nulos; UNIQUE(api_id); índices (estado_local, proximo_intento_en) y (fecha_emision) |
| `comprobante_items` | comprobante_id, venta_item_id NULL, instantánea, cantidad, precio_unitario, igv, total | **soluciona el defecto de ferretería** (ítems de la NC en JSON) |
| `notas` (detalle de NC y ND) | comprobante_id (la nota), comprobante_afectado_id, cod_motivo, des_motivo, devuelve_stock | FK; la suma de las NC ≤ total del afectado (en el servicio) |
| `anulaciones` | tipo (RA/RC), api_id, identifier, fecha, estado, respuesta_json | — |
| `anulacion_detalles` | anulacion_id, comprobante_id, motivo | UNIQUE(comprobante_id) mientras esté activa |
| `integracion_intentos` | comprobante_id, operacion (emitir, consultar, enviar, pdf…), request_json (sin secretos), http_status, response_json, duracion_ms, error, idempotency_key, creado_en | **historial completo y la respuesta original** |
| `outbox_trabajos` | tipo, ref_id, estado (pendiente/en_proceso/hecho/fallido), intentos, ejecutar_en, bloqueado_hasta, ultimo_error | índice (estado, ejecutar_en) |
| `archivos_cpe` | comprobante_id, tipo (pdf-a4, pdf-ticket80, xml, cdr), ruta o blob, sha256 | caché local para no gastar rate limit |
| `configuracion` | clave, valor, tipo | solo ajustes no sensibles (ticket, inactividad…) |
| `auditoria` | usuario_id, accion, entidad, entidad_id, antes JSON, despues JSON, ip, fecha | solo inserción |

**Reglas de integridad clave**
- La venta, sus ítems, los pagos, el movimiento de stock, el movimiento de caja, el comprobante `pendiente` y el trabajo en el outbox se crean en **una sola transacción**, con `SELECT … FOR UPDATE` sobre `stock`.
- **Stock negativo:** se bloquea por defecto, configurable [P].
- Un comprobante con estado `aceptado` u `observado` es inmutable: solo puede tener notas o anulación.
- **Precio histórico:** las instantáneas en `venta_items` y `comprobante_items`; nunca se hace JOIN al precio actual para reportar ventas pasadas.

---

## 10. Flujos de negocio

### 10.1 Estados locales del comprobante [R]

| Estado local | Significado | Cómo se llega |
|---|---|---|
| `pendiente` | Registrado localmente, aún no enviado | Venta confirmada |
| `enviando` | Un worker lo tomó (UPDATE condicional) | Worker |
| `en_proceso` | API-PRO lo aceptó (201) y lo encoló para SUNAT | `sunat.estado = enviado` |
| `aceptado` | CDR 0 | Reconciliación |
| `observado` | Aceptado con código ≥4000 o con notas | Reconciliación |
| `rechazado` | CDR 1000–3999 u otro error permanente | Reconciliación |
| `error_validacion` | API-PRO respondió 4xx (422 de datos, serie…) y **no se creó** el documento | Respuesta |
| `por_verificar` | Timeout o conexión perdida **después** de enviar: no se sabe si se creó | Error de red |
| `sin_respuesta_sunat` | API-PRO agotó sus reintentos (`pendiente` + `SUNAT_TIMEOUT`) | Reconciliación |
| `anulacion_en_proceso` / `anulado` | Baja RA o RC en curso o confirmada | Anulación |

Solo `aceptado` y `observado` cuentan como "facturado". El POS muestra cada estado con su chip.

### 10.2 Venta con facturación (paso a paso)
1. **Login.** Sesión con cookie; los permisos llegan en `GET /me`.
2. **POS.** El frontend verifica que haya un **turno de caja abierto**; si no, ofrece abrirlo.
3. **Productos.** Se buscan o escanean (búsqueda en el servidor, con debounce) y se agregan al carrito. El carrito se guarda en `sessionStorage` junto con una `clave_idempotencia` UUID de la venta.
4. **Validación previa.** Al agregar, se muestran el precio y el stock en la interfaz; la validación definitiva se repite en el servidor.
5. **Cliente.** Se elige o se registra (autocompletado y `/buscar-documento`). Boleta sin documento hasta S/ 700; factura con RUC válido.
6. **Comprobante.** Se elige el tipo (03 o 01) y la serie (del espejo `series`).
7. **Importes.** El frontend calcula para mostrar; **el backend recalcula** con `tax.ts` (port de `Calculo.php`, la tasa de IGV viene de `GET /empresa`).
8. **`POST /api/ventas` con la `clave_idempotencia`**, en una sola transacción:
   - si la clave ya existe → devuelve la venta existente (200), sin duplicar;
   - bloquea el stock (FOR UPDATE) y valida;
   - inserta venta, ítems, pagos, movimientos de stock y de caja, el comprobante `pendiente` (con `idempotency_key` nueva) y el trabajo en el outbox;
   - COMMIT.
9. **Pago.** Se registra dentro de la misma transacción: SUM(pagos) = total; el vuelto solo aplica al efectivo.
10. **Construcción del payload.** El worker lo arma con las instantáneas: `serie`, `fecha_emision`, `tipo_moneda`, `forma_pago`, `cliente`, `items{codigo, descripcion, unidad, cantidad, precio_unitario, tip_afe_igv}`, y `tipo_operacion` en la factura. **Sin totales y sin correlativo.**
11. **Envío.** El worker hace el UPDATE condicional `pendiente|por_verificar → enviando` y llama a `POST /facturas|/boletas` con `Idempotency-Key = comprobante.idempotency_key`.
12. **Interpretación de la respuesta:**
    - 201 → guarda `api_id`, `serie`, `correlativo`, `numero_completo` y pasa a `en_proceso` (o al final, si ya viene así);
    - 422 → `error_validacion` con `errores` por campo;
    - 409 → reintentar más tarde;
    - 401, 403 o 429 → pausar la cola y alertar;
    - 5xx o timeout → `por_verificar`.
13. **Reconciliación.** Un job consulta `GET /{tipo}/{api_id}` con backoff (5 s, 15 s, 60 s, 5 min, 30 min…) hasta un estado final. Cada llamada queda en `integracion_intentos`.
14. **Trazabilidad.** Request (sin secretos) y response de cada intento, más auditoría.
15. **Documentos.** PDF (`format=ticket-80` en el POS, `a4` en el historial), XML y CDR a través del proxy del backend, en caché local cuando el estado es final.
16. **Reportes e inventario.** El stock y la caja se movieron **una sola vez** en el paso 8, gracias a los índices únicos por origen. Los reportes leen la BD local.

### 10.3 Escenarios de fallo

| Situación | Comportamiento |
|---|---|
| **API rechaza** (422 de validación) | `error_validacion`; la venta sigue registrada. El usuario corrige los datos del cliente o la serie y reintenta con **una Idempotency-Key nueva** (el cuerpo cambió). Si no se puede corregir: "anular venta interna" (revierte stock y caja; el comprobante nunca existió en SUNAT) |
| **SUNAT rechaza** (CDR 1000–3999) | `rechazado`, con el código y la descripción visibles. Opciones: corregir con `PUT /{tipo}/{id}` (mismo número, la API reenvía) o anular la venta internamente. Según el informe de API-PRO, un rechazo no consume el comprobante ante SUNAT [I]; confirmar con tu contador [P] |
| **Timeout** de la solicitud | `por_verificar`. El reintento usa la **misma** Idempotency-Key: si la API ya lo creó, devuelve la respuesta guardada; si no, lo crea. Nunca hay duplicado |
| **Conexión perdida después de enviar** | Igual que el timeout. Si la key ya expiró en la API, se busca con `GET /{tipo}?fecha_desde=…` filtrando por cliente y total antes de reenviar [R] |
| **El usuario intenta emitir dos veces** | El botón se bloquea en la interfaz. La venta tiene clave única (no se duplica). El comprobante se "toma" con un UPDATE condicional (un solo worker). La Idempotency-Key se fija por comprobante |
| **Pago registrado y emisión pendiente** | Es el caso normal y aceptado: la venta y la caja son válidas. Se entrega una constancia interna con la leyenda "comprobante en proceso" y se reconcilia en segundo plano. El dashboard muestra los pendientes. Si al final del día siguen sin resolverse, hay una alerta |
| **SUNAT devuelve observaciones** (≥4000) | `observado` = válido. Se guardan y muestran `sunat_notas`; no se reintenta |
| **API-PRO agotó sus reintentos** (`SUNAT_TIMEOUT`) | `sin_respuesta_sunat`. Botón "Reenviar", que llama a `POST /enviar` **solo** si el estado remoto, comprobado justo antes, es `pendiente` o `rechazado` (por el bug B2) |
| **Hay que emitir una NC** | Se busca el comprobante `aceptado` u `observado` y se elige el motivo (01 anulación, 06 devolución total, 07 devolución parcial por línea). Se valida que la suma de NC no supere el total del afectado. En una transacción: comprobante 07, `notas`, devolución de stock si aplica y egreso de caja si se devuelve dinero. Después se emite igual que una venta |
| **Anular una factura ≤7 días** | Baja RA (`POST /anulaciones`) → `anulacion_en_proceso`; se reconcilia con `GET /anulaciones/{id}` (no `/estado`, por el bug B1) |
| **Anular una boleta ≤7 días** | `POST /resumenes` con `anular:[{id: api_id}]` |
| **Anular después de 7 días** | Solo con NC |

Ninguna operación aceptada por SUNAT se "deshace": se compensa con documentos nuevos.

### 10.4 Inventario
- Las compras, ajustes, ventas, NC y anulaciones internas pasan todas por `inventory.service.mover()` dentro de la transacción del origen.
- El índice único por origen impide la doble aplicación.
- Un movimiento no se edita: se compensa con otro movimiento.

---

## 11. Plan de implementación por fases

> Prioridad: **MVP** = imprescindible · **E2** = segunda etapa · **F** = futuro.

### Fase 1. Auditoría técnica (✅ este informe) · MVP
- **Objetivo:** conocer el contrato real y las limitaciones.
- **Resultado:** este documento y los 3 anexos.
- **Criterio de aceptación:** apruebas el plan y respondes las decisiones de §13.
- **Riesgo:** la API publicada difiere del código local (por eso la fase 7 empieza con pruebas de contrato).

### Fase 2. Diseño y arquitectura · MVP
- **Funcionalidades:** ADRs (stack, auth, outbox), diagrama ER definitivo, contrato OpenAPI de la API interna, prototipos de baja fidelidad de Login, Layout, POS, Cobro, Comprobantes y Caja.
- **Archivos:** `docs/arquitectura.md`, `docs/api-interna.yaml`, `docs/er.md`, `docs/adr/*`.
- **Depende de:** fase 1.
- **Aceptación:** apruebas el modelo ER y los prototipos.
- **Pruebas:** revisión cruzada del ER contra los flujos de §10.
- **Riesgo:** cambiar el alcance a mitad de camino.
- **Resultado:** especificación congelada del MVP.

### Fase 3. Configuración inicial · MVP
- **Funcionalidades:**
  - monorepo con workspaces, Vite + React + TS, Express + TS;
  - ESLint + Prettier, Vitest y Supertest;
  - Knex con las migraciones base y las semillas (unidades Cat. 03, afectaciones Cat. 07, tipos de documento Cat. 06, motivos Cat. 09/10, medios de pago, rol admin);
  - `.env.example`, validación del entorno con zod, logger pino;
  - layout vacío con los tokens claro y oscuro.
- **Archivos:** `apps/*`, `packages/shared`, `database/migrations/*`, `styles/tokens.css`.
- **Depende de:** fase 2.
- **Aceptación:** `npm run dev` levanta web y api; las migraciones suben y bajan limpias; la CI local pasa lint y test.
- **Pruebas:** humo de la API (`/health`) y migraciones idempotentes.
- **Riesgo:** versiones de MySQL en Laragon (exige 8.0+ por `SKIP LOCKED`, CHECK y JSON) **[P]**.
- **Resultado:** esqueleto ejecutable.

### Fase 4. Seguridad y administración · MVP
- **Funcionalidades:**
  - login, logout, sesión en MySQL, CSRF, rate limit del login, bloqueo por intentos, inactividad;
  - roles y permisos (middleware `requirePermission`);
  - CRUD de usuarios;
  - empresa y sucursal;
  - **conexión con API-PRO**: secretos cifrados de solo escritura, "Probar conexión" (`GET /empresa` + `GET /series`, sincroniza el espejo de series y la tasa de IGV) y modo simulación;
  - auditoría base.
- **Archivos:** `modules/auth|users|settings|audit`, `integrations/apiPro/client.ts|simulator.ts`, `features/auth|settings|users`.
- **Depende de:** fase 3.
- **Aceptación:**
  - un vendedor no puede llamar endpoints de administración (403);
  - el secret nunca sale del backend (comprobado en las respuestas);
  - "Probar conexión" muestra el RUC, el entorno y las series faltantes.
- **Pruebas:** unitarias de permisos, integración de login y CSRF, y de cifrado.
- **Riesgo:** credenciales beta inválidas (ferretería tuvo 401).
- **Resultado:** sistema seguro con conexión verificada.

### Fase 5. Catálogos e inventario · MVP
- **Funcionalidades:**
  - categorías, unidades, productos (paginación y búsqueda en el servidor, código de barras);
  - clientes (con `/buscar-documento`), proveedores;
  - compras con entrada al kardex;
  - ajustes, kardex, alertas de stock mínimo.
- **Archivos:** `modules/catalog|customers|suppliers|purchases|inventory` y sus features.
- **Depende de:** fase 4.
- **Aceptación:**
  - una compra aumenta el stock exactamente una vez, aunque se reenvíe la petición;
  - el kardex cuadra con el stock;
  - las validaciones de RUC y DNI funcionan.
- **Pruebas:** unitarias de `inventory.mover`, concurrencia (2 ajustes simultáneos), integración CRUD.
- **Riesgo:** el costo promedio (decidir el método, [P]).
- **Resultado:** datos maestros listos para vender.

### Fase 6. Ventas y caja básica · MVP
- **Funcionalidades:**
  - apertura y cierre de turno de caja (se necesita para cobrar);
  - POS completo (catálogo, carrito, unidades fraccionables, descuentos con permiso);
  - cobro con varios medios y vuelto;
  - `POST /ventas` transaccional e idempotente;
  - constancia de 80mm;
  - historial de ventas;
  - port de `Calculo.php` a `tax.ts` con las pruebas de ferretería.
- **Archivos:** `modules/sales|cash`, `shared/tax.ts`, `features/pos|cash`.
- **Depende de:** fase 5.
- **Aceptación:**
  - totales idénticos a los de ferretería en el conjunto de casos de prueba;
  - un doble envío no duplica la venta;
  - sin stock → 409 con un mensaje claro;
  - el cierre de caja cuadra por medio de pago.
- **Pruebas:** cálculo (tabla de casos con descuentos, decimales y exonerados), concurrencia (dos cajeros, último stock), E2E del POS.
- **Riesgo:** redondeos de IGV; ventas con el turno cerrado.
- **Resultado:** se puede vender y cobrar, con los comprobantes en `pendiente`.

### Fase 7. Integración SUNAT vía API-PRO · MVP
- **Funcionalidades:**
  - **pruebas de contrato primero**, contra beta: emitir una boleta de S/ 1.18 y una factura, leer el estado, descargar;
  - adaptador con normalizadores;
  - worker con outbox, reintentos, backoff y pausa ante 401, 403 o 429;
  - reconciliación por polling con presupuesto de rate limit;
  - pantalla Comprobantes (filtros, chips de estado, acciones según el estado);
  - proxy de PDF, XML y CDR con caché;
  - NC 01, 06 y 07 con devolución de stock;
  - anulación interna (comprobantes que nunca se emitieron);
  - RA y RC (al final de la fase o en E2).
- **Archivos:** `integrations/apiPro/*`, `modules/invoicing/*`, `workers/*`, `features/documents`.
- **Depende de:** fase 6 y credenciales beta válidas.
- **Aceptación:**
  - la boleta y la factura beta llegan a `aceptado`;
  - un timeout simulado no duplica (verificado en API-PRO por serie y correlativo);
  - un 422 queda en `error_validacion` con los errores visibles;
  - el PDF ticket-80 de una boleta sale en formato ticket (`format`);
  - nunca se llama a `/enviar` sobre `anulado` ni a `/estado` de RA o GRE.
- **Pruebas:** contrato (beta), integración con el simulador, inyección de fallos (timeout, 500, 409, 429, corte tras enviar), idempotencia.
- **Riesgos:** diferencias entre la API publicada y el código; la licencia en producción; el rate limit del plan free (30/min).
- **Resultado:** facturación electrónica de extremo a extremo en beta.

### Fase 8. Caja avanzada, dashboard y reportes · MVP (básico) / E2
- **Funcionalidades:**
  - **dashboard:** ventas de hoy y su variación, ticket promedio, comprobantes por estado, stock bajo, top de productos, ventas por medio de pago (todo de la BD local);
  - **reportes:** por fecha, producto, cliente, usuario, medio de pago, estado del CPE, kardex, compras y cierres;
  - exportación CSV o Excel;
  - egresos de caja.
- **Depende de:** fases 6 y 7.
- **Aceptación:** los totales de los reportes cuadran con las ventas y los cierres; las NC restan.
- **Pruebas:** consultas con datos semilla y rendimiento con 100 000 ventas.
- **Riesgo:** consultas lentas (se mitiga con índices y agregados).
- **Resultado:** gestión diaria completa.

### Fase 9. Pruebas y estabilización · MVP
- **Funcionalidades:** suites completas (§12), pruebas de carga del POS, auditoría de seguridad (dependencias, OWASP ZAP básico), revisión responsive en 360, 768 y 1280px.
- **Aceptación:** cobertura >80 % en `tax`, `inventory`, `sales` e `invoicing`; cero hallazgos críticos.
- **Resultado:** candidato a producción.

### Fase 10. Preparación para producción · MVP
- **Funcionalidades:**
  - build y despliegue (PM2 o servicio de Windows para la api y el worker, Nginx/Apache como proxy con HTTPS);
  - `.env` de producción, rotación de secretos;
  - respaldos mysqldump diarios con retención y prueba de restauración;
  - logs rotados y alerta de comprobantes atascados;
  - manual de usuario y de operación;
  - checklist del paso de beta a producción en API-PRO (licencia, `entorno: production`, series reales).
- **Aceptación:** restauración probada; primer comprobante real `aceptado`.
- **Riesgo:** la licencia de API-PRO y el certificado digital vencido.
- **Resultado:** sistema en producción.

### Etapa 2 y futuro
- **E2:** webhook firmado (requiere URL pública), notas de débito, venta a crédito con cuotas, multisucursal, roles editables, gráficos, Excel.
- **F:** guías de remisión, multiempresa, varios almacenes, lotes, ventas sin conexión.

---

## 12. Plan de pruebas

| Área | Caso prioritario | Resultado esperado | Nivel |
|---|---|---|---|
| Productos | Crear o editar con un código duplicado | 422 con el campo marcado | Local |
| Productos | Cambiar el precio después de vender | La venta histórica conserva su precio (instantánea) | Local |
| Clientes | RUC con dígito verificador inválido; DNI de 7 dígitos | Rechazado en el front y en el back | Local |
| Cálculo | Tabla de 30 casos: afectación 10/20/30, cantidades decimales, descuento global, redondeo | Igual al céntimo que `Calculo.php` y que los `totales` de la API | Local + API-PRO beta |
| Stock | Dos ventas simultáneas por la última unidad | Una sí y la otra 409 | Local (concurrencia) |
| Ventas | Reenviar `POST /ventas` con la misma clave | La misma venta, sin movimientos extra | Local |
| Pagos | Pago mixto efectivo + Yape; vuelto | SUM = total; el vuelto solo sobre el efectivo; la caja cuadra | Local |
| Emisión | Boleta S/ 1.18 y factura con RUC | `aceptado`, con XML y CDR descargables | **API-PRO beta + SUNAT beta** |
| Emisión | Boleta >S/ 700 sin documento | Bloqueo en el front; si pasa, 422 de la API → `error_validacion` | Local + API-PRO |
| Rechazo | Factura con un RUC inexistente o inválido | `error_validacion` o `rechazado` según quién lo detecte, con el mensaje visible | API-PRO beta |
| Observaciones | Forzar una observación (si se puede reproducir en beta) [P] | `observado`, con las notas visibles | SUNAT beta |
| Timeout | El simulador retrasa 40 s | `por_verificar`; el reintento con la misma key no duplica | Local (simulador) |
| Corte tras enviar | El proxy corta la respuesta después de que la API procesó | El reintento devuelve el replay (`Idempotency-Replayed`) | API-PRO local |
| Doble emisión | Dos workers o dos clics | Un solo POST a la API (log de intentos) | Local |
| Bugs B1 y B2 | El adaptador nunca llama a `/enviar` sobre `anulado` ni a `/estado` de RA | Prueba unitaria de las guardas | Local |
| Descargas | PDF ticket-80 de una boleta | Content-Type pdf con el ancho del ticket | API-PRO beta |
| NC | Devolución parcial 07 de 1 de 3 unidades; segunda NC que excede el saldo | Stock +1; la segunda NC se rechaza localmente | Local + API-PRO beta |
| Anulación | RA de una factura en ≤7 días; RC de una boleta | `anulado` tras la reconciliación | SUNAT beta |
| Permisos | Un vendedor intenta descuento, anulación o configuración | 403 y botón oculto | Local |
| BD | Caída de MySQL a mitad de una venta | Rollback completo, error 503 claro | Local |
| Red | API-PRO caída o 429 | La cola se pausa, el POS sigue vendiendo, aparece una alerta | Local (simulador) |
| Responsive | POS en 360px, tablet en 768px, escritorio en 1280px | Sin scroll horizontal; conmutador Productos/Venta | Local (Playwright) |
| Seguridad | SQLi en la búsqueda, XSS en el nombre del producto, CSRF ausente | Neutralizados | Local |

**Separación de niveles**
1. **Local:** unitarias, integración con la BD de prueba y el **simulador de API-PRO**; E2E con Playwright.
2. **Contra API-PRO local** (`http://api-pro.test`, con el worker activo): contrato, idempotencia y errores.
3. **Contra el entorno beta de SUNAT**, a través de API-PRO: aceptación, CDR, RA/RC y observaciones. Requiere certificado y credenciales beta, no se automatiza en la CI y sigue un checklist manual.

---

## 13. Riesgos y decisiones pendientes

**Riesgos**
| Riesgo | Impacto | Mitigación |
|---|---|---|
| Las credenciales de la API no son válidas (ferretería registra 401) | Bloquea la fase 7 | Regenerar el par en beta antes de la fase 7 (ojo con el bug B5: no usar el secret del panel) |
| La API publicada difiere del código local | Errores de contrato | Pruebas de contrato al inicio de la fase 7 y versión del adaptador |
| Bugs de API-PRO (B1, B2, B4, B8, B11) | Estados incorrectos o reenvíos indebidos | Guardas en el adaptador. **Recomiendo corregirlos en API-PRO** en un trabajo aparte |
| Rate limit del plan free (30 req/min) | Polling y descargas limitados | Presupuesto de polling, caché local de archivos, webhook en E2, plan pro |
| Worker o scheduler de API-PRO caídos | Comprobantes atascados en `enviado` | Alerta por antigüedad en `en_proceso` |
| Licencia de API-PRO en producción | No se puede emitir en producción | Validar la licencia antes de la fase 10 |
| Secretos en claro en la colección de Postman | Exposición de la clave SOL y del certificado | Rotar y convertirlos en variables |

**Decisiones que necesito de ti [P]**
1. **URL de API-PRO:** ¿desarrollo contra la instancia local `http://api-pro.test` o contra la publicada (`sunat.kodevo.es` o `apisunatv2.kodevo.es`)? ¿Con qué plan (rate limit)?
2. **Empresa:** ¿una sola empresa y sucursal en el MVP (recomendado) o varias sucursales desde el inicio?
3. **Login:** ¿usuario y contraseña (recomendado), PIN como en ferretería, o ambos (PIN rápido para cambiar de cajero)?
4. **Boletas:** ¿envío individual (recomendado, modo por defecto de la API) o por resumen diario?
5. **Alcance del MVP:** ¿incluir la caja (recomendado) y las compras? ¿Se necesitan guías de remisión, notas de débito, ventas a crédito con cuotas o en USD?
6. **Stock:** ¿permitir la venta con stock negativo? ¿Qué método de costo: promedio ponderado (recomendado) o último costo?
7. **Webhook:** ¿habrá una URL pública para recibirlo? Si no, solo polling.
8. **Corrección de API-PRO:** ¿quieres que, en paralelo y aparte, se corrijan B1, B2 y B4 en API-PRO? Este plan no lo modifica.
9. **TypeScript** en los dos lados (recomendado) o JavaScript.
10. **Nombre y logotipo** del sistema, para sustituir el icono de herramienta de ferretería.

---

## 14. MVP recomendado

- **Incluye:**
  - login con roles Admin, Cajero y Almacén;
  - empresa y una sucursal; conexión con API-PRO y modo simulación;
  - categorías, unidades y productos; clientes con búsqueda RUC/DNI; proveedores y compras simples;
  - kardex y ajustes;
  - turno de caja (apertura, cierre y arqueo);
  - POS con varios medios de pago y vuelto;
  - **boletas y facturas electrónicas** con reconciliación, reintentos seguros y PDF (ticket o A4), XML y CDR;
  - **NC** (01, 06, 07) con devolución de stock; anulación interna;
  - pantalla de comprobantes con atención de problemas;
  - dashboard básico; reportes de ventas, comprobantes y stock bajo con CSV;
  - auditoría de emisiones; respaldos.
- **Incluye también (decisión del 28-10):** varias sucursales; boletas en modo individual **o** por resumen diario; notas de débito; guía de remisión remitente (09); comunicación de baja (RA) y anulación de boletas por RC.
- **Excluye (E2 o futuro):** webhook, crédito y cuotas, USD, guía transportista (31), transferencias formales entre sucursales, gráficos avanzados.
- **Definición de "funcional":** en beta, un cajero abre caja, vende con boleta y con factura, cobra en efectivo y Yape, obtiene el comprobante `aceptado` con su PDF de ticket, emite una NC de devolución y cierra caja cuadrada. Todo sin duplicados ante fallos de red simulados.

---

## 15. Lista ordenada de tareas técnicas

1. Responder las decisiones de §13 y aprobar el plan.
2. Rotar las credenciales expuestas en la colección; obtener un par key/secret beta válido; crear la sucursal y las series F001, B001, FC01 y BC01 en API-PRO (o confirmar las existentes).
3. Confirmar que el worker y el scheduler de API-PRO están activos en el entorno de pruebas (`QUEUE_CONNECTION` distinto de `sync`).
4. Escribir el ER definitivo, el contrato OpenAPI interno y los ADRs.
5. Crear los prototipos de Login, Layout, POS, Cobro, Comprobantes y Caja.
6. Montar el monorepo (web, api, shared) con lint, format, test y scripts de desarrollo.
7. Configurar el entorno con zod, el logger, el manejador de errores, helmet y CORS.
8. Escribir las migraciones Knex del núcleo (empresa, sucursales, usuarios, roles, permisos, sesiones, configuración, auditoría).
9. Cargar las semillas: catálogos 03, 06, 07, 09 y 10, medios de pago, roles, usuario admin.
10. Pasar los tokens de diseño de ferretería a `tokens.css` (claro y oscuro), y armar el layout (menú, encabezado) y las rutas protegidas.
11. Construir la librería UI: Button, Field, MoneyInput, Dialog, Confirm, Toast, DataTable responsive, StatusChip, KpiCard, Tabs, EmptyState, Banner.
12. Implementar auth: login, logout, sesión, CSRF, rate limit, bloqueo, inactividad, `GET /me` con permisos.
13. Implementar usuarios y roles (CRUD) y el middleware de permisos.
14. Implementar la configuración de empresa y sucursal, los secretos cifrados (AES-256-GCM) y la pantalla de conexión con API-PRO.
15. Crear el adaptador `apiPro` (cliente, normalizadores, errores, binarios) y el simulador (port de ferretería); "Probar conexión" y sincronizar las series y la tasa de IGV.
16. Migraciones de catálogo: categorías, unidades, productos, stock, movimientos_stock.
17. Implementar `inventory.service.mover()` con FOR UPDATE e índice único por origen, más sus pruebas de concurrencia.
18. Implementar productos y categorías (API paginada y pantallas), clientes (con `/buscar-documento`) y proveedores.
19. Implementar compras y compra_items con entrada al kardex y costo promedio.
20. Implementar los ajustes de inventario y la vista de kardex y stock bajo.
21. Portar `Calculo.php` a `shared/tax.ts` y su tabla de casos de prueba.
22. Migraciones de ventas, ítems, pagos, medios de pago, cajas, turnos y movimientos de caja.
23. Implementar el turno de caja: apertura, cierre, arqueo.
24. Implementar `POST /ventas` transaccional e idempotente (venta, stock, caja, comprobante `pendiente`, outbox).
25. Construir el POS: catálogo con búsqueda o escaneo, carrito, unidades fraccionables, descuento con permiso, modal de cobro con varios medios de pago, constancia de 80mm.
26. Migraciones de facturación: comprobantes, comprobante_items, notas, anulaciones, integracion_intentos, outbox_trabajos, archivos_cpe.
27. Escribir el worker del outbox: tomar el trabajo (SKIP LOCKED), emitir con Idempotency-Key, clasificar la respuesta, programar reintentos y pausar ante 401, 403 o 429.
28. Implementar la reconciliación: polling con backoff y presupuesto; mapear los estados remotos a los locales; alertar de los atascados.
29. Pruebas de contrato contra beta: boleta S/ 1.18, factura, estados, descargas (con `format`).
30. Implementar la pantalla Comprobantes: filtros, chips, detalle con el historial de intentos, acciones según el estado (reintentar con las guardas B2, corregir con PUT, descargar).
31. Implementar el proxy de PDF, XML y CDR con caché local y permisos.
32. Implementar las NC 01, 06 y 07: validación del saldo, devolución de stock y caja, emisión.
33. Implementar la anulación interna de las ventas nunca emitidas.
34. Implementar RA (facturas) y RC con anulación (boletas), con su reconciliación sin `/estado` (B1).
35. Construir el dashboard con sus indicadores, y los reportes de ventas, comprobantes, stock, caja y compras con CSV.
36. Completar la auditoría de las acciones críticas y su visor básico.
37. Completar las suites: inyección de fallos, concurrencia, E2E con Playwright, responsive, seguridad.
38. Preparar el despliegue: build, PM2 o servicio para la api y el worker, proxy HTTPS, `.env` de producción.
39. Configurar respaldos automáticos con prueba de restauración, rotación de logs y alertas.
40. Pasar a producción en API-PRO (licencia, entorno, series reales), emitir el primer comprobante real y verificarlo con `consultar-cpe`.
41. Redactar los manuales de usuario y de operación, y cerrar el MVP. Planificar la E2 (webhook, ND, crédito, multisucursal).
