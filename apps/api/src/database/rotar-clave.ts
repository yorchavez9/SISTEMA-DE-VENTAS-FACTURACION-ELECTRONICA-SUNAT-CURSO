// Rotación de la clave maestra APP_ENC_KEY (fase 10, manual de operación §Secretos).
//   1. Genera una clave nueva:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//   2. Detén la api y el worker.
//   3. NUEVA_APP_ENC_KEY=<nueva> npm run secretos:rotar -w @sv/api
//   4. Reemplaza APP_ENC_KEY en .env por la nueva y vuelve a iniciar los servicios.
// Todo ocurre en una transacción: si algo falla, la base queda como estaba (con la clave anterior).
import { env } from '../config/env.js';
import { recifrar } from '../shared/crypto.js';
import { db } from './db.js';

const nueva = Buffer.from(process.env.NUEVA_APP_ENC_KEY ?? '', 'base64');

try {
  if (nueva.length !== 32) throw new Error('Define NUEVA_APP_ENC_KEY: 32 bytes en base64');
  if (nueva.equals(Buffer.from(env.APP_ENC_KEY, 'base64'))) throw new Error('La clave nueva es igual a la actual');
  const n = await db.transaction(async (trx) => {
    const filas = await trx('empresa').whereNotNull('apipro_key_enc').forUpdate().select('id', 'apipro_key_enc', 'apipro_secret_enc');
    for (const f of filas) {
      await trx('empresa')
        .where('id', f.id)
        .update({ apipro_key_enc: recifrar(f.apipro_key_enc as Buffer, nueva), apipro_secret_enc: recifrar(f.apipro_secret_enc as Buffer, nueva) });
    }
    // Tokens de json.pe / MIGO (consulta de DNI y RUC).
    const tokens = await trx('proveedores_documento').whereNotNull('token_enc').forUpdate().select('codigo', 'token_enc');
    for (const t of tokens) await trx('proveedores_documento').where('codigo', t.codigo).update({ token_enc: recifrar(t.token_enc as Buffer, nueva) });
    return filas.length + tokens.length;
  });
  console.log(`Listo: ${n} registro(s) cifrados con la clave nueva. Ahora reemplaza APP_ENC_KEY en apps/api/.env y reinicia la api y el worker.`);
} catch (err) {
  console.error(`No se rotó la clave: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await db.destroy();
}
