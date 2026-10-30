# 02 · Modelo de datos (MySQL 8)

Estado: **propuesta para aprobación** (fase 2, paso 1).

**Convenciones**
- InnoDB, `utf8mb4_0900_ai_ci`.
- PK `id BIGINT UNSIGNED AUTO_INCREMENT` salvo que se indique otra cosa.
- `created_at` y `updated_at DATETIME(3)` en UTC en todas las tablas (se omiten abajo).
- **Tipos:**
  - `MONEY` = `DECIMAL(14,2)`; `PRICE` = `DECIMAL(16,6)`; `QTY` = `DECIMAL(14,3)`; `RATE` = `DECIMAL(10,4)` (tipo de cambio);
  - `MON` = `CHAR(3)` con CHECK `IN ('PEN','USD')`.
- **Borrado:** nunca físico en datos de negocio; se usa `activo TINYINT(1)` o un estado.
- **Instantánea** = una copia de los datos en el momento de la operación (no se vuelve a leer del maestro).

---

## 1. Diagrama de relaciones (resumen)

```
empresa 1─N sucursales 1─N series(espejo API)
   │            │ 1─N cajas 1─N turnos_caja 1─N movimientos_caja
   │            │ 1─N stock N─1 productos N─1 categorias / unidades
   │            │ 1─N movimientos_stock (kardex)
usuarios N─M sucursales (usuario_sucursales) · usuarios N─1 roles N─M permisos
dispositivos N─1 sucursales

clientes 1─N ventas 1─N venta_items
                │ 1─N pagos ─────────────► movimientos_caja
                │ 1─1 cuentas_por_cobrar 1─N cuotas 1─N cobro_aplicaciones N─1 cobros
                │ 1─N comprobantes (01/03 de la venta; 07/08 que la afectan)
comprobantes 1─N comprobante_items
comprobantes 1─1 notas (si es 07/08) ─► comprobante_afectado
comprobantes N─M resumenes (resumen_documentos) · N─M bajas (baja_documentos)
comprobantes 1─N integracion_intentos · 1─N archivos_cpe
proveedores 1─N compras 1─N compra_items
guias 1─N guia_items · guias N─1 (venta | traslado) · N─1 transportistas/vehiculos/conductores
outbox_trabajos ─► (comprobante | resumen | baja | guia)
auditoria (independiente, solo inserción)
```

---

## 2. Empresa, sucursales, series y configuración

### `empresa` (1 fila)
| Campo | Tipo | Notas |
|---|---|---|
| ruc | CHAR(11) UNIQUE | 20161515648 (se lee de `GET /empresa`) |
| razon_social, nombre_comercial | VARCHAR(255) | |
| direccion_fiscal | VARCHAR(255) | |
| tasa_igv | DECIMAL(5,2) | Caché de `tasa_igv_vigente` (18.00); **no se fija en el código** |
| tax_regime | VARCHAR(20) | Caché |
| apipro_base_url | VARCHAR(255) | |
| apipro_key_enc, apipro_secret_enc | VARBINARY(512) | AES-256-GCM (iv+tag+cifrado). En desarrollo pueden ir vacías y se usa `.env` |
| apipro_entorno | ENUM('beta','production') | Caché de solo lectura |
| modo_emision | ENUM('simulacion','real') | Por defecto `simulacion` |
| conexion_verificada_en | DATETIME NULL | |

### `sucursales`
| Campo | Tipo | Notas |
|---|---|---|
| nombre | VARCHAR(120) | |
| cod_local | CHAR(4) | UNIQUE. Igual al de API-PRO |
| api_sucursal_id | BIGINT NULL UNIQUE | id en API-PRO |
| direccion, ubigeo CHAR(6), telefono | | |
| modo_boletas | ENUM('individual','resumen') | Modo por defecto de la sucursal |
| hora_resumen | TIME | p. ej. 23:00 (hora de Lima) |
| activo | TINYINT(1) | |

