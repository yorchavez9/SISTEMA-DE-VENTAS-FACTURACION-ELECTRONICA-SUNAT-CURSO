# 03 · Contrato de la API interna (backend → React)

Estado: **propuesta para aprobación** (fase 2, paso 2). Se implementará con esquemas zod en `packages/shared/src/schemas` y se publicará como OpenAPI generado (`zod-to-openapi`) en la fase 3.

---

## 1. Convenciones generales

| Aspecto | Regla |
|---|---|
| Base | `/api` (mismo origen que la SPA; en desarrollo, el proxy de Vite → `http://localhost:4000`) |
| Formato | JSON UTF-8. Importes como **string decimal** (`"118.00"`) para no perder precisión en JS; cantidades también como string (`"2.500"`) |
| Fechas | `fecha` (DATE) como `YYYY-MM-DD` en hora de Lima; marcas de tiempo en ISO 8601 UTC (`2026-10-28T18:15:00.000Z`) |
| Sesión | Cookie `sid` (httpOnly). `GET /api/auth/csrf` entrega el token |
| Cabeceras de escritura | `X-CSRF-Token` (obligatoria en POST, PUT, PATCH y DELETE) · `X-Sucursal-Id` (sucursal activa) · `Idempotency-Key` (UUID v4; obligatoria donde se indica **[IK]**) |
| Paginación | `?page=1&pageSize=25&q=texto&sort=campo:asc|desc` → `{ data, page, pageSize, total }`, `pageSize` máximo 100 |
| Filtros de fecha | `?desde=YYYY-MM-DD&hasta=YYYY-MM-DD` |
| Permisos | Se indica `perm:` en cada endpoint; además, la sucursal debe estar asignada al usuario |

### Respuestas de error
```json
{ "error": "Stock insuficiente para 1 producto", "codigo": "STOCK_INSUFICIENTE",
  "campos": { "items.0.cantidad": "Disponible: 3" }, "detalle": { }, "requestId": "01J…" }
```

| HTTP | `codigo` (ejemplos) | Uso |
|---|---|---|
| 400 | `SOLICITUD_INVALIDA` | JSON mal formado |
| 401 | `NO_AUTENTICADO`, `SESION_EXPIRADA` | Sin sesión |
| 403 | `SIN_PERMISO`, `SUCURSAL_NO_PERMITIDA`, `CSRF_INVALIDO` | Autorización |
| 404 | `NO_ENCONTRADO` | |
| 409 | `STOCK_INSUFICIENTE`, `TURNO_NO_ABIERTO`, `ESTADO_NO_PERMITE`, `SALDO_NC_EXCEDIDO`, `IDEMPOTENCIA_EN_CURSO` | Conflictos de negocio |
| 422 | `VALIDACION` (con `campos`) | Datos inválidos |
| 423 | `BLOQUEADO` (usuario o PIN) | Bloqueos por intentos |
| 429 | `DEMASIADAS_SOLICITUDES` | Rate limit |
| 502 / 503 | `APIPRO_NO_DISPONIBLE`, `APIPRO_CREDENCIALES` | Solo en endpoints síncronos de consulta (probar conexión, buscar documento, descargas) |

### Idempotencia [IK]
- Se aplica a ventas, cobros, compras, ajustes, traslados, notas, bajas, resúmenes manuales, guías y operaciones de series.
- **Misma clave + mismo cuerpo** → la respuesta original (`200` con la cabecera `Idempotent-Replay: true`).
- **Misma clave + otro cuerpo** → `422 IDEMPOTENCIA_CUERPO_DISTINTO`.
- **Clave en curso** → `409 IDEMPOTENCIA_EN_CURSO`.

---

## 2. Autenticación, sesión y PIN

