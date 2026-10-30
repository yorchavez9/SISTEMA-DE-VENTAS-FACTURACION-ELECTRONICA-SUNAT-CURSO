# 04 · Prototipos de pantallas (baja fidelidad)

Estado: **propuesta para aprobación** (fase 2, paso 3). La identidad visual se basa en `C:\laragon\www\ferreteria`; se toman conceptos y tokens, no se copia el código.

---

## 1. Sistema de diseño (tokens para `apps/web/src/styles/tokens.css`)

| Token | Claro | Oscuro | Uso |
|---|---|---|---|
| `--primary` | `#f48c06` | `#f48c06` | Botón principal, foco, ítem activo (icono) |
| `--primary-fg` | `#ffffff` | `#ffffff` | |
| `--brand-strong` | `#8a4c00` | `#eeb687` | Naranja como texto (contraste ≥ 4.5:1) |
| `--brand-soft` | `#fff6ef` | `#402812` | Fondos destacados suaves |
| `--bg` / `--card` | `#fbfeff` | `#060b11` / `#0c1219` | |
| `--fg` | `#08181d` | `#f1f5fa` | Texto |
| `--muted-fg` | `#5c7077` | `#98a4b1` | Texto secundario |
| `--campo` | `#eef3f5` | `#161e26` | Relleno de botones secundarios y controles |
| `--borde-campo` | `#cdd8dc` | `#2c3640` | Único borde visible (inputs) |
| `--danger` | `#ff5f73` | `#ff5f73` | |
| `--ok-strong` / `--warn-strong` / `--info-strong` | `#02713a` / `#7a5602` / `#1f5f99` | `#01e97e` / `#fdb502` / `#8fc6f5` | Chips de estado |

- **Tipografía:** IBM Plex Sans (interfaz 14px / 600) e IBM Plex Mono (RUC, serie-número, ticket); números tabulares en los importes.
- **Formas:** radio 0.7rem; controles de 36px (44px con `pointer: coarse`).
- **Superficies:** sombras `--sombra-tarjeta` y `--sombra-elevada`. **Sin bordes en tarjetas ni tablas.**
- **Iconos:** lucide-react, 16px, stroke 2.5.
- **Puntos de corte:** 1024 (menú plegable), 768 (menú plegado o cajón), 900 (POS a una columna), 720 (tablas compactas), 460 (formularios a 1 columna).
- **Chips de estado del CPE:**

| Estado | Texto | Tono |
|---|---|---|
| pendiente / enviando / en_proceso | Por emitir · Enviando · En SUNAT | neutro / info |
| pendiente_resumen / en_resumen | Para resumen · En resumen | info |
| aceptado | Aceptado | ok |
| observado | Aceptado con obs. | aviso |
| por_verificar / sin_respuesta_sunat | Por comprobar · Sin respuesta | aviso |
| rechazado / error_validacion | Rechazado · Datos inválidos | alerta |
| anulacion_en_proceso / anulado / anulado_interno | Anulando · Anulado · Anulado (interno) | neutro |

---

## 2. Inicio de sesión y PIN

```
┌──────────────────────────────────────────────┐
│              [logo]  CMA STORE               │
│          Sistema de ventas y facturación      │
│                                              │
│  Usuario    [____________________]           │
│  Contraseña [____________________] (ojo)     │
│                                              │
│  [        Ingresar  (primario)        ]      │
│                                              │
│  Dispositivo: Caja 1 · Sucursal Centro  ✓    │  ← si el navegador tiene dispositivoToken
└──────────────────────────────────────────────┘

Modal "Cambiar cajero" (desde el POS)          Modal "Autorización de supervisor"
┌───────────────────────────┐                  ┌──────────────────────────────┐
│ ( A ) Ana   ( L ) Luis    │                  │ Descuento 10% requiere       │
│ ( M ) Marta               │                  │ autorización                 │
│        ● ● ○ ○            │                  │ Supervisor [ Marta ▾ ]       │
│  [1][2][3]                │                  │ PIN  ● ● ● ○                 │
│  [4][5][6]                │                  │ [1][2][3] … teclado          │
│  [7][8][9]                │                  │ [Cancelar]   [Autorizar]     │
│  [⌫][0][✓]                │                  └──────────────────────────────┘
└───────────────────────────┘
```
- **PIN incorrecto:** el teclado se sacude y aparece "Quedan N intentos".
- **Bloqueo:** "Bloqueado hasta 10:42".

