import { describe, expect, it } from 'vitest';
import { consultarProveedor } from './consulta.js';

/** fetch falso: guarda la llamada y responde lo indicado. */
function falso(status: number, cuerpo: unknown) {
  const llamadas: Array<{ url: string; init: RequestInit }> = [];
  const buscar = (async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { buscar, llamadas };
}

const TOKEN = 'token-de-pruebas-123';

describe('json.pe', () => {
  it('DNI: POST /api/dni con Bearer; nombre en orden apellidos y nombres', async () => {
    const f = falso(200, { success: true, message: 'exito', data: { numero: '27427864', nombre_completo: 'CASTILLO TERRONES, JOSE PEDRO', nombres: 'JOSE PEDRO', direccion: '', direccion_completa: '' } });
    const r = await consultarProveedor({ codigo: 'jsonpe', token: TOKEN }, '1', '27427864', f.buscar);
    expect(r).toEqual({ tipo: 'encontrado', datos: { razonSocial: 'CASTILLO TERRONES JOSE PEDRO', direccion: null, estado: null, condicion: null } });
    expect(f.llamadas[0]!.url).toBe('https://api.json.pe/api/dni');
    expect(f.llamadas[0]!.init.method).toBe('POST');
    expect(f.llamadas[0]!.init.body).toBe(JSON.stringify({ dni: '27427864' }));
    expect((f.llamadas[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('RUC: razón social, dirección completa, estado y condición', async () => {
    const f = falso(200, {
      success: true,
      data: { ruc: '20552103816', nombre_o_razon_social: 'AGROLIGHT PERU S.A.C.', estado: 'SUSPENSION TEMPORAL', condicion: 'HABIDO', direccion: 'PJ. JORGE BASADRE NRO. 158', direccion_completa: 'PJ. JORGE BASADRE NRO. 158, LIMA - LIMA - SANTA ANITA' },
    });
    const r = await consultarProveedor({ codigo: 'jsonpe', token: TOKEN }, '6', '20552103816', f.buscar);
    expect(r).toEqual({ tipo: 'encontrado', datos: { razonSocial: 'AGROLIGHT PERU S.A.C.', direccion: 'PJ. JORGE BASADRE NRO. 158, LIMA - LIMA - SANTA ANITA', estado: 'SUSPENSION TEMPORAL', condicion: 'HABIDO' } });
    expect(f.llamadas[0]!.url).toBe('https://api.json.pe/api/ruc');
  });

  it('404 "No se encontró" es no encontrado; otro 404 es token inválido', async () => {
    expect(await consultarProveedor({ codigo: 'jsonpe', token: TOKEN }, '1', '11111111', falso(404, { success: false, message: 'No se encontró DNI' }).buscar)).toEqual({ tipo: 'no_encontrado' });
    expect(await consultarProveedor({ codigo: 'jsonpe', token: TOKEN }, '1', '11111111', falso(404, { success: false, message: 'Unauthenticated' }).buscar)).toEqual({ tipo: 'error', motivo: 'token inválido o sin créditos' });
  });
});

describe('MIGO', () => {
  it('DNI: GET /api/v2/dni/{n}', async () => {
    const f = falso(200, { success: true, dni: '43451826', nombre: 'CASTILLO GOMES VANESSA SILVIA' });
    const r = await consultarProveedor({ codigo: 'migo', token: TOKEN }, '1', '43451826', f.buscar);
    expect(r).toEqual({ tipo: 'encontrado', datos: { razonSocial: 'CASTILLO GOMES VANESSA SILVIA', direccion: null, estado: null, condicion: null } });
    expect(f.llamadas[0]!.url).toBe('https://api.migo.pe/api/v2/dni/43451826');
    expect(f.llamadas[0]!.init.method).toBe('GET');
  });

  it('RUC: estado_del_contribuyente y condicion_de_domicilio; espacios dobles fuera', async () => {
    const f = falso(200, {
      success: true,
      ruc: '20603274742',
      nombre_o_razon_social: 'MIGO SOCIEDAD ANONIMA CERRADA - MIGO S.A.C.',
      estado_del_contribuyente: 'ACTIVO',
      condicion_de_domicilio: 'HABIDO',
      direccion: 'AV. JORGE CHAVEZ NRO. 204 URB.  JORGE CHAVEZ - AREQUIPA AREQUIPA PAUCARPATA',
    });
    const r = await consultarProveedor({ codigo: 'migo', token: TOKEN }, '6', '20603274742', f.buscar);
    expect(r).toEqual({ tipo: 'encontrado', datos: { razonSocial: 'MIGO SOCIEDAD ANONIMA CERRADA - MIGO S.A.C.', direccion: 'AV. JORGE CHAVEZ NRO. 204 URB. JORGE CHAVEZ - AREQUIPA AREQUIPA PAUCARPATA', estado: 'ACTIVO', condicion: 'HABIDO' } });
  });

  it('404 y 422 son no encontrado; 401/403, 429 y 5xx son errores con motivo claro', async () => {
    const p = { codigo: 'migo' as const, token: TOKEN };
    expect(await consultarProveedor(p, '6', '20603274742', falso(404, {}).buscar)).toEqual({ tipo: 'no_encontrado' });
    expect(await consultarProveedor(p, '6', '20603274742', falso(422, {}).buscar)).toEqual({ tipo: 'no_encontrado' });
    expect(await consultarProveedor(p, '6', '20603274742', falso(403, {}).buscar)).toEqual({ tipo: 'error', motivo: 'token inválido o sin créditos' });
    expect(await consultarProveedor(p, '6', '20603274742', falso(429, {}).buscar)).toEqual({ tipo: 'error', motivo: 'se alcanzó el límite de consultas' });
    expect(await consultarProveedor(p, '6', '20603274742', falso(503, {}).buscar)).toEqual({ tipo: 'error', motivo: 'el servicio no está disponible' });
  });
});

it('sin conexión o sin respuesta a tiempo no lanza', async () => {
  const caido = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const lento = (async () => {
    throw new DOMException('timeout', 'TimeoutError');
  }) as typeof fetch;
  expect(await consultarProveedor({ codigo: 'jsonpe', token: TOKEN }, '1', '12345678', caido)).toEqual({ tipo: 'error', motivo: 'no se pudo conectar' });
  expect(await consultarProveedor({ codigo: 'migo', token: TOKEN }, '1', '12345678', lento)).toEqual({ tipo: 'error', motivo: 'no respondió a tiempo' });
});