| Método | Ruta | perm | Entrada | Salida |
|---|---|---|---|---|
| GET | `/auth/csrf` | público | — | `{ csrfToken }` |
| POST | `/auth/login` | público (rate limit 5/min por IP+usuario) | `{ usuario, password, dispositivoToken? }` | `{ usuario, permisos[], sucursales[], sucursalActiva, debeCambiarPassword }` + cookie |
| POST | `/auth/logout` | sesión | — | 204 |
| GET | `/auth/me` | sesión | — | igual que login + `operador` (cajero activo por PIN) |
| POST | `/auth/sucursal` | sesión | `{ sucursalId }` | `{ sucursalActiva }` |
| POST | `/auth/password` | sesión | `{ actual, nueva }` | 204 |
| POST | `/auth/pin/cambiar-operador` | sesión + dispositivo registrado | `{ usuarioId, pin }` | `{ operador }` (cambia el cajero activo sin cerrar la sesión) |
| POST | `/auth/pin/autorizar` | sesión + dispositivo | `{ usuarioId, pin, accion: 'descuento'|'anular'|'abrir_cajon'|… }` | `{ autorizacionToken (un solo uso, 2 min), autorizadoPor }` |
| PUT | `/auth/pin` | sesión | `{ password, pinNuevo }` | 204 |

Las acciones que exigen la autorización de un supervisor reciben `autorizacionToken` en el cuerpo.

---

## 3. Administración

### Usuarios, roles y dispositivos
| Método | Ruta | perm |
|---|---|---|
| GET / POST | `/usuarios` | `usuarios.ver` / `usuarios.editar` |
| GET / PUT | `/usuarios/:id` | ídem (body: nombre, email, rolId, sucursalIds[], activo) |
| POST | `/usuarios/:id/restablecer-password` | `usuarios.editar` → `{ passwordTemporal }` (se muestra una sola vez) |
| POST | `/usuarios/:id/restablecer-pin` | `usuarios.editar` |
| GET | `/roles` · `/permisos` | `usuarios.ver` |
| GET / POST | `/dispositivos` | `config.editar` → POST devuelve `{ dispositivoToken }` una sola vez, para guardarlo en el navegador del POS |
| DELETE | `/dispositivos/:id` | `config.editar` (lo desactiva) |

### Empresa y conexión con API-PRO
| Método | Ruta | perm | Notas |
|---|---|---|---|
| GET | `/empresa` | `config.ver` | Datos locales; las llaves solo como `{ configurada: true, ultimos4: "…3Ma" }` |
| PUT | `/empresa` | `config.editar` | nombre comercial, datos del ticket, `modoEmision` |
| PUT | `/empresa/credenciales-api` | `config.editar` + `autorizacionToken` | `{ baseUrl, apiKey, apiSecret }`. Solo escritura; se cifran |
| POST | `/empresa/probar-conexion` | `config.ver` | Llama a `GET /empresa`, `GET /sucursales`, `GET /series` y `GET /sunat/estado` de API-PRO → `{ ok, ruc, razonSocial, entorno, tasaIgv, sunatDisponible, sucursalesApi[], seriesApi[], rateLimit, avisos[] }` |
| GET | `/estado-integracion` | sesión | `{ modoEmision, colaPausada, motivoPausa, pendientes, porVerificar, rechazados, sinRespuesta, ultimoContacto }` (para el chip del encabezado) |
| POST | `/estado-integracion/reanudar` | `config.editar` | Reanuda la cola pausada (401, 403 o 429 de cupo) |

### Sucursales
| Método | Ruta | perm | Notas |
|---|---|---|---|
| GET | `/sucursales` | sesión | Las asignadas al usuario (el admin ve todas) |
| POST | `/sucursales` | `sucursales.editar` [IK] | `{ nombre, codLocal, direccion, ubigeo, modoBoletas, horaResumen, crearEnApi: boolean }`. Con `crearEnApi`, llama a `POST /sucursales` de API-PRO y guarda `api_sucursal_id` |
| PUT | `/sucursales/:id` | `sucursales.editar` | Los datos locales, más `sincronizarApi` |
| POST | `/sucursales/:id/vincular` | `sucursales.editar` | `{ apiSucursalId }`: vincula con una sucursal existente de API-PRO |