---

## 3. Diseño general (AppLayout)

```
┌────────────┬─────────────────────────────────────────────────────────────────────┐
│ [■] CMA    │ [☰]  CMA STORE · Sucursal Centro ▾ · Ventas      (●SUNAT ok) [☾] [Ana▾] │ ← topbar sticky + blur
│ Punto de   ├─────────────────────────────────────────────────────────────────────┤
│ venta      │  ⚠ 3 comprobantes requieren atención · Ver                           │ ← Banner (si aplica)
│            │                                                                     │
│ OPERACIÓN  │  Comprobantes                                   [Actualizar] [+ …]  │ ← h1 + acción principal
│  ◧ Inicio  │  ───────────────────────────────────────────────────────────────    │
│  🛒 Vender │                                                                     │
│  ▣ Caja    │            (contenido de la vista, max-width 1320px)                │
│ VENTAS     │                                                                     │
│  🧾 Compro-│                                                                     │
│    bantes  │                                                                     │
│  ↺ Notas   │                                                                     │
│  ▤ Resumen │                                                                     │
│    diario  │                                                                     │
│  💳 Cuentas│                                                                     │
│    x cobrar│                                                                     │
│  👥 Clientes                                                                     │
│ ALMACÉN    │                                                                     │
│  📦 Productos                                                                    │
│  ⇅ Inventario                                                                    │
│  🚚 Compras │                                                                    │
│  ⛟ Guías   │                                                                     │
│ ADMIN      │                                                                     │
│  📊 Reportes                                                                     │
│  ⚙ Config. │                                                                     │
│ ────────── │                                                                     │
│ (A) Ana    │                                                                     │
│ Cajera  ⎋  │                                                                     │
└────────────┴─────────────────────────────────────────────────────────────────────┘
```
- Los ítems se filtran por permiso.
- **Ítem activo:** sin fondo; texto en `--brand-strong` y el icono en el color primario.
- **Selector de sucursal** en la topbar: solo si el usuario tiene más de una.
- **Chip SUNAT:** muestra el estado de la integración (`/estado-integracion`): ok, cola pausada o modo simulación.
- **Tablet (768–1023):** menú plegado a iconos; al pulsar ☰ se abre encima del contenido.
- **Móvil (<768):** el menú es un cajón deslizable desde la izquierda.

**Configuración** se organiza en pestañas: Empresa · Sucursales · Series · Conexión API · Usuarios · Dispositivos · Tipo de cambio · Ticket.

---

## 4. Inicio (dashboard)

```
Buenos días, Ana                                   [Sucursal: Todas ▾] [Hoy|7d|Mes|Rango]
Miércoles, 28 de octubre de 2026
[🛒 Vender] [📦 Productos] [🧾 Comprobantes] [💳 Cobrar]

┌──────────────────────┐┌────────────────┐┌────────────────┐┌────────────────┐
│ VENTAS DE HOY  ▲12%  ││ TICKET PROMEDIO││ POR COBRAR     ││ COMPROBANTES   │
│ S/ 4,820.50          ││ S/ 86.40       ││ S/ 2,310.00    ││ 54 aceptados   │
│ $ 320.00 · 56 ventas ││                ││ 3 vencidas     ││ 2 con problema │
└──────────────────────┘└────────────────┘└────────────────┘└────────────────┘
  (destacado naranja)

┌─────────────────────────────────────────────┐┌──────────────────────────────┐
│ Ventas por día (Recharts, barras)           ││ Por medio de pago (barras h.)│
│ ▂▃▅▇▆▅▇                                     ││ Efectivo ███████  48%        │
└─────────────────────────────────────────────┘│ Yape     ████     27% …      │
┌─────────────────────────────────────────────┐└──────────────────────────────┘
│ Ventas recientes  (tabla: hora, comp., tot.)││ Por reponer (stock bajo)     │
│ Top productos                               ││ Pendientes de resumen: 18 ⏱  │
└─────────────────────────────────────────────┘└──────────────────────────────┘
```

