import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../src/middleware/error.js';

const ALICE = '11111111-1111-4111-8111-111111111111';

vi.mock('../src/modules/ingest/ingest.service.js', () => ({
  userExists: vi.fn(async (id: string) => id === ALICE),
}));

const { currentUserId, requireUser } = await import('../src/middleware/auth.js');

describe('requireUser middleware', () => {
  it('enforces a valid existing x-user-id UUID header', async () => {
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
  });
});
