import { PROVEEDORES_DOCUMENTO, type ProveedorDocumento, type ProveedorDocumentoDto, type ProveedoresDocumentoInput, type PruebaProveedorDocumentoDto } from '@sv/shared';
import { db } from '../../database/db.js';
import { consultarProveedor } from '../../integrations/documentos/consulta.js';
import { cifrar, descifrar, enmascarar } from '../../shared/crypto.js';
import { errores } from '../../shared/errors.js';

// Configuración de json.pe y MIGO para consultar DNI y RUC. El token entra una vez y se guarda
// cifrado; hacia la web solo sale enmascarado.

interface Fila {
  codigo: ProveedorDocumento;
  activo: number | boolean;
  orden: number;
  token_enc: Buffer | null;
}

export async function listar(): Promise<ProveedorDocumentoDto[]> {
  const filas = (await db('proveedores_documento').orderBy('orden')) as Fila[];
  return filas
    .filter((f) => f.codigo in PROVEEDORES_DOCUMENTO)
    .map((f) => ({ codigo: f.codigo, nombre: PROVEEDORES_DOCUMENTO[f.codigo], activo: Boolean(f.activo), orden: f.orden, token: f.token_enc ? enmascarar(descifrar(f.token_enc)) : null }));
}

/** Guarda activo/token de cada proveedor y pone primero al principal. No se activa uno sin token. */
export async function guardar(d: ProveedoresDocumentoInput): Promise<void> {
  await db.transaction(async (trx) => {
    const actuales = new Map(((await trx('proveedores_documento').forUpdate()) as Fila[]).map((f) => [f.codigo, f]));
    for (const p of d.proveedores) {
      const fila = actuales.get(p.codigo);
      if (!fila) throw errores.noEncontrado('Proveedor');
      const tendraToken = p.token ? true : p.quitarToken ? false : Boolean(fila.token_enc);
      if (p.activo && !tendraToken) throw errores.validacion({ [`token.${p.codigo}`]: `Ingresa el token de ${PROVEEDORES_DOCUMENTO[p.codigo]} para activarlo` });
      const cambios: Record<string, unknown> = { activo: p.activo };
      if (p.token) cambios.token_enc = cifrar(p.token);
      else if (p.quitarToken) cambios.token_enc = null;
      await trx('proveedores_documento').where('codigo', p.codigo).update(cambios);
    }
    const orden = [d.principal, ...[...actuales.keys()].filter((c) => c !== d.principal)];
    for (const [i, codigo] of orden.entries()) await trx('proveedores_documento').where('codigo', codigo).update({ orden: i + 1 });
  });
}

/** Consulta de prueba con el token guardado (gasta una consulta del plan del proveedor). */
export async function probar(codigo: ProveedorDocumento, tipoDoc: '1' | '6', numDoc: string): Promise<PruebaProveedorDocumentoDto> {
  const fila = (await db('proveedores_documento').where('codigo', codigo).first()) as Fila | undefined;
  if (!fila) throw errores.noEncontrado('Proveedor');
  if (!fila.token_enc) throw errores.validacion({ [`token.${codigo}`]: 'Guarda primero el token' });
  const inicio = Date.now();
  const r = await consultarProveedor({ codigo, token: descifrar(fila.token_enc) }, tipoDoc, numDoc);
  const duracionMs = Date.now() - inicio;
  if (r.tipo === 'encontrado') return { resultado: 'encontrado', razonSocial: r.datos.razonSocial, direccion: r.datos.direccion, mensaje: null, duracionMs };
  if (r.tipo === 'no_encontrado') return { resultado: 'no_encontrado', razonSocial: null, direccion: null, mensaje: 'El token funciona, pero no encontró ese número.', duracionMs };
  return { resultado: 'error', razonSocial: null, direccion: null, mensaje: r.motivo, duracionMs };
}