---

## 5. Punto de venta (POS)

```
┌───────────────────────────────────────────────────────┬─────────────────────────────┐
│ [🔍 Buscar o escanear código…              ] [Ana ⇄]  │  VENTA · Caja 1 · 10:24     │
│ (Todo) (Ferretería) (Pinturas) (Eléctricos) …         │  Cliente: Clientes varios ✎ │
│                                                       │  ─────────────────────────  │
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐          │  2 × Martillo 16oz   59.00 │
│ │[img]   │ │        │ │        │ │ AGOTADO│          │      S/ 29.50 c/u  [-][2][+]│
│ │Martillo│ │Cable   │ │Pintura │ │Broca   │          │  1.5 MTR Cable 14   9.75   │
│ │S/29.50 │ │S/ 6.50 │ │S/48.00 │ │S/ 3.20 │          │      S/ 6.50 / MTR  [✎][🗑]  │
│ │stock 12│ │stk 300m│ │stock 4 │ │stock 0 │          │  ─────────────────────────  │
│ └────────┘ └────────┘ └────────┘ └────────┘          │  Moneda  (PEN)( USD )       │
│ …                                                     │  TOTAL          S/ 68.75   │
│                                                       │  [   Cobrar S/ 68.75   ]    │
│                                                       │  [ Vaciar venta ]           │
│                                                       │  ﹏﹏﹏﹏﹏ (borde dentado)    │
└───────────────────────────────────────────────────────┴─────────────────────────────┘
Móvil (<900px):  [ Productos | Venta (3) ]  ← conmutador segmentado
```
- **Enter con un código exacto** agrega el producto (lector de barras).
- **Cantidades:** las unidades fraccionables abren un modal para escribirlas; las enteras se ajustan con el stepper.
- **Stock:** no se puede agregar más que el disponible ("Solo hay 4"); el servidor lo vuelve a validar.
- **Sin turno abierto:** la pantalla queda bloqueada con la tarjeta "Abre la caja para vender" y el botón [Abrir caja].
- **Moneda USD:** muestra el tipo de cambio del día. Si no está registrado, avisa: "Registra el tipo de cambio de hoy".

---

## 6. Modal de cobro

```
┌──────────────────────────────── Cobrar venta ─────────────────────────────────── ✕ ┐
│ RESUMEN                       │  Comprobante  [ Boleta ][ Factura ]                 │
│ 2 × Martillo 16oz      59.00  │  Serie [B101 ▾]   Envío ( Individual )( Resumen )   │ ← solo con boletas.elegir_modo
│ 1.5 × Cable 14          9.75  │  ─────────────────────────────────────────────────  │
│ ───────────────────────────── │  Cliente  [DNI/RUC ________] 🔍  → "JUAN PÉREZ" ✓   │
│ Subtotal            S/ 68.75  │           (vacío = Clientes varios; obligatorio si  │
│ Descuento  (Aplicar)          │            el equivalente supera S/ 700)            │
│ Op. gravada         S/ 58.26  │  ─────────────────────────────────────────────────  │
│ IGV 18%             S/ 10.49  │  Forma de pago  ( Contado )( Crédito )              │
│ TOTAL A COBRAR                │                                                     │
│ S/ 68.75                      │  CONTADO:                                           │
│ Importes confirmados por el   │   [Efectivo ▾] [PEN ▾] [ 50.00 ]  Recibido [100.00] │
│ servidor                      │   [Yape     ▾] [PEN ▾] [ 18.75 ]  Ref. [____]       │
│                               │   [+ Agregar medio]          Falta: S/ 0.00         │
│                               │   Vuelto: S/ 50.00                                  │
│                               │                                                     │
│                               │  CRÉDITO:                                           │
│                               │   Inicial [Efectivo ▾][ 0.00 ]                      │
│                               │   Cuotas  [2 ▾] cada [30 días ▾]  → generar         │
│                               │   1) 28/11/2026  S/ 34.38                           │
│                               │   2) 28/12/2026  S/ 34.37                           │
│                               │   Crédito disponible del cliente: S/ 1,500.00       │
├───────────────────────────────┴─────────────────────────────────────────────────────┤
│                                              [Cancelar]   [ Confirmar venta (F2) ]  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```
- La factura exige un RUC (módulo 11), la razón social y la dirección; el autocompletado viene de la BD local o de `/buscar-documento`.
- **"Confirmar venta"** queda deshabilitado mientras falte dinero o la suma de las cuotas no sea igual al saldo.

