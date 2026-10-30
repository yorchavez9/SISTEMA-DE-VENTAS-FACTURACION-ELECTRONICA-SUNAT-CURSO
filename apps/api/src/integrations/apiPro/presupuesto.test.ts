import { describe, expect, it } from 'vitest';
import { Presupuesto } from './presupuesto.js';

describe('Presupuesto', () => {
  it('permite N llamadas por minuto y luego obliga a esperar', () => {
    let t = 0;
    const p = new Presupuesto(30, () => t);
    for (let i = 0; i < 30; i++) expect(p.tomar()).toBe(true);
    expect(p.tomar()).toBe(false);
    expect(p.esperaMs()).toBe(2000); // 60 s / 30

    t += 2000;
    expect(p.tomar()).toBe(true);
  });

  it('penalizar bloquea durante los segundos indicados', () => {
    let t = 0;
    const p = new Presupuesto(30, () => t);
    p.penalizar(10);
    expect(p.tomar()).toBe(false);
    t += 10_000;
    expect(p.tomar()).toBe(false); // vuelve a 0, aún falta un token completo
    t += 2000;
    expect(p.tomar()).toBe(true);
  });
});
