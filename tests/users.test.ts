import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

const ALICE = '11111111-1111-4111-8111-111111111111';

// No database: stub the service so the test covers routing, validation and the x-user-id check.
vi.mock('../src/modules/users/users.service.js', () => ({
  userExists: vi.fn(async (id: string) => id === ALICE),
  getProfileById: vi.fn(async (id: string) => ({ id, handle: 'alice' })),
  getProfileByHandle: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
}));

const { createApp } = await import('../src/app.js');

describe('users routes', () => {
  it('rejects bad input and resolves /me from the x-user-id header', async () => {
    const app = createApp();

    const badHandle = await request(app)
      .post('/api/users')
      .send({ handle: 'no spaces!', displayName: 'A' });
    expect(badHandle.status).toBe(400);

    expect((await request(app).get('/api/users/me')).status).toBe(401);
    expect((await request(app).get('/api/users/me').set('x-user-id', 'abc')).status).toBe(401);
    expect(
      (await request(app).get('/api/users/me').set('x-user-id', crypto.randomUUID())).status,
    ).toBe(401);

    const me = await request(app).get('/api/users/me').set('x-user-id', ALICE);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ id: ALICE, handle: 'alice' });
  });
});