### Series (con advertencias, plan §0.10-c)
| Método | Ruta | perm | Notas |
|---|---|---|---|
| GET | `/series` | `series.ver` | `?sucursalId&tipoDoc` → `[ { id, serie, tipoDoc, aplicaA, propia, activo, ultimoCorrelativo, sucursal, predeterminada, externa: !propia } ]` |
| POST | `/series/sincronizar` | `series.ver` | Refresca el espejo desde `GET /series` de API-PRO |
| POST | `/series/validar` | `series.administrar` | `{ operacion: 'crear'|'correlativo'|'mover'|'desactivar', … }` → `{ permitido, bloqueos[], advertencias[], confirmacionRequerida: "B101" }` (**previsualización sin efectos**) |
| POST | `/series` | `series.administrar` [IK] | `{ tipoDoc, serie, aplicaA?, sucursalId, correlativoInicial?, confirmacion }` → crea en API-PRO y en el espejo (`propia=1`) |
| PATCH | `/series/:id` | `series.administrar` [IK] | `{ correlativo? | sucursalId? | activo? | predeterminada?, confirmacion }`. Vuelve a aplicar las reglas de `/validar`; las series externas exigen `confirmacionReforzada` |

`confirmacion` debe ser igual al nombre de la serie (p. ej. `"B101"`). Si no coincide → 422.

### Tipos de cambio y configuración
| Método | Ruta | perm |
|---|---|---|
| GET | `/tipos-cambio?desde&hasta` · `/tipos-cambio/hoy` | sesión |
| PUT | `/tipos-cambio/:fecha` | `tipocambio.editar` (`{ compra, venta }`) |
| GET / PUT | `/configuracion` | `config.ver` / `config.editar` (ajustes tipados: ticket, inactividad, crédito, alertas) |
| GET / PUT | `/configuracion/consulta-documentos` | `config.ver` / `config.editar` · json.pe y MIGO para DNI/RUC: `{ principal, proveedores: [{ codigo, activo, token?, quitarToken? }] }`. El token se guarda cifrado (APP_ENC_KEY) y solo sale enmascarado (`••••1234`); no se activa uno sin token (422). 5/min |
| POST | `/configuracion/consulta-documentos/probar` | `config.editar` · `{ codigo, tipoDoc: "1"|"6", numDoc }` con el token guardado → `{ resultado: encontrado|no_encontrado|error, razonSocial, direccion, mensaje, duracionMs }`. Gasta una consulta del plan. 4/min |

---

## 4. Catálogo, terceros e inventario

