// Crea el primer administrador: npm run usuarios:crear-admin -w @sv/api -- <usuario> "<Nombre>"
// Imprime una contraseña temporal una sola vez; se exige cambiarla en el primer inicio de sesión.
import { db } from './db.js';
import { hashClave, passwordTemporal } from '../shared/claves.js';

async function main(): Promise<void> {
  const usuario = (process.argv[2] ?? 'admin').toLowerCase();
  const nombre = process.argv[3] ?? 'Administrador';
  if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) throw new Error('Usuario inválido (3 a 40 letras, números, . _ -)');

  const rol = await db('roles').where('codigo', 'admin').first('id');
  if (!rol) throw new Error('No existe el rol admin. Ejecuta primero: npm run db:seed');
  if (await db('usuarios').where('usuario', usuario).first('id')) throw new Error(`El usuario "${usuario}" ya existe`);

  const temporal = passwordTemporal();
  await db('usuarios').insert({
    usuario,
    nombre,
    password_hash: await hashClave(temporal),
    rol_id: rol.id,
    debe_cambiar_password: true,
  });
  await db('auditoria').insert({ accion: 'usuario.crear_admin_cli', entidad: 'usuario', entidad_id: usuario });

  console.log(`Administrador "${usuario}" creado.`);
  console.log(`Contraseña temporal (se muestra una sola vez): ${temporal}`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
