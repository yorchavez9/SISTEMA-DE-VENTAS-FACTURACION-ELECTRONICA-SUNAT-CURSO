import { describe, expect, it } from 'vitest';
import { evaluarOperacion, type ContextoSerie, type SerieEspejo } from './series.reglas.js';

const serie = (p: Partial<SerieEspejo>): SerieEspejo => ({
  id: 1, apiSerieId: 100, tipoDoc: '03', serie: 'B101', propia: true, activo: true,
  predeterminada: false, ultimoCorrelativo: 45, sucursalId: 1, ...p,
});
const sucursal = { id: 1, nombre: 'Centro', apiSucursalId: 14, activo: true };
const ctx = (p: Partial<ContextoSerie> = {}): ContextoSerie => ({ series: [], documentosEnCurso: 0, ...p });

describe('crear', () => {
  it('permite una serie nueva con prefijo correcto en sucursal vinculada', () => {
    const r = evaluarOperacion({ operacion: 'crear', tipoDoc: '03', serie: 'B102', sucursalId: 1, correlativoInicial: 0 }, ctx({ sucursal }));
    expect(r.permitido).toBe(true);
    expect(r.confirmacionRequerida).toBe('B102');
  });

  it('bloquea un prefijo inválido', () => {
    const r = evaluarOperacion({ operacion: 'crear', tipoDoc: '01', serie: 'B102', sucursalId: 1, correlativoInicial: 0 }, ctx({ sucursal }));
    expect(r.permitido).toBe(false);
    expect(r.bloqueos.join()).toMatch(/empezar con F/);
  });

  it('bloquea crear sobre una serie inactiva existente (API-PRO reiniciaría el correlativo)', () => {
    const r = evaluarOperacion(
      { operacion: 'crear', tipoDoc: '03', serie: 'B101', sucursalId: 1, correlativoInicial: 0 },
      ctx({ sucursal, series: [serie({ activo: false })] }),
    );
    expect(r.permitido).toBe(false);
    expect(r.bloqueos.join()).toMatch(/Reactivar/);
  });

  it('bloquea si la sucursal no está vinculada con API-PRO', () => {
    const r = evaluarOperacion(
      { operacion: 'crear', tipoDoc: '03', serie: 'B102', sucursalId: 1, correlativoInicial: 0 },
      ctx({ sucursal: { ...sucursal, apiSucursalId: null } }),
    );
    expect(r.permitido).toBe(false);
  });

  it('advierte sobre los números que se saltan con correlativo inicial', () => {
    const r = evaluarOperacion({ operacion: 'crear', tipoDoc: '03', serie: 'B102', sucursalId: 1, correlativoInicial: 50 }, ctx({ sucursal }));
    expect(r.advertencias.join()).toMatch(/empezará en 51/);
  });
});

describe('correlativo', () => {
  it.each([45, 10, 0])('bloquea bajar o repetir el correlativo (%i ≤ 45)', (n) => {
    const s = serie({});
    expect(evaluarOperacion({ operacion: 'correlativo', serieId: 1, correlativo: n }, ctx({ serie: s, series: [s] })).permitido).toBe(false);
  });

  it('permite subirlo advirtiendo el salto', () => {
    const s = serie({});
    const r = evaluarOperacion({ operacion: 'correlativo', serieId: 1, correlativo: 100 }, ctx({ serie: s, series: [s] }));
    expect(r.permitido).toBe(true);
    expect(r.advertencias.join()).toMatch(/46 a 100/);
  });

  it('bloquea si hay documentos en curso', () => {
    const s = serie({});
    expect(evaluarOperacion({ operacion: 'correlativo', serieId: 1, correlativo: 100 }, ctx({ serie: s, documentosEnCurso: 2 })).permitido).toBe(false);
  });

  it('una serie externa exige confirmación reforzada', () => {
    const s = serie({ propia: false, serie: 'B001', ultimoCorrelativo: 240 });
    const r = evaluarOperacion({ operacion: 'correlativo', serieId: 1, correlativo: 300 }, ctx({ serie: s }));
    expect(r.requiereConfirmacionReforzada).toBe(true);
    expect(r.advertencias.join()).toMatch(/otros sistemas/);
  });
});

describe('mover, activar y predeterminada', () => {
  it('mover bloquea con documentos en curso', () => {
    const s = serie({ sucursalId: 2 });
    expect(evaluarOperacion({ operacion: 'mover', serieId: 1, sucursalId: 1 }, ctx({ serie: s, sucursal, documentosEnCurso: 1 })).permitido).toBe(false);
  });

  it('reactivar conserva la numeración', () => {
    const s = serie({ activo: false });
    const r = evaluarOperacion({ operacion: 'activar', serieId: 1, activo: true }, ctx({ serie: s }));
    expect(r.permitido).toBe(true);
    expect(r.advertencias.join()).toMatch(/próximo número 46/);
  });

  it('una serie externa no puede ser predeterminada', () => {
    const s = serie({ propia: false });
    expect(evaluarOperacion({ operacion: 'predeterminada', serieId: 1 }, ctx({ serie: s })).permitido).toBe(false);
  });
});
