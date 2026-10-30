import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { crearApp } from '../../app.js';
import { env } from '../../config/env.js';
import { db } from '../../database/db.js';
import { hashClave } from '../../shared/claves.js';
import { ApiProFalsa } from '../../test/apiProFalsa.js';
import { hayBaseDatos, prepararBdPrueba } from '../../test/bd.js';

const conBd = await hayBaseDatos();
const app = crearApp();
const CLAVE = 'Clave1234';
const TOKEN_JSONPE = 'jsonpe-token-secreto-0001';
const TOKEN_MIGO = 'migo-token-secreto-0002';

/** Respuestas de json.pe y MIGO por número; `estado` fuerza un código HTTP para ese proveedor. */
const fuera = { jsonpe: new Map<string, unknown>(), migo: new Map<string, unknown>(), estado: { jsonpe: 0, migo: 0 }, llamadas: [] as string[] };
function fetchProveedores(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const u = String(url);
  const json = (status: number, cuerpo: unknown) => Promise.resolve(new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } }));
  if (u.startsWith('https://api.json.pe/')) {
    fuera.llamadas.push(`jsonpe ${(init?.headers as Record<string, string>).Authorization}`);
    if (fuera.estado.jsonpe) return json(fuera.estado.jsonpe, { success: false, message: 'Error' });
    const { dni, ruc } = JSON.parse(String(init?.body)) as { dni?: string; ruc?: string };
    const d = fuera.jsonpe.get(dni ?? ruc ?? '');
    return d ? json(200, { success: true, message: 'exito', data: d }) : json(404, { success: false, message: `No se encontró ${dni ? 'DNI' : 'RUC'}` });
  }
  if (u.startsWith('https://api.migo.pe/')) {
    fuera.llamadas.push(`migo ${(init?.headers as Record<string, string>).Authorization}`);
    if (fuera.estado.migo) return json(fuera.estado.migo, { success: false });
    const d = fuera.migo.get(u.split('/').pop()!);
    return d ? json(200, { success: true, ...d }) : json(404, { success: false, message: 'No encontrado' });
  }
  return Promise.reject(new Error(`URL inesperada en la prueba: ${u}`));
}

