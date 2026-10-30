import type { ClienteDto, ClienteInput, Pagina, ProveedorDto, ProveedorInput, ResultadoBusquedaDocumento, TipoDocTercero } from '@sv/shared';
import type { Knex } from 'knex';
import { db } from '../../database/db.js';
import { logger } from '../../config/logger.js';
import { llamarJson } from '../../integrations/apiPro/llamada.js';
import { obtenerCliente } from '../../integrations/apiPro/proveedor.js';
import { consultarProveedor, nombreProveedor, proveedoresActivos } from '../../integrations/documentos/consulta.js';
import { aImporte } from '../../shared/decimal.js';
import { ErrorApp, errores } from '../../shared/errors.js';

// Clientes y proveedores comparten la misma lógica; solo cambian la tabla y las columnas.

type Fila = Record<string, unknown> & { id: number | string; tipo_doc: TipoDocTercero; num_doc: string };

interface Config<Dto, Input> {
  tabla: 'clientes' | 'proveedores';
  nombre: string;
  aDto: (f: Fila) => Dto;
  columnas: (d: Input) => Record<string, unknown>;
}

const texto = (v: unknown) => (v == null ? null : String(v));
const like = (t: string) => `%${t.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

function crearServicio<Dto, Input extends { tipoDoc: TipoDocTercero; numDoc: string }>(cfg: Config<Dto, Input>) {
  async function obtener(id: number): Promise<Dto> {
    const f = (await db(cfg.tabla).where('id', id).first()) as Fila | undefined;
    if (!f) throw errores.noEncontrado(cfg.nombre);
    return cfg.aDto(f);
  }

  async function validarUnico(d: Input, id?: number): Promise<void> {
    const dup = await db(cfg.tabla).where({ tipo_doc: d.tipoDoc, num_doc: d.numDoc }).modify((q) => id && q.whereNot('id', id)).first('id', 'razon_social');
    if (dup) {
      throw new ErrorApp(409, 'DUPLICADO', `Ya existe ${cfg.nombre.toLowerCase()} con ese documento: ${dup.razon_social}`, { numDoc: 'Documento ya registrado' }, { id: Number(dup.id) });
    }
  }

  return {
    obtener,

    async listar(f: { page: number; pageSize: number; q?: string; activo?: 'true' | 'false' | 'todos' }): Promise<Pagina<Dto>> {
      const filtrar = (q: Knex.QueryBuilder) => {
        if (f.activo !== 'todos') q.where('activo', f.activo !== 'false');
        if (f.q) q.where((w) => w.whereILike('razon_social', like(f.q!)).orWhere('num_doc', 'like', `${f.q!.replace(/[\\%_]/g, '')}%`));
      };
      const [{ total }] = (await db(cfg.tabla).modify(filtrar).count({ total: '*' })) as [{ total: number }];
      const filas = (await db(cfg.tabla).modify(filtrar).orderBy('razon_social').limit(f.pageSize).offset((f.page - 1) * f.pageSize)) as Fila[];
      return { data: filas.map(cfg.aDto), page: f.page, pageSize: f.pageSize, total: Number(total) };
    },

    /** `conn` permite crear dentro de la transacción de quien llama (p. ej. el cliente nuevo de una venta). */
    async crear(d: Input, conn: Knex = db): Promise<Dto> {
      await validarUnico(d);
      try {
        const [id] = await conn(cfg.tabla).insert(cfg.columnas(d));
        const f = (await conn(cfg.tabla).where('id', id).first()) as Fila;
        return cfg.aDto(f);
      } catch (err) {
        // Dos altas simultáneas del mismo documento: gana la primera.
        if ((err as { code?: string }).code === 'ER_DUP_ENTRY') await validarUnico(d);
        throw err;
      }
    },

    async editar(id: number, d: Input): Promise<{ antes: Dto; despues: Dto }> {
      const antes = await obtener(id);
      await validarUnico(d, id);
      await db(cfg.tabla).where('id', id).update(cfg.columnas(d));
      return { antes, despues: await obtener(id) };
    },

    /**
     * Busca primero en la base local; si no está y es DNI o RUC, consulta json.pe / MIGO (según
     * Configuración) y, de respaldo, API-PRO (GET /buscar-documento). No crea el registro.
     */
    async buscar(tipoDoc: TipoDocTercero, numDoc: string, conExterno = true): Promise<ResultadoBusquedaDocumento> {
      const base = { tipoDoc, numDoc, estado: null, condicion: null, avisos: [] as string[] };
      const local = (await db(cfg.tabla).where({ tipo_doc: tipoDoc, num_doc: numDoc }).first()) as Fila | undefined;
      if (local) {
        const avisos = local.activo ? [] : [`${cfg.nombre} desactivado`];
        return { ...base, origen: 'local', id: Number(local.id), razonSocial: texto(local.razon_social), direccion: texto(local.direccion), avisos };
      }
      if (!conExterno || (tipoDoc !== '1' && tipoDoc !== '6')) return { ...base, origen: 'no_encontrado', id: null, razonSocial: null, direccion: null };

      const avisosRuc = (estado: string | null, condicion: string | null) => {
        const avisos: string[] = [];
        if (tipoDoc === '6' && estado && estado.toUpperCase() !== 'ACTIVO') avisos.push(`El RUC figura como ${estado} en SUNAT.`);
        if (tipoDoc === '6' && condicion && condicion.toUpperCase() !== 'HABIDO') avisos.push(`Condición del contribuyente: ${condicion}.`);
        return avisos;
      };

      // 1) json.pe y MIGO, en el orden configurado: el primero que encuentra gana; si uno no lo
      //    encuentra o falla (token, créditos, tiempo), se prueba el siguiente.
      const fallos: string[] = [];
      let alguienNoLoEncontro = false;
      for (const p of await proveedoresActivos()) {
        const r = await consultarProveedor(p, tipoDoc, numDoc);
        if (r.tipo === 'encontrado') {
          const { razonSocial, direccion, estado, condicion } = r.datos;
          return { ...base, origen: 'externo', id: null, razonSocial, direccion, estado, condicion, fuente: nombreProveedor(p.codigo), avisos: avisosRuc(estado, condicion) };
        }
        if (r.tipo === 'no_encontrado') alguienNoLoEncontro = true;
        else {
          fallos.push(`${nombreProveedor(p.codigo)}: ${r.motivo}`);
          logger.warn({ proveedor: p.codigo, motivo: r.motivo }, 'consulta de documento fallida');
        }
      }

      // 2) API-PRO como respaldo (consulta SUNAT/RENIEC).
      try {
        const { datos } = await llamarJson<{ razon_social: string; direccion?: string; estado?: string; condicion?: string }>(
          await obtenerCliente(),
          'GET',
          `/buscar-documento?tipo=${tipoDoc}&numero=${encodeURIComponent(numDoc)}`,
          { operacion: 'documento.buscar' },
        );
        return {
          ...base,
          origen: 'externo',
          id: null,
          razonSocial: datos.razon_social,
          direccion: datos.direccion || null,
          estado: datos.estado || null,
          condicion: datos.condicion || null,
          fuente: 'API-PRO',
          avisos: avisosRuc(datos.estado || null, datos.condicion || null),
        };
      } catch (err) {
        const vacio = { ...base, origen: 'no_encontrado' as const, id: null, razonSocial: null, direccion: null };
        if (err instanceof ErrorApp && err.status === 404) return vacio;
        // Un proveedor ya respondió que el número no existe: no es un fallo de conexión.
        if (alguienNoLoEncontro) return vacio;
        // Si la consulta externa falla, se puede registrar el tercero a mano: no se bloquea la operación.
        const motivo = err instanceof ErrorApp ? err.message : 'error de conexión';
        return { ...vacio, avisos: [`No se pudo consultar ${tipoDoc === '1' ? 'el DNI' : 'el RUC'} (${[...fallos, `API-PRO: ${motivo}`].join(' · ')}). Ingresa los datos manualmente.`] };
      }
    },
  };
}

export const clientes = crearServicio<ClienteDto, ClienteInput>({
  tabla: 'clientes',
  nombre: 'Cliente',
  aDto: (f) => ({
    id: Number(f.id),
    tipoDoc: f.tipo_doc,
    numDoc: f.num_doc,
    razonSocial: String(f.razon_social),
    direccion: texto(f.direccion),
    ubigeo: texto(f.ubigeo),
    email: texto(f.email),
    telefono: texto(f.telefono),
    limiteCredito: texto(f.limite_credito),
    monedaCredito: (f.moneda_credito as 'PEN' | 'USD' | null) ?? null,
    activo: Boolean(f.activo),
  }),
  columnas: (d) => ({
    tipo_doc: d.tipoDoc,
    num_doc: d.numDoc,
    razon_social: d.razonSocial,
    direccion: d.direccion ?? null,
    ubigeo: d.ubigeo ?? null,
    email: d.email ?? null,
    telefono: d.telefono ?? null,
    limite_credito: d.limiteCredito ? aImporte(d.limiteCredito) : null,
    moneda_credito: d.limiteCredito ? (d.monedaCredito ?? null) : null,
    activo: d.activo,
  }),
});

export const proveedores = crearServicio<ProveedorDto, ProveedorInput>({
  tabla: 'proveedores',
  nombre: 'Proveedor',
  aDto: (f) => ({
    id: Number(f.id),
    tipoDoc: f.tipo_doc,
    numDoc: f.num_doc,
    razonSocial: String(f.razon_social),
    direccion: texto(f.direccion),
    contacto: texto(f.contacto),
    email: texto(f.email),
    telefono: texto(f.telefono),
    activo: Boolean(f.activo),
  }),
  columnas: (d) => ({
    tipo_doc: d.tipoDoc,
    num_doc: d.numDoc,
    razon_social: d.razonSocial,
    direccion: d.direccion ?? null,
    contacto: d.contacto ?? null,
    email: d.email ?? null,
    telefono: d.telefono ?? null,
    activo: d.activo,
  }),
});
