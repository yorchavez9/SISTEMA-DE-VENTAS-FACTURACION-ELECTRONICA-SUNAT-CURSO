import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { cifrar, descifrar, enmascarar, recifrar } from './crypto.js';

describe('crypto', () => {
  it('cifra y descifra (ida y vuelta)', () => {
    const secreto = 'secreto-de-prueba-123';
    const c = cifrar(secreto);
    expect(c.toString('utf8')).not.toContain(secreto);
    expect(descifrar(c)).toBe(secreto);
  });

  it('usa un IV distinto en cada cifrado', () => {
    expect(cifrar('x').equals(cifrar('x'))).toBe(false);
  });

  it('detecta manipulación', () => {
    const c = cifrar('dato');
    c[c.length - 1] = (c[c.length - 1] ?? 0) ^ 0xff;
    expect(() => descifrar(c)).toThrow();
  });

  it('rotación: recifra con la clave nueva y la anterior ya no sirve', () => {
    const nueva = randomBytes(32);
    const r = recifrar(cifrar('clave-api'), nueva);
    expect(descifrar(r, nueva)).toBe('clave-api');
    expect(() => descifrar(r)).toThrow();
  });

  it('enmascara mostrando solo los últimos 4', () => {
    expect(enmascarar('abcdefgh1234')).toBe('••••1234');
  });
});