| Método | Ruta | perm | Notas |
|---|---|---|---|
| GET / POST | `/categorias` · PUT `/categorias/:id` | `productos.ver` / `productos.editar` | |
| GET | `/unidades` | sesión | Catálogo 03 + `fraccionable` |
| GET | `/productos` | `productos.ver` | `?q&categoriaId&activo&stockBajo&sucursalId` → incluye `stock` de la sucursal |
| GET | `/productos/buscar-pos` | `ventas.crear` | `?q` (nombre, código o barras; coincidencia exacta primero), máximo 30, respuesta ligera para el POS |
| POST / PUT | `/productos` · `/productos/:id` | `productos.editar` | `{ codigo, codigoBarras?, nombre, categoriaId, unidadId, tipo, inventariable, tipAfeIgv, codProductoSunat?, precioVenta, precioVentaUsd?, stockMinimo, pesoKg? }` |
| PATCH | `/productos/:id/estado` | `productos.editar` | `{ activo }` |
| GET / POST / PUT | `/clientes` · `/clientes/:id` | `clientes.ver` / `clientes.editar` | `{ tipoDoc, numDoc, razonSocial, direccion?, email?, telefono?, limiteCredito?, monedaCredito? }` |
| GET | `/clientes/buscar?tipoDoc&numDoc` | `ventas.crear` | Primero la BD local; si no existe y es DNI/RUC → json.pe / MIGO activos, el principal primero (si uno no lo encuentra o falla, el siguiente) y de respaldo `GET /buscar-documento` de API-PRO. No crea el cliente → `ResultadoBusquedaDocumento` (`origen: local|externo|no_encontrado`, `fuente`, `avisos`) |
| GET | `/clientes/:id/estado-cuenta` | `cxc.ver` | Cuotas, vencidos, límite disponible |
| GET / POST / PUT | `/proveedores` · `/proveedores/:id` | `proveedores.ver` / `proveedores.editar` | |
| GET / POST | `/compras` | `compras.ver` / `compras.crear` [IK] | `{ proveedorId, tipoDocCompra, serieNumero, fecha, moneda, tipoCambio?, items:[{productoId, cantidad, costoUnitario}] }` |
| POST | `/compras/:id/anular` | `compras.anular` [IK] | Revierte el stock (409 si dejaría stock negativo) |
| GET | `/inventario/stock` | `inventario.ver` | `?sucursalId&q&soloBajo` |
| GET | `/inventario/kardex/:productoId` | `inventario.ver` | `?sucursalId&desde&hasta` |
| POST | `/inventario/ajustes` | `inventario.ajustar` [IK] | `{ motivo, items:[{productoId, cantidad (+/-)}] }` |
| POST | `/inventario/traslados` | `inventario.trasladar` [IK] | `{ sucursalDestinoId, items[], generarGuia: boolean }` |
| POST | `/inventario/traslados/:id/recibir` | `inventario.trasladar` [IK] | |

---

## 5. Caja

| Método | Ruta | perm | Notas |
|---|---|---|---|
| GET | `/cajas` | `caja.ver` | De la sucursal activa, con el turno abierto si lo hay |
| GET | `/turnos/actual?cajaId` | `caja.ver` | `{ turno, saldos:[{moneda, inicial, esperado}] }` |
| POST | `/turnos/abrir` | `caja.abrir` [IK] | `{ cajaId, saldosIniciales:[{moneda, monto}] }` |
| POST | `/turnos/:id/movimientos` | `caja.movimientos` [IK] | `{ tipo: 'ingreso'|'egreso', metodoPagoId, moneda, monto, concepto }` |
| GET | `/turnos/:id/resumen` | `caja.ver` | Totales por método y moneda, ventas, cobros, devoluciones |
| POST | `/turnos/:id/cerrar` | `caja.cerrar` [IK] | `{ contado:[{moneda, monto}] }` → `{ diferencias[] }` |
| GET | `/metodos-pago` | sesión | |

---

## 6. Ventas (POS)

### `POST /ventas/cotizar`, perm `ventas.crear` (sin efectos)
Calcula en el servidor para mostrar los totales oficiales antes de cobrar.
```json
{ "moneda": "PEN", "items": [ { "productoId": 15, "cantidad": "2" } ],
  "descuento": { "tipo": "monto|porcentaje", "valor": "5.00" } }
```
→ `{ items:[{…, precioUnitario, igv, total}], opGravada, opExonerada, opInafecta, igv, descuento, total, tipoCambio, avisos[] }`

