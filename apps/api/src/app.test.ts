import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { rucValido } from '@sv/shared';
import { crearApp } from './app.js';
import { db } from './database/db.js';

afterAll(async () => {
  await db.destroy();
});

describe('app', () => {
  const app = crearApp();

  it('GET /api/health responde con el estado de la base de datos', async () => {
    const res = await request(app).get('/api/health');
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('baseDatos');
  });

  it('sin sesión, una ruta desconocida no revela si existe (401 con el formato único)', async () => {
    const res = await request(app).get('/api/no-existe');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ codigo: 'NO_AUTENTICADO' });
    expect(res.body.requestId).toBeTruthy();
  });

  it('JSON mal formado → 400', async () => {
    const res = await request(app).post('/api/no-existe').set('Content-Type', 'application/json').send('{mal');
    expect(res.status).toBe(400);
    expect(res.body.codigo).toBe('SOLICITUD_INVALIDA');
  });
});

describe('rucValido', () => {
  it('valida el dígito verificador', () => {
    expect(rucValido('20161515648')).toBe(true); // RUC de la empresa
    expect(rucValido('20161515649')).toBe(false);
    expect(rucValido('30161515648')).toBe(false);
    expect(rucValido('2016151564')).toBe(false);
  });
});
