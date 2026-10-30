import { env } from '../../config/env.js';
import { db } from '../../database/db.js';
import { descifrar } from '../../shared/crypto.js';
import { ErrorApp } from '../../shared/errors.js';
import { ClienteApiPro, type Credenciales } from './cliente.js';

export type OrigenCredenciales = 'base_datos' | 'env' | 'ninguno';

/**
 * Credenciales vigentes: primero las cifradas en la tabla empresa (producción);
 * si no hay, las de apps/api/.env (desarrollo).
 */
export async function credencialesVigentes(): Promise<{ cred: Credenciales | null; origen: OrigenCredenciales }> {
  const e = await db('empresa').first('apipro_base_url', 'apipro_key_enc', 'apipro_secret_enc');
  if (e?.apipro_key_enc && e?.apipro_secret_enc) {
    return {
      cred: {
        baseUrl: e.apipro_base_url ?? env.APIPRO_BASE_URL,
        apiKey: descifrar(e.apipro_key_enc as Buffer),
        apiSecret: descifrar(e.apipro_secret_enc as Buffer),
      },
      origen: 'base_datos',
    };
  }
  if (env.APIPRO_KEY && env.APIPRO_SECRET) {
    return { cred: { baseUrl: env.APIPRO_BASE_URL, apiKey: env.APIPRO_KEY, apiSecret: env.APIPRO_SECRET }, origen: 'env' };
  }
  return { cred: null, origen: 'ninguno' };
}

type Fabrica = (cred: Credenciales) => ClienteApiPro;
let fabrica: Fabrica = (cred) => new ClienteApiPro(cred);

/** Solo para pruebas: reemplaza el cliente real por uno con un fetch simulado. */
export function fijarFabricaClienteParaPruebas(f: Fabrica | null): void {
  fabrica = f ?? ((cred) => new ClienteApiPro(cred));
}

export function crearCliente(cred: Credenciales): ClienteApiPro {
  return fabrica(cred);
}

export async function obtenerCliente(): Promise<ClienteApiPro> {
  const { cred } = await credencialesVigentes();
  if (!cred) throw new ErrorApp(409, 'APIPRO_SIN_CREDENCIALES', 'Configura las credenciales de API-PRO en Configuración → Conexión API');
  return fabrica(cred);
}