### `series` (espejo de API-PRO)
| Campo | Tipo | Notas |
|---|---|---|
| api_serie_id | BIGINT UNIQUE | |
| sucursal_id | FK sucursales NULL | NULL si la sucursal de API-PRO no está mapeada |
| tipo_doc | CHAR(2) | 01, 03, 07, 08, 09 |
| serie | CHAR(4) | UNIQUE(tipo_doc, serie) |
| aplica_a | ENUM('F','B') NULL | Para 07/08: sobre facturas o boletas |
| propia | TINYINT(1) | 1 = creada por este sistema; **solo las propias se usan en el POS** |
| ultimo_correlativo | INT | Solo informativo (sincronizado); **no es un contador** |
| activo | TINYINT(1) | |
| sincronizado_en | DATETIME | |
| predeterminada | TINYINT(1) | Una por (sucursal_id, tipo_doc, aplica_a), garantizada por un UNIQUE sobre una columna generada |

### `tipos_cambio`
| fecha DATE UNIQUE | compra RATE | venta RATE | fuente ENUM('manual') | usuario_id |

### `configuracion`
| clave VARCHAR(80) PK | valor JSON | Solo ajustes no sensibles y tipados por esquema zod (ticket, inactividad, crédito…) |

---

## 3. Seguridad y acceso

| Tabla | Campos | Restricciones |
|---|---|---|
| `roles` | codigo UNIQUE, nombre, sistema TINYINT | Semilla: admin, supervisor, cajero, almacen |
| `permisos` | codigo UNIQUE (p. ej. `ventas.crear`), descripcion, grupo | Semilla fija |
| `rol_permisos` | rol_id, permiso_id | PK compuesta |
| `usuarios` | usuario UNIQUE, nombre, email NULL, password_hash, pin_hash NULL, rol_id, activo, intentos_fallidos, bloqueado_hasta, pin_intentos, pin_bloqueado_hasta, debe_cambiar_password | FK rol |
| `usuario_sucursales` | usuario_id, sucursal_id | PK compuesta |
| `dispositivos` | sucursal_id, nombre, token_hash UNIQUE, activo, ultimo_uso | Terminales del POS habilitadas para PIN |
| `sesiones` | id CHAR(64) PK (hash), usuario_id, operador_id (cajero activo por PIN), dispositivo_id NULL, sucursal_id, csrf_token, expira_en, ultimo_uso, ip, user_agent | Índice (usuario_id), (expira_en) |

---

## 4. Catálogo e inventario

| Tabla | Campos principales | Restricciones |
|---|---|---|
| `categorias` | nombre UNIQUE, activo | |
| `unidades` | codigo_sunat CHAR(3) UNIQUE (Cat. 03), nombre, fraccionable | Semilla: NIU, ZZ, KGM, MTR, LTR, GLL, BX, PK, DZN, SET… |
| `productos` | codigo VARCHAR(30) UNIQUE, codigo_barras VARCHAR(50) UNIQUE NULL, nombre, descripcion, categoria_id, unidad_id, tipo ENUM('bien','servicio'), inventariable, tip_afe_igv CHAR(2) (Cat. 07), cod_producto_sunat CHAR(8) NULL, precio_venta PRICE (PEN, con IGV), precio_venta_usd PRICE NULL, costo_promedio PRICE, stock_minimo QTY, peso_kg DECIMAL(10,3) NULL (para la guía), activo | CHECK precio ≥ 0; FULLTEXT(nombre, descripcion) |
| `stock` | producto_id, sucursal_id, cantidad QTY | PK(producto_id, sucursal_id); **CHECK (cantidad >= 0)** |
| `movimientos_stock` | producto_id, sucursal_id, tipo ENUM('compra','venta','devolucion_nc','anulacion','ajuste_entrada','ajuste_salida','traslado_salida','traslado_entrada','anulacion_compra'), cantidad QTY (con signo), costo_unitario PRICE, stock_resultante QTY, origen_tipo VARCHAR(30), origen_id BIGINT, usuario_id, nota, fecha DATETIME | **UNIQUE(origen_tipo, origen_id, producto_id, tipo)**; índice (producto_id, sucursal_id, fecha) |
| `ajustes_inventario` | sucursal_id, usuario_id, motivo, fecha, idempotency_key UNIQUE | Cabecera de los ajustes (origen del kardex) |
| `ajuste_items` | ajuste_id, producto_id, cantidad QTY (con signo) | |
| `traslados` | sucursal_origen_id, sucursal_destino_id, estado ENUM('enviado','recibido','anulado'), guia_id NULL, idempotency_key UNIQUE | MVP: salida + entrada enlazadas |
| `traslado_items` | traslado_id, producto_id, cantidad | |

