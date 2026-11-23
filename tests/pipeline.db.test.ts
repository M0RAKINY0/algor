import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SEED_POSTS, SEED_USERS, seedDatabase } from '../scripts/seed.js';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import {
  blocks,
  follows,
  impressions,
  interactions,
  mutes,
  posts,
  postStats,
  postTopics,
  rankingConfig,
  topics,
  userAuthorAffinity,
  users,
  userTopicAffinity,
} from '../src/db/schema.js';
import { computeEngagementScore } from '../src/modules/ranking/ranking.scorer.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const ALICE_UPPER = '11111111-1111-4111-8111-111111111111'.toUpperCase();
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';
const DAVE = '44444444-4444-4444-8444-444444444444';
const COLD_START_USER = '88888888-8888-4888-8888-888888888888';
const BLOCKED_BY_ALICE = '55555555-5555-4555-8555-555555555555';
const BLOCKED_ALICE = '66666666-6666-4666-8666-666666666666';
const MUTED_BY_ALICE = '77777777-7777-4777-8777-777777777777';

const P_ALICE = 'aaaaaaaa-0000-4000-8000-000000000001';
const P_BOB_1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const P_BOB_2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const P_BOB_3 = 'bbbbbbbb-0000-4000-8000-000000000003';
const P_CAROL_SOCIAL = 'cccccccc-0000-4000-8000-000000000001';
const P_DAVE_TOPIC = 'dddddddd-0000-4000-8000-000000000001';
const P_DAVE_HIDDEN = 'dddddddd-0000-4000-8000-000000000002';
const P_DAVE_REPORTED = 'dddddddd-0000-4000-8000-000000000003';
const P_BLOCKED_OUT = 'eeeeeeee-0000-4000-8000-000000000001';
const P_BLOCKED_IN = 'eeeeeeee-0000-4000-8000-000000000002';
const P_MUTED = 'ffffffff-0000-4000-8000-000000000001';

async function resetDb() {
  await db.delete(impressions);
  await db.delete(interactions);
  await db.delete(userAuthorAffinity);
  await db.delete(userTopicAffinity);
  await db.delete(postStats);
  await db.delete(postTopics);
  await db.delete(topics);
  await db.delete(follows);
  await db.delete(blocks);
  await db.delete(mutes);
  await db.delete(posts);
  await db.delete(users);
  await db.delete(rankingConfig);
}

