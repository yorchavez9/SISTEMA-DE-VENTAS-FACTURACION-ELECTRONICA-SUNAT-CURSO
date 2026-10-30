# Sistema de ventas y facturación electrónica SUNAT · CMA STORE

Ventas, inventario, caja y facturación electrónica SUNAT (API-PRO).
React + Node.js + MySQL.

## Requisitos

- [Node.js](https://nodejs.org) 20 o superior
- [Laragon](https://laragon.org) (trae MySQL)

## Instalación

1. **Enciende MySQL**: abre Laragon y pulsa **Iniciar todo**.

2. **Descarga el proyecto e instala:**

   ```bash
   cd C:\laragon\www
   git clone https://github.com/yorchavez9/SISTEMA-DE-VENTAS-FACTURACION-ELECTRONICA-SUNAT-CURSO.git sistemas-ventas-curso
   cd sistemas-ventas-curso
   npm install
   ```

3. **Crea el archivo `.env`:**

   ```bash
   copy apps\api\.env.example apps\api\.env
   ```

   Ábrelo y completa `APP_ENC_KEY` y `SESSION_SECRET`. Genera cada una con:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

4. **Crea la base de datos:**

   ```bash
   npm run db:migrate
   npm run db:seed
   ```

## Levantar el proyecto

```bash
npm run dev
```

Abre **http://localhost:5173**. La primera vez te pedirá crear el usuario administrador.

Para detenerlo: **Ctrl + C**.

---

¿Producción, configuración o problemas? Mira la [guía completa](docs/07-guia-instalacion.md).