---

## 5. Terceros y compras

| Tabla | Campos principales | Restricciones |
|---|---|---|
| `clientes` | tipo_doc CHAR(1) (Cat. 06: 0,1,4,6,7,A), num_doc VARCHAR(15), razon_social, direccion, ubigeo NULL, email, telefono, limite_credito MONEY NULL, moneda_credito MON NULL, activo | UNIQUE(tipo_doc, num_doc) |
| `proveedores` | tipo_doc, num_doc, razon_social, direccion, contacto, telefono, email, activo | UNIQUE(tipo_doc, num_doc) |
| `compras` | proveedor_id, sucursal_id, tipo_doc_compra CHAR(2), serie_numero VARCHAR(20), fecha DATE, moneda MON, tipo_cambio RATE, subtotal, igv, total MONEY, estado ENUM('registrada','anulada'), usuario_id, idempotency_key UNIQUE | UNIQUE(proveedor_id, tipo_doc_compra, serie_numero) |
| `compra_items` | compra_id, producto_id, cantidad QTY, costo_unitario PRICE, total MONEY | |

Una compra es un **registro interno**: no se emite ningún comprobante electrónico propio.

---

## 6. Caja

| Tabla | Campos principales | Restricciones |
|---|---|---|
| `metodos_pago` | codigo UNIQUE, nombre, tipo ENUM('efectivo','tarjeta','billetera','transferencia','otro'), requiere_referencia, activo | Semilla: EFECTIVO, TARJETA, YAPE, PLIN, TRANSFERENCIA |
| `cajas` | sucursal_id, nombre, activo | |
| `turnos_caja` | caja_id, usuario_apertura_id, abierto_en, usuario_cierre_id, cerrado_en, estado ENUM('abierto','cerrado'), abierto_flag TINYINT AS (IF(estado='abierto',1,NULL)) | **UNIQUE(caja_id, abierto_flag)**: un solo turno abierto por caja |
| `turno_saldos` | turno_id, moneda MON, monto_inicial, esperado, contado, diferencia MONEY | PK(turno_id, moneda) |
| `movimientos_caja` | turno_id, tipo ENUM('venta','cobro','ingreso','egreso','devolucion','vuelto'), metodo_pago_id, moneda MON, monto MONEY (con signo), concepto, origen_tipo, origen_id, usuario_id | **UNIQUE(origen_tipo, origen_id, metodo_pago_id, tipo)** |

---

## 7. Ventas y cuentas por cobrar

### `ventas`
| Campo | Tipo | Notas |
|---|---|---|
| idempotency_key | CHAR(36) UNIQUE | Generada en el navegador |
| sucursal_id, turno_id, usuario_id (operador), cliente_id NULL | FK | |
| fecha | DATETIME | |
| moneda | MON | |
| tipo_cambio | RATE | Venta del día (siempre se guarda, también en PEN = 1) |
| forma_pago | ENUM('contado','credito') | |
| tipo_comprobante | CHAR(2) | 01/03 (lo que se emitirá) |
| modo_boleta | ENUM('individual','resumen') NULL | Elegido en el cobro |
| op_gravada, op_exonerada, op_inafecta, igv, descuento, total | MONEY | Calculado en el servidor (port de `Calculo.php`) |
| descuento_motivo, autorizado_por | | Usuario que autorizó con su PIN |
| estado | ENUM('confirmada','anulacion_en_proceso','anulada') | |

### `venta_items`
- venta_id, producto_id;
- **instantánea:** codigo, descripcion, unidad, tip_afe_igv;
- cantidad QTY, precio_unitario PRICE (con IGV y el descuento repartido), igv, total MONEY;
- CHECK cantidad > 0.

### `pagos` (pagos al contado o la cuota inicial)
- venta_id, metodo_pago_id, moneda MON, monto MONEY, tipo_cambio RATE, monto_en_moneda_venta MONEY, monto_recibido NULL, vuelto NULL, referencia.
- **Regla:** SUM(monto_en_moneda_venta) = total (contado) o = la cuota inicial (crédito).

