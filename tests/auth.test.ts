import { Writable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/lib/logger.js';
import { errorHandler } from '../src/middleware/error.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const ALICE_UPPER = '11111111-1111-4111-8111-111111111111'.toUpperCase();

vi.mock('../src/modules/ingest/ingest.service.js', () => ({
  userExists: vi.fn(async (id: string) => id === ALICE),
}));

const { createRequireAdmin, createRequireUser, currentUserId, requireUser } =
  await import('../src/middleware/auth.js');

describe('requireUser middleware', () => {
  it('enforces a valid existing x-user-id UUID header and canonicalizes UUID casing to lowercase', async () => {
    const app = express();
    app.get('/whoami', requireUser, (req, res) => {
      res.json({ userId: currentUserId(req) });
    });
    app.use(errorHandler);

    expect((await request(app).get('/whoami')).status).toBe(401);
    expect((await request(app).get('/whoami').set('x-user-id', 'not-a-uuid')).status).toBe(401);
    expect((await request(app).get('/whoami').set('x-user-id', crypto.randomUUID())).status).toBe(
      401,
    );

    const ok = await request(app).get('/whoami').set('x-user-id', ALICE);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ userId: ALICE });

    const upperOk = await request(app).get('/whoami').set('x-user-id', ALICE_UPPER);
    expect(upperOk.status).toBe(200);
    expect(upperOk.body).toEqual({ userId: ALICE });
  });

  it('requires x-internal-key when configured and fails closed in production if unset', async () => {
    const makeApp = (internalApiKey: string | undefined, nodeEnv: string) => {
      const app = express();
      app.get(
        '/whoami',
        createRequireUser(
          () => ({ internalApiKey, nodeEnv }),
          async (id) => id === ALICE,
        ),
        (req, res) => {
          res.json({ userId: currentUserId(req) });
        },
      );
      app.use(errorHandler);
      return app;
    };

    const prodUnconfigured = makeApp(undefined, 'production');
    expect((await request(prodUnconfigured).get('/whoami').set('x-user-id', ALICE)).status).toBe(
      503,
    );

    const gatewaySecured = makeApp('gateway-secret-123', 'production');
    expect((await request(gatewaySecured).get('/whoami').set('x-user-id', ALICE)).status).toBe(401);
    expect(
      (
        await request(gatewaySecured)
          .get('/whoami')
          .set('x-user-id', ALICE)
          .set('x-internal-key', 'wrong')
      ).status,
    ).toBe(401);
    const ok = await request(gatewaySecured)
      .get('/whoami')
      .set('x-user-id', ALICE_UPPER)
      .set('x-internal-key', 'gateway-secret-123');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ userId: ALICE });
  });
});

describe('createRequireAdmin middleware & log redaction', () => {
  it('enforces x-admin-key when configured and fails closed in production if unset', async () => {
    const makeApp = (apiKey: string | undefined, nodeEnv: string) => {
      const app = express();
      app.post(
        '/admin',
        createRequireAdmin(() => ({ apiKey, nodeEnv })),
        (_req, res) => {
          res.json({ ok: true });
        },
      );
      app.use(errorHandler);
      return app;
    };

    // Configured key: rejects missing or wrong key, accepts exact match
    const secured = makeApp('super-secret-key', 'development');
    expect((await request(secured).post('/admin')).status).toBe(401);
    expect((await request(secured).post('/admin').set('x-admin-key', 'wrong')).status).toBe(401);
    expect(
      (await request(secured).post('/admin').set('x-admin-key', 'super-secret-key')).status,
    ).toBe(200);

    // Production without key: fails closed
    const prodUnconfigured = makeApp(undefined, 'production');
    expect((await request(prodUnconfigured).post('/admin')).status).toBe(503);

    // Non-production without key: open for local dev/testing
    const devOpen = makeApp(undefined, 'development');
    expect((await request(devOpen).post('/admin')).status).toBe(200);
  });

  it('redacts x-admin-key, x-internal-key, and authorization headers in Pino HTTP request logs', async () => {
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });

    const app = createApp({
      logger: createLogger({ level: 'info' }, destination),
    });

    const adminSecret = 'super-secret-admin-key-xyz';
    const internalSecret = 'super-secret-internal-key-abc';
    const bearer = 'Bearer top-secret-jwt-token';

    const res = await request(app)
      .get('/health')
      .set('x-admin-key', adminSecret)
      .set('x-internal-key', internalSecret)
      .set('authorization', bearer);

    expect(res.status).toBe(200);

    const logOutput = chunks.join('');
    expect(logOutput).toContain('[REDACTED]');
    expect(logOutput).not.toContain(adminSecret);
    expect(logOutput).not.toContain(internalSecret);
    expect(logOutput).not.toContain(bearer);
  });
});