describe('signals, candidates, feed, and seed PostgreSQL integration', () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: './drizzle' });
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await resetDb();
    await pool.end();
  });

  it('records events idempotently, handles uppercase UUIDs, rejects future timestamps, and serves GET /api/signals with no-store', async () => {
    const app = createApp();

    await request(app)
      .post('/api/ingest/users')
      .send({
        users: [
          { id: ALICE, handle: 'alice', displayName: 'Alice' },
          { id: BOB, handle: 'bob', displayName: 'Bob' },
        ],
      });
    await request(app)
      .post('/api/ingest/posts')
      .send({
        posts: [
          { id: P_ALICE, authorId: ALICE, body: 'My own post #typescript' },
          { id: P_BOB_1, authorId: BOB, body: 'Postgres tips #postgres #typescript' },
        ],
      });

    // Missing auth -> 401; unknown post -> 404; future createdAt -> 400
    expect(
      (await request(app).post('/api/events').send({ postId: P_BOB_1, type: 'like' })).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/events')
          .set('x-user-id', ALICE)
          .send({ postId: '99999999-9999-4999-8999-999999999999', type: 'like' })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post('/api/events')
          .set('x-user-id', ALICE)
          .send({ postId: P_BOB_1, type: 'like', createdAt: '2099-01-01T00:00:00.000Z' })
      ).status,
    ).toBe(400);

    // 1. Reply at T0 (+13.5)
    const t0 = new Date('2026-11-10T12:00:00.000Z');
    const r1 = await request(app)
      .post('/api/events')
      .set('x-user-id', ALICE_UPPER)
      .send({ postId: P_BOB_1.toUpperCase(), type: 'reply', createdAt: t0.toISOString() });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ recorded: true, duplicate: false, weight: 13.5 });

    // 2. Like at T0 + 168h (1 author half-life -> 13.5 * 0.5 + 0.5 = 7.25)
    const t1 = new Date(t0.getTime() + 168 * 3_600_000);
    const r2 = await request(app)
      .post('/api/events')
      .set('x-user-id', ALICE)
      .send({ postId: P_BOB_1, type: 'like', createdAt: t1.toISOString() });
    expect(r2.status).toBe(201);

    // 3. Duplicate like -> 200 duplicate: true without double-counting
    const dup = await request(app)
      .post('/api/events')
      .set('x-user-id', ALICE)
      .send({ postId: P_BOB_1, type: 'like', createdAt: t1.toISOString() });
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ recorded: false, duplicate: true });

    // 4. View increments viewCount without changing affinity; profile_click updates affinity without post_stats
    expect(
      (
        await request(app)
          .post('/api/events')
          .set('x-user-id', ALICE)
          .send({ postId: P_BOB_1, type: 'view', createdAt: t1.toISOString() })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(app)
          .post('/api/events')
          .set('x-user-id', ALICE)
          .send({ postId: P_BOB_1, type: 'profile_click', createdAt: t1.toISOString() })
      ).status,
    ).toBe(201);

    // 5. Self-like with UPPERCASE x-user-id must STILL be recognized as self-interaction (no self-affinity)
    expect(
      (
        await request(app)
          .post('/api/events')
          .set('x-user-id', ALICE_UPPER)
          .send({ postId: P_ALICE, type: 'like', createdAt: t1.toISOString() })
      ).status,
    ).toBe(201);

    const [bobStats] = await db.select().from(postStats).where(eq(postStats.postId, P_BOB_1));
    expect(bobStats).toMatchObject({
      replyCount: 1,
      likeCount: 1,
      viewCount: 1,
      repostCount: 0,
      notInterestedCount: 0,
      reportCount: 0,
    });
    expect(bobStats!.engagementScore).toBeCloseTo(14.0, 4);

    // Author affinity: 13.5 * 0.5 + 0.5 + 0.5 = 7.75
    const [authorAff] = await db
      .select()
      .from(userAuthorAffinity)
      .where(and(eq(userAuthorAffinity.userId, ALICE), eq(userAuthorAffinity.authorId, BOB)));
    expect(authorAff?.score).toBeCloseTo(7.75, 3);

    const [selfAff] = await db
      .select()
      .from(userAuthorAffinity)
      .where(and(eq(userAuthorAffinity.userId, ALICE), eq(userAuthorAffinity.authorId, ALICE)));
    expect(selfAff).toBeUndefined();

    const sigRes = await request(app).get('/api/signals?limit=10').set('x-user-id', ALICE_UPPER);
    expect(sigRes.status).toBe(200);
    expect(sigRes.headers['cache-control']).toBe('private, no-store');
    expect(sigRes.body.userId).toBe(ALICE);
    expect(sigRes.body.authors[0].rawScore).toBeCloseTo(7.75, 3);
    expect(sigRes.body.topics.map((t: { name: string }) => t.name).sort()).toEqual([
      'postgres',
      'typescript',
    ]);
  });

  it('computes order-independent affinities for backdated events and handles extreme half-life gaps without dpow underflow', async () => {
    const app = createApp();

    await request(app)
      .post('/api/ingest/users')
      .send({
        users: [
          { id: ALICE, handle: 'alice', displayName: 'Alice' },
          { id: CAROL, handle: 'carol', displayName: 'Carol' },
          { id: BOB, handle: 'bob', displayName: 'Bob' },
        ],
      });
    await request(app)
      .post('/api/ingest/posts')
      .send({ posts: [{ id: P_BOB_1, authorId: BOB, body: 'Order independence #rust' }] });

    const tOld = new Date('2026-11-01T12:00:00.000Z');
    const tNew = new Date(tOld.getTime() + 168 * 3_600_000); // +1 author half-life

    // Alice sends chronological order: reply at tOld, then like at tNew
    await request(app)
      .post('/api/events')
      .set('x-user-id', ALICE)
      .send({ postId: P_BOB_1, type: 'reply', createdAt: tOld.toISOString() });
    await request(app)
      .post('/api/events')
      .set('x-user-id', ALICE)
      .send({ postId: P_BOB_1, type: 'like', createdAt: tNew.toISOString() });

    // Carol sends reverse (backdated) order: like at tNew, then reply at tOld
    await request(app)
      .post('/api/events')
      .set('x-user-id', CAROL)
      .send({ postId: P_BOB_1, type: 'like', createdAt: tNew.toISOString() });
    await request(app)
      .post('/api/events')
      .set('x-user-id', CAROL)
      .send({ postId: P_BOB_1, type: 'reply', createdAt: tOld.toISOString() });

    const [aliceAff] = await db
      .select()
      .from(userAuthorAffinity)
      .where(and(eq(userAuthorAffinity.userId, ALICE), eq(userAuthorAffinity.authorId, BOB)));
    const [carolAff] = await db
      .select()
      .from(userAuthorAffinity)
      .where(and(eq(userAuthorAffinity.userId, CAROL), eq(userAuthorAffinity.authorId, BOB)));

    // Both must equal 13.5 * 0.5 + 0.5 = 7.25 at updatedAt = tNew
    expect(aliceAff?.score).toBeCloseTo(7.25, 4);
    expect(carolAff?.score).toBeCloseTo(7.25, 4);
    expect(carolAff?.updatedAt.toISOString()).toBe(tNew.toISOString());

    // Extreme half-life gap (0.1h half-life over 10 days = 2400 half-lives) must NOT crash dpow()
    expect(
      (
        await request(app)
          .patch('/api/ranking/config')
          .send({ decay: { authorAffinityHalfLifeHours: 0.1, topicAffinityHalfLifeHours: 0.1 } })
      ).status,
    ).toBe(200);

    const tTenDaysLater = new Date(tNew.getTime() + 240 * 3_600_000);
    const longGapRes = await request(app)
      .post('/api/events')
      .set('x-user-id', ALICE)
      .send({ postId: P_BOB_1, type: 'repost', createdAt: tTenDaysLater.toISOString() });
    expect(longGapRes.status).toBe(201);

    const [afterLongGap] = await db
      .select()
      .from(userAuthorAffinity)
      .where(and(eq(userAuthorAffinity.userId, ALICE), eq(userAuthorAffinity.authorId, BOB)));
    // Prior 7.25 decayed to 0 over 2400 half-lives, leaving only the new repost weight (1.0)
    expect(afterLongGap?.score).toBeCloseTo(1.0, 4);
  });

  it('coordinates concurrent POST /api/events and PATCH /api/ranking/config without post_stats drift', async () => {
    const app = createApp();

    await request(app)
      .post('/api/ingest/users')
      .send({
        users: [
          { id: ALICE, handle: 'alice', displayName: 'Alice' },
          { id: BOB, handle: 'bob', displayName: 'Bob' },
          { id: CAROL, handle: 'carol', displayName: 'Carol' },
        ],
      });
    await request(app)
      .post('/api/ingest/posts')
      .send({ posts: [{ id: P_BOB_1, authorId: BOB, body: 'Concurrency check #postgres' }] });

    const results = await Promise.all([
      request(app)
        .post('/api/events')
        .set('x-user-id', ALICE)
        .send({ postId: P_BOB_1, type: 'like' }),
      request(app)
        .post('/api/events')
        .set('x-user-id', CAROL)
        .send({ postId: P_BOB_1, type: 'reply' }),
      request(app)
        .patch('/api/ranking/config')
        .send({ weights: { like: 2.5, reply: 15.25 } }),
    ]);

    for (const r of results) {
      expect([200, 201]).toContain(r.status);
    }

    const activeCfg = (await request(app).get('/api/ranking/config')).body;
    const [stats] = await db.select().from(postStats).where(eq(postStats.postId, P_BOB_1));
    expect(stats?.likeCount).toBe(1);
    expect(stats?.replyCount).toBe(1);
    expect(stats?.engagementScore).toBeCloseTo(
      computeEngagementScore(stats!, activeCfg.weights),
      3,
    );
  });

  it('serves ranked diversified feed, filters blocks (uppercase UUID)/mutes/reports/hidden/own, protects HEAD, handles cold-start, and paginates accurately', async () => {
    const app = createApp();
    const now = Date.now();
    const minsAgo = (m: number) => new Date(now - m * 60_000).toISOString();

    await request(app)
      .post('/api/ingest/users')
      .send({
        users: [
          { id: ALICE, handle: 'alice', displayName: 'Alice' },
          { id: BOB, handle: 'bob', displayName: 'Bob' },
          { id: CAROL, handle: 'carol', displayName: 'Carol' },
          { id: DAVE, handle: 'dave', displayName: 'Dave' },
          { id: COLD_START_USER, handle: 'cold_start', displayName: 'Cold Start' },
          { id: BLOCKED_BY_ALICE, handle: 'blocked_out', displayName: 'Blocked Out' },
          { id: BLOCKED_ALICE, handle: 'blocked_in', displayName: 'Blocked In' },
          { id: MUTED_BY_ALICE, handle: 'muted_user', displayName: 'Muted User' },
        ],
      });

    await request(app)
      .post('/api/ingest/posts')
      .send({
        posts: [
          { id: P_ALICE, authorId: ALICE, body: 'Alice own post #rust', createdAt: minsAgo(1) },
          { id: P_BOB_1, authorId: BOB, body: 'Bob post 1 #rust', createdAt: minsAgo(2) },
          { id: P_BOB_2, authorId: BOB, body: 'Bob post 2 #rust', createdAt: minsAgo(3) },
          { id: P_BOB_3, authorId: BOB, body: 'Bob post 3 #rust', createdAt: minsAgo(4) },
          {
            id: P_CAROL_SOCIAL,
            authorId: CAROL,
            body: 'Carol out-of-network liked by Bob #systems',
            createdAt: minsAgo(5),
          },
          {
            id: P_DAVE_TOPIC,
            authorId: DAVE,
            body: 'Dave out-of-network topic match #rust',
            createdAt: minsAgo(6),
          },
          {
            id: P_DAVE_HIDDEN,
            authorId: DAVE,
            body: 'Dave post Alice marked not interested #rust',
            createdAt: minsAgo(7),
          },
          {
            id: P_DAVE_REPORTED,
            authorId: DAVE,
            body: 'Dave post Alice reported #rust',
            createdAt: minsAgo(8),
          },
          {
            id: P_BLOCKED_OUT,
            authorId: BLOCKED_BY_ALICE,
            body: 'From user Alice blocked #rust',
            createdAt: minsAgo(1),
          },
          {
            id: P_BLOCKED_IN,
            authorId: BLOCKED_ALICE,
            body: 'From user who blocked Alice #rust',
            createdAt: minsAgo(1),
          },
          {
            id: P_MUTED,
            authorId: MUTED_BY_ALICE,
            body: 'From user Alice muted #rust',
            createdAt: minsAgo(1),
          },
        ],
      });

    await request(app)
      .post('/api/ingest/graph')
      .send({
        edges: [
          { action: 'follow', sourceUserId: ALICE, targetUserId: BOB },
          { action: 'block', sourceUserId: ALICE, targetUserId: BLOCKED_BY_ALICE },
          { action: 'block', sourceUserId: BLOCKED_ALICE, targetUserId: ALICE },
          { action: 'mute', sourceUserId: ALICE, targetUserId: MUTED_BY_ALICE },
        ],
      });

    await request(app)
      .post('/api/events')
      .set('x-user-id', ALICE)
      .send({ postId: P_BOB_1, type: 'reply' });
    await request(app)
      .post('/api/events')
      .set('x-user-id', ALICE)
      .send({ postId: P_DAVE_HIDDEN, type: 'not_interested' });
    await request(app)
      .post('/api/events')
      .set('x-user-id', ALICE)
      .send({ postId: P_DAVE_REPORTED, type: 'report' });
    await request(app)
      .post('/api/events')
      .set('x-user-id', BOB)
      .send({ postId: P_CAROL_SOCIAL, type: 'like' });
    await request(app)
      .post('/api/events')
      .set('x-user-id', DAVE)
      .send({ postId: P_CAROL_SOCIAL, type: 'repost' });

    // HEAD /api/feed must be side-effect-free (no impressions logged) and set Cache-Control: private, no-store
    const headRes = await request(app).head('/api/feed').set('x-user-id', ALICE_UPPER);
    expect(headRes.status).toBe(200);
    expect(headRes.headers['cache-control']).toBe('private, no-store');
    expect(await db.select().from(impressions).where(eq(impressions.userId, ALICE))).toHaveLength(
      0,
    );

    // Malformed cursor -> 400
    expect(
      (await request(app).get('/api/feed?cursor=garbage').set('x-user-id', ALICE)).status,
    ).toBe(400);

    // Fetch all 5 eligible posts in debug mode via two pages using UPPERCASE x-user-id
    const page1 = await request(app)
      .get('/api/feed?limit=3&debug=true')
      .set('x-user-id', ALICE_UPPER);
    expect(page1.status).toBe(200);
    expect(page1.headers['cache-control']).toBe('private, no-store');
    expect(page1.body.items).toHaveLength(3);
    expect(page1.body.hasMore).toBe(true);
    expect(typeof page1.body.nextCursor).toBe('string');

    const page2 = await request(app)
      .get(`/api/feed?limit=10&debug=true&cursor=${encodeURIComponent(page1.body.nextCursor)}`)
      .set('x-user-id', ALICE_UPPER);
    expect(page2.status).toBe(200);
    expect(page2.body.hasMore).toBe(false);
    expect(page2.body.nextCursor).toBeNull();

    const page1Ids: string[] = page1.body.items.map((i: { id: string }) => i.id);
    const page2Ids: string[] = page2.body.items.map((i: { id: string }) => i.id);

    // Zero overlap across pages
    for (const id of page1Ids) {
      expect(page2Ids).not.toContain(id);
    }

    // All 6 excluded posts (own, blocked out, blocked in, muted, not_interested, report) must be absent
    const allIds = [...page1Ids, ...page2Ids];
    for (const forbidden of [
      P_ALICE,
      P_BLOCKED_OUT,
      P_BLOCKED_IN,
      P_MUTED,
      P_DAVE_HIDDEN,
      P_DAVE_REPORTED,
    ]) {
      expect(allIds).not.toContain(forbidden);
    }
    expect(allIds.sort()).toEqual([P_BOB_1, P_BOB_2, P_BOB_3, P_CAROL_SOCIAL, P_DAVE_TOPIC].sort());

    // Unconditionally assert Carol's post carried social_proof and socialProofCount=1
    const allItems = [...page1.body.items, ...page2.body.items];
    const carolItem = allItems.find((i: { id: string }) => i.id === P_CAROL_SOCIAL);
    expect(carolItem).toBeDefined();
    expect(carolItem.debug.sources).toContain('social_proof');
    expect(carolItem.debug.raw.socialProofCount).toBe(1);

    // Cold-start user (no follows, no events) still gets non-negative posts, omitting debug when debug=false
    const coldRes = await request(app)
      .get('/api/feed?limit=5&debug=false')
      .set('x-user-id', COLD_START_USER);
    expect(coldRes.status).toBe(200);
    expect(coldRes.body.items.length).toBeGreaterThan(0);
    for (const item of coldRes.body.items) {
      expect(item.debug).toBeUndefined();
      // Reported post (engagementScore < 0) should not surface in trending for cold-start user
      expect(item.id).not.toBe(P_DAVE_REPORTED);
    }
  });

  it('serializes parallel GET /api/feed requests without overlap and computes hasMore accurately at candidateLimit=1', async () => {
    const app = createApp();

    await request(app)
      .post('/api/ingest/users')
      .send({
        users: [
          { id: ALICE, handle: 'alice', displayName: 'Alice' },
          { id: BOB, handle: 'bob', displayName: 'Bob' },
          { id: CAROL, handle: 'carol', displayName: 'Carol' },
        ],
      });
    await request(app)
      .post('/api/ingest/posts')
      .send({
        posts: [
          { id: P_BOB_1, authorId: BOB, body: 'Post 1 #ai' },
          { id: P_BOB_2, authorId: BOB, body: 'Post 2 #ai' },
          { id: P_BOB_3, authorId: BOB, body: 'Post 3 #ai' },
          { id: P_CAROL_SOCIAL, authorId: CAROL, body: 'Post 4 #ai' },
        ],
      });

    // Two concurrent GET /api/feed?limit=2 calls for Alice must produce strictly disjoint pages
    const [resA, resB] = await Promise.all([
      request(app).get('/api/feed?limit=2').set('x-user-id', ALICE),
      request(app).get('/api/feed?limit=2').set('x-user-id', ALICE),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const idsA: string[] = resA.body.items.map((i: { id: string }) => i.id);
    const idsB: string[] = resB.body.items.map((i: { id: string }) => i.id);
    expect(idsA).toHaveLength(2);
    expect(idsB).toHaveLength(2);
    expect(new Set([...idsA, ...idsB]).size).toBe(4);

    // Clear impressions and test candidateLimit=1 with limit=1 across 4 eligible posts
    await db.delete(impressions);
    expect(
      (
        await request(app)
          .patch('/api/ranking/config')
          .send({ diversity: { candidateLimit: 1 } })
      ).status,
    ).toBe(200);

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let step = 0; step < 4; step++) {
      const qs: string = cursor ? `?limit=1&cursor=${encodeURIComponent(cursor)}` : '?limit=1';
      const res = await request(app).get(`/api/feed${qs}`).set('x-user-id', ALICE);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      seen.add(res.body.items[0].id);

      if (step < 3) {
        expect(res.body.hasMore).toBe(true);
        expect(typeof res.body.nextCursor).toBe('string');
      } else {
        expect(res.body.hasMore).toBe(false);
        expect(res.body.nextCursor).toBeNull();
      }
      cursor = res.body.nextCursor as string | null;
    }
    expect(seen.size).toBe(4);

    // Cold-start viewer with 1 nonnegative post and 1 negative-engagement post:
    // lookahead must apply the same source filters so hasMore is false once the nonnegative post is served.
    await db.delete(impressions);
    await db.delete(posts);
    await request(app)
      .post('/api/ingest/posts')
      .send({
        posts: [
          { id: P_BOB_1, authorId: BOB, body: 'Good post #ai' },
          { id: P_CAROL_SOCIAL, authorId: CAROL, body: 'Reported post #ai' },
        ],
      });
    await request(app)
      .post('/api/events')
      .set('x-user-id', BOB)
      .send({ postId: P_CAROL_SOCIAL, type: 'report' });

    const coldOnlyGood = await request(app).get('/api/feed?limit=1').set('x-user-id', ALICE);
    expect(coldOnlyGood.status).toBe(200);
    expect(coldOnlyGood.body.items).toHaveLength(1);
    expect(coldOnlyGood.body.items[0].id).toBe(P_BOB_1);
    expect(coldOnlyGood.body.hasMore).toBe(false);
    expect(coldOnlyGood.body.nextCursor).toBeNull();
  });

  it('reruns seedDatabase() sequentially and concurrently without inflating reply counts or affinities', async () => {
    const [runA, runB] = await Promise.all([
      seedDatabase({ silent: true }),
      seedDatabase({ silent: true }),
    ]);
    expect(runA.recorded + runB.recorded).toBeGreaterThan(0);

    const [statsAfterConcurrent] = await db
      .select()
      .from(postStats)
      .where(eq(postStats.postId, SEED_POSTS[1].id));
    const [affAfterConcurrent] = await db
      .select()
      .from(userAuthorAffinity)
      .where(
        and(
          eq(userAuthorAffinity.userId, SEED_USERS.alice.id),
          eq(userAuthorAffinity.authorId, SEED_USERS.bob.id),
        ),
      );
    expect(statsAfterConcurrent?.replyCount).toBe(1);

    // Subsequent rerun must record 0 new events and preserve exact replyCount & affinity
    const third = await seedDatabase({ silent: true });
    expect(third.recorded).toBe(0);

    const [statsAfterThird] = await db
      .select()
      .from(postStats)
      .where(eq(postStats.postId, SEED_POSTS[1].id));
    const [affAfterThird] = await db
      .select()
      .from(userAuthorAffinity)
      .where(
        and(
          eq(userAuthorAffinity.userId, SEED_USERS.alice.id),
          eq(userAuthorAffinity.authorId, SEED_USERS.bob.id),
        ),
      );

    expect(statsAfterThird?.replyCount).toBe(1);
    expect(statsAfterThird?.engagementScore).toBe(statsAfterConcurrent?.engagementScore);
    expect(affAfterThird?.score).toBe(affAfterConcurrent?.score);
  });
});