### Cuentas por cobrar
| Tabla | Campos principales | Restricciones |
|---|---|---|
| `cuentas_por_cobrar` | venta_id UNIQUE, cliente_id, moneda, total, saldo MONEY, estado ENUM('pendiente','parcial','pagada','anulada'), vence_ultima DATE | índice (cliente_id, estado) |
| `cuotas` | cxc_id, numero, monto, saldo MONEY, fecha_vencimiento DATE, estado | UNIQUE(cxc_id, numero); son las mismas cuotas que se envían a la API |
| `cobros` | cliente_id, turno_id, metodo_pago_id, moneda, monto, tipo_cambio, usuario_id, idempotency_key UNIQUE, anulado | |
| `cobro_aplicaciones` | cobro_id, cuota_id, monto (en la moneda de la cuota), diferencia_cambio MONEY | Un cobro puede aplicarse a varias cuotas |

---

## 8. Facturación electrónica

### `comprobantes`
| Campo | Tipo | Notas |
|---|---|---|
| sucursal_id | FK | |
| venta_id | FK NULL | NULL para la ND por penalidad sin venta |
| tipo_doc | CHAR(2) | 01, 03, 07, 08 |
| serie_id | FK series | |
| serie | CHAR(4) | |
| correlativo | INT NULL | Lo asigna la API |
| numero_completo | VARCHAR(20) NULL | |
| fecha_emision | DATE | Hora de Lima |
| moneda, tipo_cambio, forma_pago | | |
| cliente_tipo_doc, cliente_num_doc, cliente_razon_social, cliente_direccion | | **Instantánea** |
| op_gravada, op_exonerada, op_inafecta, igv, total | MONEY | Los locales, más `total_api` para conciliar |
| modo_envio | ENUM('individual','resumen') | Solo boletas |
| estado | ENUM('pendiente','enviando','en_proceso','pendiente_resumen','en_resumen','aceptado','observado','rechazado','error_validacion','por_verificar','sin_respuesta_sunat','anulacion_en_proceso','anulado','anulado_interno') | Ver `00-plan` §10.1 y §0.4 |
| api_id | BIGINT NULL | UNIQUE(tipo_doc, api_id) |
| sunat_codigo, sunat_descripcion | | |
| sunat_notas | JSON | |
| hash_cpe | | |
| idempotency_key | CHAR(36) UNIQUE | Se renueva solo si cambia el cuerpo tras un 4xx (se guarda el historial en los intentos) |
| intentos | INT | |
| proximo_intento_en | DATETIME NULL | |
| ultimo_error | TEXT | |
| simulado | TINYINT(1) | |
| emitido_por | FK usuarios | |

**Restricciones e índices:**
- `UNIQUE(serie, correlativo, simulado)`;
- `INDEX(estado, proximo_intento_en)`, `INDEX(sucursal_id, fecha_emision)`, `INDEX(venta_id)`.

### Otras tablas de facturación
| Tabla | Campos principales | Restricciones |
|---|---|---|
| `comprobante_items` | comprobante_id, venta_item_id NULL, instantánea, cantidad, precio_unitario, igv, total | Corrige el defecto de ferretería: los ítems de las NC y ND tienen tabla propia |
| `comprobante_cuotas` | comprobante_id, numero, monto, fecha_pago | Exactamente lo que se envió en `cuotas[]` |
| `notas` | comprobante_id UNIQUE (la 07/08), comprobante_afectado_id, cod_motivo CHAR(2), des_motivo, devuelve_stock, reintegra_dinero | NC: SUM(totales de las NC) ≤ total del afectado (en el servicio, con FOR UPDATE del afectado) |
| `resumenes` | sucursal_id NULL, tipo ENUM('envio','anulacion'), fecha_resumen DATE, api_id UNIQUE NULL, identifier, estado ENUM('verificando','bloqueado','enviado','aceptado','rechazado','incidente'), bloqueo_detalle JSON, documentos_api JSON, idempotency_key UNIQUE | |
| `resumen_documentos` | resumen_id, comprobante_id, motivo NULL | UNIQUE(comprobante_id, resumen_id) |
| `bajas` (RA) | fecha_generacion, fecha_comunicacion, api_id UNIQUE NULL, identifier, ticket, estado, idempotency_key UNIQUE | |
| `baja_documentos` | baja_id, comprobante_id, motivo | Índice (comprobante_id) |
| `integracion_intentos` | entidad_tipo, entidad_id, operacion, metodo, ruta, idempotency_key, request_json (sin secretos), http_status, response_json, duracion_ms, error, creado_en | Índice (entidad_tipo, entidad_id); **solo inserción** |
| `archivos_cpe` | entidad_tipo, entidad_id, tipo ENUM('pdf_a4','pdf_a5','pdf_t80','pdf_t58','xml','cdr'), ruta, sha256, bytes | UNIQUE(entidad_tipo, entidad_id, tipo); solo con el estado final |
| `outbox_trabajos` | tipo (emitir, reconciliar, enviar_resumen, reconciliar_resumen, emitir_baja, reconciliar_baja, emitir_guia, reconciliar_guia), entidad_tipo, entidad_id, estado ENUM('pendiente','en_proceso','hecho','fallido','pausado'), prioridad, intentos, ejecutar_en, bloqueado_hasta, ultimo_error | UNIQUE(tipo, entidad_tipo, entidad_id, estado_activo) con una columna generada para impedir trabajos activos duplicados; índice (estado, ejecutar_en) |

