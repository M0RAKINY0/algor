import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('app', () => {
  it('answers /health and returns JSON 404 for unknown routes', async () => {
    const app = createApp();

    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok' });

    const missing = await request(app).get('/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatch(/not found/);
  });
});