### `POST /ventas`, perm `ventas.crear` [IK, la clave de la venta]
```json
{
  "cajaId": 3,
  "tipoComprobante": "03",
  "serieId": 21,
  "modoBoleta": "resumen",
  "moneda": "USD",
  "cliente": { "id": 88 } ,
  "items": [ { "productoId": 15, "cantidad": "2" } ],
  "descuento": { "tipo": "porcentaje", "valor": "5", "motivo": "Cliente frecuente", "autorizacionToken": "…" },
  "formaPago": "credito",
  "pagos": [ { "metodoPagoId": 1, "moneda": "PEN", "monto": "50.00", "montoRecibido": "100.00" } ],
  "cuotas": [ { "monto": "60.00", "fechaVencimiento": "2026-11-28" }, { "monto": "60.00", "fechaVencimiento": "2026-12-28" } ]
}
```
- `cliente` puede ser `{ id }`, `{ nuevo: {…} }` o `null` (clientes varios; solo boleta con un equivalente ≤ S/ 700).
- `modoBoleta` es opcional; si no viene, se toma el de la sucursal. Cambiarlo exige `boletas.elegir_modo`.
- Al crédito, `pagos` es la cuota inicial (opcional) y la suma de `cuotas` + la inicial = total. Exige `ventas.credito` y valida el límite y los vencidos (S-3).

**Validaciones del servidor:**
- turno abierto;
- serie propia, activa y de la sucursal;
- stock (409 `STOCK_INSUFICIENTE` con el detalle);
- RUC válido para factura;
- regla de los S/ 700;
- el tipo de cambio del día existe si moneda = USD o si algún pago es en otra moneda;
- suma de pagos y cuotas.

**Respuesta 201:**
```json
{ "venta": { "id": 1201, "total": "120.00", "moneda": "USD", "vuelto": { "moneda": "PEN", "monto": "50.00" } },
  "comprobante": { "id": 3301, "tipoDoc": "03", "serie": "B101", "estado": "pendiente", "modoEnvio": "resumen" },
  "constanciaUrl": "/api/ventas/1201/constancia" }
```

### Otros endpoints de ventas
| Método | Ruta | perm | Notas |
|---|---|---|---|
| GET | `/ventas` | `ventas.ver` | `?desde&hasta&sucursalId&usuarioId&clienteId&estado&formaPago` |
| GET | `/ventas/:id` | `ventas.ver` | Venta + ítems + pagos + comprobantes + cxc |
| GET | `/ventas/:id/constancia` | `ventas.ver` | Datos para el ticket interno de 80mm (lo imprime el navegador) |
| POST | `/ventas/:id/anular-interna` | `ventas.anular` + autorización [IK] | Solo si ningún comprobante se creó en la API (`api_id` NULL o `error_validacion`); revierte el stock, la caja y la cxc |

---

## 7. Cuentas por cobrar

| Método | Ruta | perm | Notas |
|---|---|---|---|
| GET | `/cxc` | `cxc.ver` | `?clienteId&estado&vencidas&moneda` |
| GET | `/cxc/antiguedad` | `cxc.ver` | Antigüedad de la deuda (0-30, 31-60, 61-90, >90), por moneda |
| POST | `/cobros` | `cxc.cobrar` [IK] | `{ clienteId, cajaId, metodoPagoId, moneda, monto, aplicaciones:[{cuotaId, monto}]? }`. Sin `aplicaciones`, se paga de la cuota más antigua a la más nueva |
| POST | `/cobros/:id/anular` | `cxc.anular` + autorización [IK] | |
| GET | `/cobros/:id/constancia` | `cxc.ver` | |

---

## 8. Comprobantes electrónicos