---

## 9. Guías de remisión remitente (09)

| Tabla | Campos principales |
|---|---|
| `transportistas` | tipo_doc, num_doc (RUC), razon_social, nro_mtc, activo; UNIQUE(tipo_doc, num_doc) |
| `vehiculos` | placa UNIQUE, nro_circulacion NULL, activo |
| `conductores` | tipo_doc, num_doc, nombres, apellidos, licencia, activo; UNIQUE(tipo_doc, num_doc) |
| `guias` | sucursal_id, serie_id, serie, correlativo NULL, numero_completo, fecha_emision, fecha_traslado, cod_traslado CHAR(2) (Cat. 20), mod_traslado CHAR(2), peso_total, und_peso, num_bultos, destinatario (instantánea), partida_ubigeo/direccion/cod_local, llegada_ubigeo/direccion/cod_local, transportista (instantánea JSON) NULL, vehiculo_placa NULL, conductor (instantánea JSON) NULL, doc_relacionado JSON, venta_id NULL, traslado_id NULL, estado (como en comprobantes, sin las de resumen), api_id UNIQUE NULL, ticket, sunat_*, idempotency_key UNIQUE |
| `guia_items` | guia_id, producto_id NULL, codigo, descripcion, unidad, cantidad |
| `ubigeos` | codigo CHAR(6) PK, departamento, provincia, distrito (caché de `GET /catalogos/ubigeo/*`) |

---

## 10. Auditoría
### `auditoria` (solo inserción, sin FK para que perdure)
- usuario_id, operador_id, sucursal_id, accion (p. ej. `serie.actualizar_correlativo`), entidad, entidad_id, antes JSON, despues JSON, ip, request_id, creado_en.
- Índices: (entidad, entidad_id) y (creado_en).

---

## 11. Reglas transaccionales clave

| Operación | En una sola transacción |
|---|---|
| Confirmar una venta | Bloquear stock (FOR UPDATE, orden por producto_id) → validar stock ≥ cantidad → venta + ítems → pagos → movimientos de caja → movimientos de stock → (crédito) cxc + cuotas → comprobante `pendiente` + comprobante_items + comprobante_cuotas → outbox `emitir` |
| Emitir una NC | FOR UPDATE del afectado → validar el saldo → comprobante 07 + items + notas → stock `devolucion_nc` (si aplica) → caja `devolucion` o ajuste de la cxc → outbox |
| Confirmar una anulación (cuando la API confirma `anulado`) | Comprobante `anulado` → venta `anulada` → stock `anulacion` → extorno de caja o cxc `anulada` |
| Registrar un cobro | FOR UPDATE de las cuotas → cobro + aplicaciones → saldos → movimiento de caja |
| Cerrar un turno | FOR UPDATE del turno → calcular lo esperado por moneda → guardar lo contado y la diferencia → `cerrado` |
| Compra | compra + items → stock `compra` → recalcular el costo promedio |

**Garantías contra la duplicidad:**
- `ventas.idempotency_key`;
- `comprobantes.idempotency_key` y el UPDATE condicional `estado IN ('pendiente','por_verificar') → 'enviando'`;
- los UNIQUE por origen en `movimientos_stock` y `movimientos_caja`;
- el UNIQUE del trabajo activo en `outbox_trabajos`.
