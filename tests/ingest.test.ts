import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractHashtags, normalizeTopic } from '../src/lib/hashtags.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const POST_ID = '33333333-3333-4333-8333-333333333333';

const ingestUsers = vi.fn();
const ingestPosts = vi.fn();
const ingestGraph = vi.fn();

vi.mock('../src/modules/ingest/ingest.service.js', () => ({
  userExists: vi.fn(async (id: string) => id === ALICE),
  ingestUsers,
  ingestPosts,
  ingestGraph,
}));

const { createApp } = await import('../src/app.js');

describe('hashtags', () => {
  it('lowercases, deduplicates, and ignores invalid or URL fragment hashes', () => {
    expect(extractHashtags('Building #Algor with #TypeScript and #typescript!')).toEqual([
      'algor',
      'typescript',
    ]);
    expect(extractHashtags('(#rust), [#go], "#web3" #machine_learning #2026')).toEqual([
      'rust',
      'go',
      'web3',
      'machine_learning',
      '2026',
    ]);
    expect(
      extractHashtags('foo#bar https://example.com/#frag https://example.com/a#b # #___'),
    ).toEqual([]);
    expect(extractHashtags(`#${'a'.repeat(50)} #${'b'.repeat(51)}`)).toEqual(['a'.repeat(50)]);
    expect(normalizeTopic(' #TypeScript ')).toBe('typescript');
  });
});

describe('ingest routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates payloads and delegates to ingest service', async () => {
    const app = createApp();

    // Reject empty batches and invalid handles / self-edges
    expect((await request(app).post('/api/ingest/users').send({ users: [] })).status).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/ingest/users')
          .send({ users: [{ handle: 'bad handle!', displayName: 'A' }] })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/ingest/posts')
          .send({ posts: [{ authorId: ALICE, body: '   ' }] })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/ingest/graph')
          .send({ edges: [{ action: 'follow', sourceUserId: ALICE, targetUserId: ALICE }] })
      ).status,
    ).toBe(400);

    // Upsert users
    ingestUsers.mockResolvedValueOnce({
      count: 1,
      users: [{ id: ALICE, handle: 'alice', displayName: 'Alice', bio: null }],
    });
    const usersRes = await request(app)
      .post('/api/ingest/users')
      .send({ users: [{ handle: 'alice', displayName: '  Alice  ' }] });
    expect(usersRes.status).toBe(200);
    expect(ingestUsers).toHaveBeenCalledWith({
      users: [{ handle: 'alice', displayName: 'Alice' }],
    });

    // Ingest posts
    ingestPosts.mockResolvedValueOnce({
      count: 1,
      posts: [
        {
          id: POST_ID,
          authorId: ALICE,
          body: 'Hello #AI',
          replyToId: null,
          topics: ['ai', 'ml'],
        },
      ],
    });
    const postsRes = await request(app)
      .post('/api/ingest/posts')
      .send({
        posts: [{ authorId: ALICE, body: '  Hello #AI  ', topics: ['#ML'] }],
      });
    expect(postsRes.status).toBe(201);
    expect(ingestPosts).toHaveBeenCalledWith({
      posts: [{ authorId: ALICE, body: 'Hello #AI', topics: ['#ML'] }],
    });

    // Apply graph edges
    ingestGraph.mockResolvedValueOnce({ applied: 1 });
    const graphRes = await request(app)
      .post('/api/ingest/graph')
      .send({
        edges: [{ action: 'follow', sourceUserId: ALICE, targetUserId: BOB }],
      });
    expect(graphRes.status).toBe(200);
    expect(graphRes.body).toEqual({ applied: 1 });
  });
});
