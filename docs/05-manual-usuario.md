# Manual de usuario

Uso diario del sistema de ventas, por tarea. Lo que ves depende de tu rol: **cajero**, **almacén**,
**supervisor** o **administrador**. Si falta una opción del menú, tu rol no la tiene.

## 1. Entrar

- **Usuario y contraseña.** La primera vez, el sistema te pide cambiar la contraseña temporal.
- **PIN rápido** (en las cajas registradas como dispositivo POS): con la sesión de la caja abierta,
  **Cambiar cajero** → eliges tu nombre y escribes tu PIN. Cambias de cajero sin cerrar la sesión, y desde
  ese momento las ventas y los permisos son los tuyos. El PIN también sirve para que un supervisor
  autorice algo en la misma pantalla (p. ej. un descuento mayor).
- Arriba a la derecha está la **sucursal activa**. Todo lo que registres (ventas, caja, stock) es de esa
  sucursal.
- El **chip de estado** indica si los comprobantes llegan a SUNAT. "Modo simulación" significa que nada se
  envía a SUNAT y nada tiene validez tributaria.

## 2. Caja

1. **Abrir caja**: en Caja, elige la caja y registra el efectivo inicial en soles y, si corresponde, en dólares.
   Sin caja abierta no se puede vender.
2. **Ingresos y egresos**: Caja → movimiento, con el concepto (p. ej. "pago de movilidad"). Quedan en el
   cierre y en la auditoría.
3. **Cerrar caja**: cuenta el efectivo por moneda. El sistema muestra lo esperado y la diferencia; un
   faltante o sobrante queda registrado con tu nombre.

## 3. Vender (POS)

1. Busca el producto por nombre, código o código de barras. Si escaneas o escribes un código exacto y
   pulsas Enter, se agrega directo.
2. Ajusta cantidades. **No se puede vender más que el stock disponible**: el sistema avisa cuánto hay.
3. **Cliente**:
   - **boleta**: puede ir a "clientes varios" hasta S/ 700; desde ese monto SUNAT exige el DNI u otro documento;
   - **factura**: exige RUC. Busca el documento y el nombre se completa desde SUNAT/RENIEC.
4. **Descuento**: si supera tu límite, un supervisor lo autoriza con su PIN, sin salir de la venta.
5. **Cobrar**:
   - uno o varios medios (efectivo, tarjeta, Yape/Plin, transferencia). Con efectivo se calcula el vuelto;
   - **en dólares**: con el tipo de cambio del día;
   - **al crédito** (soles o dólares): define las cuotas y sus fechas. Queda en Cuentas por cobrar.
6. Se imprime el ticket. El comprobante electrónico se envía a SUNAT en segundo plano: no esperes a SUNAT
   para atender al siguiente cliente.

Si se corta internet o API-PRO no responde, **sigue vendiendo**. Los comprobantes se envían solos cuando
vuelve la conexión, sin duplicarse.

## 4. Comprobantes

En **Comprobantes**, cada venta tiene su factura o boleta con su estado:

| Estado | Qué significa | Qué hacer |
|---|---|---|
| Pendiente / Enviando / En SUNAT | En camino | Nada, se actualiza solo |
| Por verificar | No hubo respuesta; se reintenta solo | Esperar; "Reintentar" si persiste |
| Para el resumen | Boleta que va en el resumen diario | Nada (o enviar el resumen) |
| **Aceptado** | Válido ante SUNAT | — |
| Observado | Aceptado con observaciones | Revisar las observaciones |
| **Rechazado** / Error de datos | SUNAT o API-PRO no lo aceptó | "Corregir cliente" y se reenvía |
| Sin respuesta | SUNAT no resolvió a tiempo | "Consultar a SUNAT" más tarde |

Desde el detalle:
- **PDF** (A4, A5 o ticket), **XML** y **CDR**.
- **Nota de crédito**: devolución total o por ítems, o anulación de la operación. Indica si la mercadería
  vuelve al stock y cómo se devuelve el dinero: por caja, rebajando la deuda del cliente o sin devolución.