**Tras confirmar: modal "Venta N° 1201 registrada"**
- Muestra el total y "Entregue vuelto S/ 50.00" sobre fondo amarillo suave.
- **Línea del comprobante:** `B101-000045 · ● Enviando…`, que pasa a `● Aceptado` (consulta el estado local cada 3 s).
- Si el modo es resumen: "Para resumen diario (se enviará hoy 23:00)".
- **Botones:** [Imprimir ticket] [PDF] [Nueva venta (Enter)].

---

## 7. Caja (turno)

```
Caja 1 · Turno abierto por Ana a las 08:02                       [Ingreso] [Egreso] [Cerrar caja]
┌──────────────┐┌──────────────┐┌──────────────┐
│ EFECTIVO PEN ││ EFECTIVO USD ││ OTROS MEDIOS │
│ S/ 1,240.00  ││ $ 85.00      ││ S/ 2,310.50  │
│ inicial 200  ││ inicial 0    ││ Yape, tarjeta│
└──────────────┘└──────────────┘└──────────────┘
Movimientos (tabla): hora · tipo · concepto · medio · moneda · importe

Modal "Cerrar caja"
  Moneda | Esperado   | Contado    | Diferencia
  PEN    | 1,240.00   | [1,235.00] | -5.00 (rojo)
  USD    |    85.00   | [   85.00] |  0.00
  [Cancelar]  [Cerrar turno]   → imprime el arqueo en 80mm
```

---

## 8. Comprobantes

```
Comprobantes                                                    [Actualizar estados]
[Desde 28/10][Hasta 28/10] [Tipo: Todos ▾] [Estado: Todos ▾] [Sucursal ▾] [🔍 serie/cliente] [☐ Solo atención]
⚠ 2 rechazados · 1 por comprobar                     │ 56 comprobantes · S/ 4,820.50 netos (NC restan)

N° │ Comprobante            │ Cliente               │ Total      │ Estado            │ Acciones
1  │ F101-000012            │ ACME SAC              │ S/ 1,180.00│ ● Aceptado        │ [PDF][XML][CDR][⋯]
   │ Venta 1199 · 10:02     │ RUC 20512345678       │            │                   │
2  │ B101-000045            │ Clientes varios       │ S/ 68.75   │ ● Para resumen    │ [PDF][⋯]
3  │ F101-000013            │ XYZ EIRL              │ $ 320.00   │ ● Rechazado       │ [Corregir][⋯]
   │ 2017: El RUC del receptor no existe (detalle secundario)                       │
```
- **Menú ⋯ según `acciones[]`:** Nota de crédito · Nota de débito · Anular · Reintentar · Consultar · Ver historial.
- **Detalle (panel lateral o modal ancho):**
  - datos e ítems;
  - cuotas;
  - notas relacionadas;
  - **historial de intentos** (hora, operación, HTTP, mensaje);
  - visor de PDF con [Imprimir] [Descargar] y un selector A4 / A5 / Ticket 80 / Ticket 58.
- **Responsive:** el cliente y el detalle pasan a la fila desplegable "+" por debajo de 720px.

---

## 9. Notas de crédito y débito

```
Nota de crédito para F101-000012 (ACME SAC · S/ 1,180.00 · saldo acreditable S/ 1,180.00)
Motivo [07 Devolución por ítem ▾]   Serie [FC11 ▾]
Descripción [Cliente devuelve 1 unidad dañada______]
Ítem                 Vendido  Ya acreditado  A acreditar
Taladro 650W           2          0           [1]     S/ 590.00
☑ Devolver al stock (Sucursal Centro)
Reintegro: (●) Efectivo de la caja abierta  ( ) Rebajar la cuenta por cobrar  ( ) Sin reintegro
                                                    Total NC: S/ 590.00   [Cancelar] [Emitir NC]
```
- La NC 01 (anulación) y la 06 (devolución total) seleccionan todos los ítems de forma automática.
- **ND:** formulario con líneas libres (concepto, cantidad, precio, afectación), motivo del catálogo 10 y si va a cobro o a la CxC.