describe.skipIf(!conBd)('consulta de DNI y RUC con json.pe y MIGO', () => {
  const api = new ApiProFalsa(env.APIPRO_KEY || 'clave-de-pruebas-de-al-menos-20');
  const sesiones: Record<string, { agente: ReturnType<typeof request.agent>; csrf: string }> = {};
  const como = (u: string) => sesiones[u]!;
  const put = (cuerpo: object) => como('admin').agente.put('/api/configuracion/consulta-documentos').set('X-CSRF-Token', como('admin').csrf).send(cuerpo);
  const buscar = (tipoDoc: string, numDoc: string) => como('cajero').agente.get(`/api/clientes/buscar?tipoDoc=${tipoDoc}&numDoc=${numDoc}`);

  beforeAll(async () => {
    await prepararBdPrueba();
    api.instalar();
    api.documentos.set('20100070970', { razon_social: 'DESDE API-PRO SAC', estado: 'ACTIVO', condicion: 'HABIDO' });
    vi.stubGlobal('fetch', vi.fn(fetchProveedores));
    const [s] = await db('sucursales').insert({ nombre: 'Centro', cod_local: '0101' });
    for (const [usuario, rol] of [['admin', 'admin'], ['cajero', 'cajero']] as const) {
      const r = (await db('roles').where('codigo', rol).first('id')).id;
      const [id] = await db('usuarios').insert({ usuario, nombre: usuario, password_hash: await hashClave(CLAVE), rol_id: r, debe_cambiar_password: false });
      await db('usuario_sucursales').insert({ usuario_id: id, sucursal_id: s });
      const agente = request.agent(app);
      const login = await agente.post('/api/auth/login').send({ usuario, password: CLAVE });
      sesiones[usuario] = { agente, csrf: login.body.csrfToken };
    }
  }, 60_000);

  afterEach(() => {
    fuera.estado = { jsonpe: 0, migo: 0 };
    fuera.llamadas = [];
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    api.desinstalar();
    await db.destroy();
  });

  it('sin configurar, la búsqueda sigue usando API-PRO', async () => {
    const res = await buscar('6', '20100070970');
    expect(res.body).toMatchObject({ origen: 'externo', razonSocial: 'DESDE API-PRO SAC', fuente: 'API-PRO' });
    expect(fuera.llamadas).toEqual([]);
  });

  it('guarda los tokens cifrados y solo los muestra enmascarados; no activa sin token', async () => {
    const sinToken = await put({ principal: 'migo', proveedores: [{ codigo: 'migo', activo: true }] });
    expect(sinToken.status).toBe(422);
    expect(sinToken.body.campos['token.migo']).toMatch(/token/);

    const ok = await put({ principal: 'jsonpe', proveedores: [{ codigo: 'jsonpe', activo: true, token: TOKEN_JSONPE }, { codigo: 'migo', activo: true, token: TOKEN_MIGO }] });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual([
      { codigo: 'jsonpe', nombre: 'json.pe', activo: true, orden: 1, token: '••••0001' },
      { codigo: 'migo', nombre: 'MIGO', activo: true, orden: 2, token: '••••0002' },
    ]);
    const fila = await db('proveedores_documento').where('codigo', 'jsonpe').first();
    expect(Buffer.isBuffer(fila.token_enc)).toBe(true);
    expect(fila.token_enc.toString('utf8')).not.toContain(TOKEN_JSONPE);
    const listado = await como('admin').agente.get('/api/configuracion/consulta-documentos');
    expect(JSON.stringify(listado.body)).not.toContain(TOKEN_JSONPE);
    const auditoria = await db('auditoria').where('accion', 'configuracion.consulta_documentos').orderBy('id', 'desc').first();
    expect(JSON.stringify(auditoria)).not.toContain(TOKEN_JSONPE);
    // El cajero no puede ver ni cambiar la configuración.
    expect((await como('cajero').agente.get('/api/configuracion/consulta-documentos')).status).toBe(403);
  });

  it('usa el principal; si falla o no lo encuentra, prueba el otro', async () => {
    fuera.jsonpe.set('27427864', { numero: '27427864', nombre_completo: 'CASTILLO TERRONES, JOSE PEDRO' });
    fuera.migo.set('43451826', { dni: '43451826', nombre: 'CASTILLO GOMES VANESSA SILVIA' });

    const principal = await buscar('1', '27427864');
    expect(principal.body).toMatchObject({ origen: 'externo', razonSocial: 'CASTILLO TERRONES JOSE PEDRO', fuente: 'json.pe' });
    expect(fuera.llamadas).toEqual([`jsonpe Bearer ${TOKEN_JSONPE}`]);

    fuera.llamadas = [];
    const segundo = await buscar('1', '43451826');
    expect(segundo.body).toMatchObject({ razonSocial: 'CASTILLO GOMES VANESSA SILVIA', fuente: 'MIGO' });
    expect(fuera.llamadas).toEqual([`jsonpe Bearer ${TOKEN_JSONPE}`, `migo Bearer ${TOKEN_MIGO}`]);

    fuera.llamadas = [];
    fuera.estado.jsonpe = 401;
    fuera.migo.set('27427864', { dni: '27427864', nombre: 'CASTILLO TERRONES JOSE PEDRO' });
    const caido = await buscar('1', '27427864');
    expect(caido.body).toMatchObject({ fuente: 'MIGO', avisos: [] });
  });

  it('cambia el principal y el orden; avisa del RUC no activo', async () => {
    expect((await put({ principal: 'migo', proveedores: [{ codigo: 'migo', activo: true }] })).status).toBe(200);
    fuera.migo.set('20552103816', { nombre_o_razon_social: 'AGROLIGHT PERU S.A.C.', estado_del_contribuyente: 'SUSPENSION TEMPORAL', condicion_de_domicilio: 'HABIDO', direccion: 'PJ. JORGE BASADRE 158' });
    const res = await buscar('6', '20552103816');
    expect(res.body).toMatchObject({ razonSocial: 'AGROLIGHT PERU S.A.C.', fuente: 'MIGO', estado: 'SUSPENSION TEMPORAL' });
    expect(res.body.avisos.join()).toMatch(/SUSPENSION TEMPORAL/);
    expect(fuera.llamadas).toEqual([`migo Bearer ${TOKEN_MIGO}`]);
  });

  it('nadie lo encuentra → no encontrado sin aviso de error; todos caídos → se ingresa a mano', async () => {
    const nada = await buscar('1', '99887766');
    expect(nada.body).toMatchObject({ origen: 'no_encontrado', avisos: [] });

    fuera.estado = { jsonpe: 503, migo: 429 };
    api.documentoQueFalla = '11223344';
    const caidos = await buscar('1', '11223344');
    expect(caidos.status).toBe(200);
    expect(caidos.body.origen).toBe('no_encontrado');
    expect(caidos.body.avisos.join()).toMatch(/MIGO: se alcanzó el límite.*json\.pe: el servicio no está disponible.*manualmente/);
  });

  it('probar usa el token guardado y no lo devuelve', async () => {
    fuera.jsonpe.set('20552103816', { nombre_o_razon_social: 'AGROLIGHT PERU S.A.C.', direccion_completa: 'SANTA ANITA' });
    const res = await como('admin').agente.post('/api/configuracion/consulta-documentos/probar').set('X-CSRF-Token', como('admin').csrf).send({ codigo: 'jsonpe', tipoDoc: '6', numDoc: '20552103816' });
    expect(res.body).toMatchObject({ resultado: 'encontrado', razonSocial: 'AGROLIGHT PERU S.A.C.' });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN_JSONPE);
    const malo = await como('admin').agente.post('/api/configuracion/consulta-documentos/probar').set('X-CSRF-Token', como('admin').csrf).send({ codigo: 'jsonpe', tipoDoc: '1', numDoc: '123' });
    expect(malo.status).toBe(422);
  });
});