- **Nota de débito**: intereses u otros cargos, que se cobran en caja o como nueva cuota.
- **Anular ante SUNAT**: solo comprobantes aceptados de hace **7 días como máximo**, sin notas ni cobros.
  - Las facturas se anulan por comunicación de baja y las boletas por resumen de anulación.
  - Cuando SUNAT confirma, el stock vuelve, la deuda se anula y aparece **"Devolver S/ …"** para registrar
    el reembolso en caja.
  - Pasado el plazo, usa una nota de crédito.
- **Guía de remisión**: crea la guía con los datos de esa venta.

El menú **Notas** muestra la misma lista filtrada en notas de crédito y débito.

## 5. Resumen diario de boletas

Solo en sucursales configuradas con "resumen diario" para las boletas; en modo individual cada boleta va
sola. El sistema envía el resumen automáticamente a la hora configurada. En **Resumen diario** puedes
revisarlo, enviarlo a mano o mandar las boletas una por una. Antes de enviar, el sistema comprueba que todas
las boletas pendientes del RUC sean de este sistema.

## 6. Cuentas por cobrar

Clientes con deuda, cuotas y vencimientos. **Cobrar** registra el pago en la caja abierta y lo aplica a las
cuotas más antiguas. Un cobro mal registrado se anula con motivo. El estado de cuenta muestra todo el
historial del cliente.

## 7. Productos, inventario y compras

- **Productos**: precio en soles (y en dólares si aplica), afectación del IGV, unidad SUNAT, stock mínimo.
- **Inventario → Stock**: existencias de la sucursal, kardex por producto y **ajustes** con motivo.
- **Inventario → Traslados**: envía mercadería a otra sucursal. Sale del stock al enviar y entra cuando el
  destino pulsa **Recibir**. Desde la lista se emite la **guía** del traslado.
- **Compras**: registra la factura del proveedor. Suma stock y actualiza el costo promedio.

## 8. Guías de remisión

**Guías → Nueva guía**, o desde una venta o un traslado (vienen con los datos completos):
- **Motivo**: venta, compra, traslado entre establecimientos, devolución…
- **Transporte público**: elige el transportista y la fecha de entrega de la mercadería.
- **Transporte privado**: elige vehículo y conductor. Con un auto o moto (M1/L), marca la casilla y no hacen
  falta.
- **Partida y llegada**: dirección y ubigeo (escríbelo o usa "Elegir").
- Los transportistas, vehículos y conductores se registran en la pestaña **Transportistas, vehículos y
  conductores**.

La guía no mueve stock: lo mueve la venta o el traslado. Si SUNAT la rechaza, **Corregir y reenviar**.

## 9. Inicio y reportes

- **Inicio**:
  - ventas netas del día (las notas de crédito restan) con la comparación contra el mismo día de la
    semana pasada;
  - ventas de los últimos 14 días ("Ver tabla" para ver las cifras);
  - lo más vendido, lo cobrado por medio de pago, el stock bajo y las cuotas vencidas.
- **Reportes**:
  - **Ventas**, por día, producto, cliente, vendedor, sucursal o medio de pago;
  - **Comprobantes**, **inventario valorizado**, **compras**, **cierres de caja** y **cuentas por cobrar**
    por antigüedad;
  - **Exportar CSV** abre en Excel.
- **Auditoría** (administradores): quién hizo qué y cuándo. **Envíos a API-PRO**: cada envío y su resultado.

## 10. Avisos en pantalla

- **Rojo "Emisión pausada"**: problema con las credenciales, la licencia o el cupo de API-PRO. Sigue vendiendo
  y avisa al administrador.
- **Amarillo "Requiere revisión"**: hay envíos que no avanzan solos, boletas sin resumen o tareas fallidas.
  Abre el enlace del aviso.
- **Amarillo "Modo simulación"**: lo emitido no tiene validez ante SUNAT.