---

## 10. Resumen diario de boletas

```
Resumen diario                                   Sucursal [Centro ▾]   Envío automático: 23:00 ✓
┌ Fecha ─────┬ Boletas propias ┬ Total      ┬ Estado                  ┬ Acciones ───────────────┐
│ 28/10/2026 │ 18              │ S/ 1,920.40│ ⏱ Pendiente (vence 04/11)│ [Verificar] [Enviar ahora]│
│ 27/10/2026 │ 22              │ S/ 2,105.00│ ● Aceptado RC-20261027-1 │ [Ver]                    │
│ 26/10/2026 │ 15              │ S/ 1,300.00│ ⛔ Bloqueado              │ [Ver detalle]            │
└────────────┴─────────────────┴────────────┴──────────────────────────┴──────────────────────────┘

Modal "Bloqueado: boletas ajenas al sistema"
  La API incluiría 2 boletas que no son de este sistema:
   B001-000241 (otra aplicación) · B001-000242
  Este sistema no las enviará. Opciones:
   [Enviar mis 15 boletas de forma individual]   [Reintentar verificación]   [Cerrar]
```

---

## 11. Configuración → Series

```
Series                                                     [Sincronizar con API] [+ Nueva serie]
Tipo        │ Serie │ Sucursal │ Origen       │ Último │ Estado  │ Acciones
Factura     │ F101  │ Centro   │ ● Propia     │ 12     │ Activa  │ [Editar]
Boleta      │ B101  │ Centro   │ ● Propia     │ 45     │ Activa  │ [Editar]
Factura     │ F001  │ 0001     │ ○ Externa    │ 719    │ Activa  │ solo lectura 🔒
NC (fact.)  │ FC11  │ Centro   │ ● Propia     │ 1      │ Activa  │ [Editar]

Modal "Cambiar correlativo de B101"
  Último usado: 45
  Nuevo correlativo [ 100 ]
  ⚠ Se saltarán los números 46–99. SUNAT no exige continuidad, pero quedará en la auditoría.
  ⛔ (si es ≤45) No se permite: generaría números duplicados.
  Escribe B101 para confirmar [______]
                                              [Cancelar] [Aplicar en API-PRO]
```

---

## 12. Guía de remisión remitente

```
Nueva guía de remisión                [Desde venta: 1201 ✕]          Serie [T101 ▾]
Motivo [01 Venta ▾]   Modalidad ( Pública )( Privada )   Fecha de traslado [29/10/2026]
Destinatario  [RUC 20512345678] ACME SAC
Partida  [ubigeo 150101 Lima/Lima/Lima ▾] [Av. Central 425____]
Llegada  [ubigeo ____ 🔍 ] [dirección __________]
Pública  → Transportista [RUC ▾ / nuevo] N° MTC [____]
Privada  → Vehículo [placa ▾] Conductor [DNI ▾] Licencia [auto]
Peso total [12.5] [KGM ▾]  Bultos [2]
Ítems: (precargados desde la venta, editables en cantidad)
                                                        [Cancelar] [Emitir guía]
```
- La validación es condicional, según la modalidad y el motivo.
- Los errores se muestran por campo, antes de encolar la guía.

---

## 13. Criterios de aceptación de los prototipos
1. Cada pantalla del MVP tiene su boceto y su estado vacío, de carga y de error.
2. El POS se puede usar en 360px (móvil), 768px (tablet) y 1280px (escritorio) sin scroll horizontal.
3. **Contraste:** todos los textos cumplen WCAG AA (el naranja solo se usa como texto en `--brand-strong`).
4. **Teclado:**
   - **F2** confirma el cobro;
   - **Esc** cierra los modales;
   - **Enter** en el buscador agrega con un código exacto;
   - **Ctrl+K** enfoca el buscador del POS.
5. Ninguna pantalla muestra credenciales de la API ni datos sensibles.

> Opcional: si quieres ver estos bocetos con la paleta real y en claro y oscuro, puedo publicar un prototipo navegable en HTML antes de la fase 3.
