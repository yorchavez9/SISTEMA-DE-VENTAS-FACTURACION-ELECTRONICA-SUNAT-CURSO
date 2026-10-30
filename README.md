# Sistema de ventas · CMA STORE

Ventas, inventario, caja, cuentas por cobrar y facturación electrónica SUNAT a través de API-PRO.
Monorepo TypeScript: **React + Vite** (`apps/web`), **Express** (`apps/api`), código compartido (`packages/shared`), **MySQL 8**.

La documentación de diseño está en [`docs/`](docs/): plan, arquitectura, modelo de datos, API interna y prototipos.

## Requisitos
- Node.js 20.11 o superior (probado con Node 22)
- MySQL 8.0 o superior (Laragon trae 8.4)

## Puesta en marcha
```bash
npm install
cp apps/api/.env.example apps/api/.env   # completar los valores (ver comentarios del archivo)
npm run db:migrate                        # crea la base sistema_ventas y sus tablas
npm run db:seed                           # roles, permisos y configuración inicial
npm run dev                               # api :4000 · worker · web :5173
```
Abrir http://localhost:5173.

## Comandos útiles
| Comando | Qué hace |
|---|---|
| `npm test` | Pruebas unitarias e integración (Vitest) |
| `npm run test:cobertura -w @sv/api` | Pruebas con cobertura; falla si inventario, ventas, facturación, guías o el cálculo de impuestos bajan del 80 % de líneas. Informe HTML en `apps/api/coverage/` |
| `npm run test:rendimiento -w @sv/api` | Dashboard y reportes con 100 000 ventas (lento; recrea la base de pruebas) |
| `npm run typecheck` | Verificación de tipos de todo el monorepo |
| `npm run build` | Compila shared, api y web |
| `npm run db:rollback` | Revierte el último lote de migraciones |
| `npm run apipro:probar -w @sv/api` | Prueba de solo lectura de la conexión con API-PRO |
| `npm run respaldo -w @sv/api` · `respaldo:probar` | Respaldo comprimido de MySQL con retención · restauración de prueba en una base temporal |
| `npm run secretos:rotar -w @sv/api` | Rota `APP_ENC_KEY` (ver manual de operación §5) |

## Seguridad
- `apps/api/.env` contiene secretos y **no se versiona**.
- Las credenciales de API-PRO solo las usa el backend; React nunca llama a API-PRO.
- La colección de Postman está excluida de git porque contiene credenciales en texto plano.

## Manuales
- [Guía de instalación paso a paso](docs/07-guia-instalacion.md)
- [Manual de usuario](docs/05-manual-usuario.md)
- [Manual de operación](docs/06-manual-operacion.md): instalación, servicios, HTTPS, respaldos, secretos, alertas y checklist de paso a producción. Plantillas en `deploy/`.