| Método | Ruta | perm | Notas |
|---|---|---|---|
| GET | `/comprobantes` | `comprobantes.ver` | `?desde&hasta&sucursalId&tipoDoc&estado&serie&q&atencion=true` |
| GET | `/comprobantes/:id` | `comprobantes.ver` | Con ítems, cuotas, notas relacionadas, `acciones[]` (las permitidas según el estado) y `intentos[]` |
| GET | `/comprobantes/:id/estado` | `comprobantes.ver` | Estado local (el POS consulta cada 3 s, sin llamar a API-PRO) |
| POST | `/comprobantes/:id/reintentar` | `comprobantes.emitir` [IK] | Solo en `por_verificar`, `sin_respuesta_sunat` o `rechazado` (con las guardas B2) |
| PUT | `/comprobantes/:id/corregir` | `comprobantes.corregir` [IK] | Solo en `error_validacion` o `rechazado`: `{ cliente?: {…} }` (los datos del cliente; los ítems y montos no cambian). Genera una Idempotency-Key nueva y usa POST o PUT según exista `api_id` |
| POST | `/comprobantes/:id/consultar` | `comprobantes.emitir` | Fuerza la reconciliación inmediata (consume el presupuesto de API) |
| GET | `/comprobantes/:id/pdf?formato=a4|a5|ticket-80|ticket-58` | `comprobantes.ver` | Proxy con caché (internamente se usa `format=`) |
| GET | `/comprobantes/:id/xml` · `/cdr` | `comprobantes.ver` | `application/xml` · `application/zip` |
| GET | `/comprobantes/atencion` | `comprobantes.ver` | Contadores por estado problemático (dashboard y chip) |

**`acciones[]` según el estado:**
| Estado | Acciones |
|---|---|
| `pendiente` | (ninguna, en cola) |
| `por_verificar`, `sin_respuesta_sunat` | reintentar, consultar |
| `error_validacion` | corregir, anular_interna |
| `rechazado` | corregir, reintentar, anular_interna |
| `pendiente_resumen` | pdf, enviar_individual (fuera del RC) |
| `aceptado` / `observado` | pdf, xml, cdr, nota_credito, nota_debito, anular (si ≤7 días y no tiene NC) |
| `anulacion_en_proceso` | pdf, consultar |
| `anulado` | pdf, xml, cdr |

---

## 9. Notas de crédito y débito

| Método | Ruta | perm | Notas |
|---|---|---|---|
| GET | `/notas/motivos?tipo=07|08` | sesión | Catálogo 09/10 **filtrado por lo que admite API-PRO** (sin NC 13) |
| GET | `/comprobantes/:id/saldo-nc` | `notas.crear` | Lo que aún se puede acreditar, por línea y en total |
| POST | `/notas-credito` | `notas.crear` [IK] | `{ comprobanteAfectadoId, codMotivo, desMotivo, serieId, items?:[{comprobanteItemId, cantidad}], devuelveStock, reintegro: { cajaId, metodoPagoId, moneda } | { aplicarACxc: true } | null }` |
| POST | `/notas-debito` | `notas.crear` [IK] | `{ comprobanteAfectadoId?, codMotivo, desMotivo, serieId, items:[{descripcion, cantidad, precioUnitario, tipAfeIgv}], cobro?: {...} | { aCxc: true } }` |

Las notas se crean como `comprobantes` (07/08) y siguen el mismo ciclo de emisión y estados.

---

## 10. Anulaciones

| Método | Ruta | perm | Notas |
|---|---|---|---|
| POST | `/anulaciones/validar` | `comprobantes.anular` | `{ comprobanteIds[] }` → `{ mecanismo: 'RA'|'RC'|'NC', permitido, bloqueos[], plazoHasta }` |
| POST | `/anulaciones` | `comprobantes.anular` + autorización [IK] | `{ comprobanteIds[], motivo }`. Agrupa en una RA (01/07/08) o en un RC de anulación (03) según el tipo |
| GET | `/anulaciones` · `/anulaciones/:id` | `comprobantes.ver` | Bajas y RC de anulación con su estado |

---

## 11. Resumen diario de boletas

| Método | Ruta | perm | Notas |
|---|---|---|---|
| GET | `/resumenes/pendientes?fecha&sucursalId` | `resumenes.ver` | Boletas `pendiente_resumen` por fecha, con el plazo restante |
| POST | `/resumenes/verificar` | `resumenes.enviar` | `{ fecha }` → hace la comprobación previa en API-PRO → `{ propias:n, ajenas:[{serie, correlativo}], puedeEnviar }` |
| POST | `/resumenes` | `resumenes.enviar` [IK] | `{ fecha }`. Repite la verificación y, si está limpia, encola `enviar_resumen`. Si hay ajenas → 409 `RESUMEN_BLOQUEADO_BOLETAS_AJENAS` |
| POST | `/resumenes/enviar-individual` | `resumenes.enviar` [IK] | `{ comprobanteIds[] }`. Respaldo: envía las boletas propias por `POST /boletas/{id}/enviar` |
| GET | `/resumenes` · `/resumenes/:id` | `resumenes.ver` | Con `documentosApi`, la conciliación y los incidentes |

El job programado ejecuta la misma lógica para cada sucursal a su `hora_resumen`.

---

## 12. Guías de remisión remitente (09)

| Método | Ruta | perm | Notas |
|---|---|---|---|
| GET | `/transportistas`, `/vehiculos`, `/conductores` | `guias.ver` | Datos maestros (la guía guarda una copia) |
| POST / PUT | `/transportistas[/:id]`, `/vehiculos[/:id]`, `/conductores[/:id]` | `guias.maestros` | Placa sin guion (6–8), RUC con dígito verificador, licencia en mayúsculas. 409 si se duplica |
| GET | `/ubigeos/regiones` · `/ubigeos/provincias?region=` · `/ubigeos/distritos?provincia=` | `guias.ver` | Caché local de `GET /catalogos/ubigeo/*`: API-PRO se consulta solo la primera vez |
| GET | `/guias/motivos` · `/guias/series` | `guias.ver` · `guias.crear` | Motivos del Cat. 20 que ofrece el sistema (01, 14, 02, 04, 06) y series **propias** T### de la sucursal activa |
| GET | `/guias/borrador?comprobanteId=` · `?trasladoId=` | `guias.crear` | Sin efectos. Desde una venta: destinatario, llegada y bienes (sin servicios). Desde un traslado: motivo 04, destinatario = la empresa, llegada = sucursal destino. Avisa si ya hay guías vigentes |
| POST | `/guias` | `guias.crear` [IK] | `{ serieId?, origen{tipo: venta|traslado|manual}, destinatario, codTraslado, modTraslado, vehiculoM1l, fechaTraslado, fechaEntregaTransportista?, pesoTotal, numBultos?, partida, llegada, transportistaId? | (vehiculoId + conductoresIds[])?, items[] }`. Reglas de API-PRO validadas antes de encolar: transporte público exige transportista ≠ empresa y fecha de entrega; privado exige vehículo y conductor (salvo M1/L); destinatario según motivo. La guía **no mueve stock** |
| GET | `/guias` · `/guias/:id` | `guias.ver` | Filtros `desde`, `hasta`, `estado`, `q`. El detalle trae `acciones` |
| PUT | `/guias/:id` | `guias.crear` | Corregir: `error_validacion` → clave nueva y nueva emisión; `rechazado` → `PUT /guias-remision/{id}` con el payload completo (solo si el estado remoto lo permite, guarda B2) |
| POST | `/guias/:id/reintentar` · `/consultar` | `guias.crear` · `guias.ver` | Reintento con la misma clave, o `POST /guias-remision/{id}/enviar` si está rechazada o sin respuesta |
| GET | `/guias/:id/pdf?formato=` · `/xml` · `/cdr` | `guias.ver` | Proxy con caché cuando está aceptada |

Seguimiento: el worker lee `GET /guias-remision/{id}` con espera creciente; **nunca** `/guias-remision/{id}/estado` (bug B1). Si se agota la tabla de esperas, queda `sin_respuesta_sunat` y se consulta a pedido.

---

## 13. Dashboard, reportes y auditoría

| Método | Ruta | perm | Salida |
|---|---|---|---|
| GET | `/dashboard?sucursalId` | `dashboard.ver` | Por defecto la sucursal activa. `{ ventas:{totalPen, n, ticketPromedio, variacion (vs. mismo día de la semana pasada), porMoneda[]}, porMetodo[], comprobantes{aceptadosHoy, pendientes, enProceso, porVerificar, problemas, pendienteResumen}, stockBajo[], topProductos[] (7 días), cxcVencida[], serieDiaria[] (14 días), guiasPendientes }` |
| GET | `/reportes/ventas` | `reportes.ver` | `?agrupar=dia|producto|cliente|usuario|metodo|sucursal&desde&hasta&moneda&sucursalId&formato=json|csv`. Ventas netas: NC restan y ND suman, atribuidas a la venta que modifican; "metodo" es el dinero de caja (incluye egresos y devoluciones) |
| GET | `/reportes/comprobantes` | `reportes.ver` | Por estado y tipo (las NC restan) |
| GET | `/reportes/inventario` | `reportes.ver` | Valorizado y movimientos |
| GET | `/reportes/compras` | `reportes.ver` | Por proveedor |
| GET | `/reportes/caja` | `reportes.ver` | Cierres y diferencias |
| GET | `/reportes/cxc` | `reportes.ver` | Cartera y antigüedad |
| GET | `/auditoria` | `auditoria.ver` | `?entidad&entidadId&usuarioId&accion&desde&hasta` |
| GET | `/integracion/intentos` | `auditoria.ver` | `?entidadTipo&entidadId&soloErrores` |

Todos los reportes devuelven `{ titulo, subtitulo, columnas[{clave, titulo, tipo}], filas[], totales[] (por moneda), notas[] }`; con `formato=csv` se descarga un CSV UTF-8 con BOM (abre directo en Excel). Rango máximo de un año. Las fechas se agrupan por día de Lima (UTC−5).

---

## 14. Catálogo de permisos (semilla)

| Grupo | Permisos | admin | supervisor | cajero | almacen |
|---|---|:-:|:-:|:-:|:-:|
| Dashboard | `dashboard.ver` | ✓ | ✓ | ✓ | ✓ |
| Ventas | `ventas.crear`, `ventas.ver` | ✓ | ✓ | ✓ | |
| | `ventas.credito`, `ventas.descuento`, `ventas.anular`, `boletas.elegir_modo` | ✓ | ✓ | | |
| Caja | `caja.ver`, `caja.abrir`, `caja.cerrar`, `caja.movimientos` | ✓ | ✓ | ✓ | |
| CxC | `cxc.ver`, `cxc.cobrar` | ✓ | ✓ | ✓ | |
| | `cxc.anular` | ✓ | ✓ | | |
| Comprobantes | `comprobantes.ver`, `comprobantes.emitir` | ✓ | ✓ | ✓ | |
| | `comprobantes.corregir`, `comprobantes.anular`, `notas.crear` | ✓ | ✓ | | |
| Resumen | `resumenes.ver`, `resumenes.enviar` | ✓ | ✓ | | |
| Guías | `guias.ver`, `guias.crear`, `guias.maestros` | ✓ | ✓ | | ✓ |
| Catálogo | `productos.ver`, `clientes.ver`, `proveedores.ver` | ✓ | ✓ | ✓ | ✓ |
| | `productos.editar`, `proveedores.editar` | ✓ | ✓ | | ✓ |
| | `clientes.editar` | ✓ | ✓ | ✓ | |
| Inventario y compras | `inventario.ver` | ✓ | ✓ | ✓ | ✓ |
| | `inventario.ajustar`, `inventario.trasladar`, `compras.ver`, `compras.crear` | ✓ | ✓ | | ✓ |
| | `compras.anular` | ✓ | ✓ | | |
| Reportes | `reportes.ver` | ✓ | ✓ | | |
| Administración | `usuarios.*`, `config.*`, `sucursales.editar`, `series.administrar`, `tipocambio.editar`, `auditoria.ver` | ✓ | `tipocambio.editar`, `series.ver` | | |

En el MVP los roles son fijos; los roles editables pasan a la 2.ª etapa.
