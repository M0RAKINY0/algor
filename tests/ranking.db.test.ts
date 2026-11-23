import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DEFAULT_RANKING_CONFIG } from '../src/config/ranking.js';
import { db, pool } from '../src/db/index.js';
import { posts, postStats, rankingConfig, users } from '../src/db/schema.js';
import { computeEngagementScore } from '../src/modules/ranking/ranking.scorer.js';

const ALICE_ID = '11111111-1111-4111-8111-111111111111';
const POST_ID = '33333333-3333-4333-8333-333333333333';

const SEEDED_STATS = {
  viewCount: 50,
  likeCount: 7,
  replyCount: 3,
  repostCount: 5,
  notInterestedCount: 1,
  reportCount: 0,
};

async function seedPostWithStats(updatedAt = new Date('2025-01-01T00:00:00.000Z')) {
  await db.insert(users).values({
    id: ALICE_ID,
    handle: 'alice_rank_test',
    displayName: 'Alice',
  });
  await db.insert(posts).values({
    id: POST_ID,
    authorId: ALICE_ID,
    body: 'Testing PostgreSQL ranking config recompute',
  });
  await db.insert(postStats).values({
    postId: POST_ID,
    ...SEEDED_STATS,
    engagementScore: computeEngagementScore(SEEDED_STATS, DEFAULT_RANKING_CONFIG.weights),
    updatedAt,
  });
}

describe('ranking config PostgreSQL integration', () => {
  beforeAll(async () => {
    await migrate(db, { migrationsFolder: './drizzle' });
  });

  beforeEach(async () => {
    await db.delete(rankingConfig);
    await db.delete(postStats);
    await db.delete(posts);
    await db.delete(users);
  });

  afterAll(async () => {
    await db.delete(rankingConfig);
    await db.delete(postStats);
    await db.delete(posts);
    await db.delete(users);
    await pool.end();
  });

  it('applies fractional weights on PATCH and reset and matches TypeScript computeEngagementScore', async () => {
    await seedPostWithStats();
    const app = createApp();

    const patchRes = await request(app)
      .patch('/api/ranking/config')
      .send({
        weights: {
          reply: 13.75,
          repost: 1.5,
          like: 0.25,
          view: 0.05,
          not_interested: -74.5,
          report: -369.25,
        },
      });
    expect(patchRes.status).toBe(200);

    const [afterPatch] = await db.select().from(postStats).where(eq(postStats.postId, POST_ID));
    expect(afterPatch?.engagementScore).toBeCloseTo(
      computeEngagementScore(SEEDED_STATS, patchRes.body.weights),
      3,
    );

    // Reset restores fractional defaults (13.5, 0.5, -74.0, -369.0) and recomputes cleanly
    const resetRes = await request(app).post('/api/ranking/config/reset');
    expect(resetRes.status).toBe(200);
    expect(resetRes.body).toEqual(DEFAULT_RANKING_CONFIG);

    const [afterReset] = await db.select().from(postStats).where(eq(postStats.postId, POST_ID));
    expect(afterReset?.engagementScore).toBeCloseTo(
      computeEngagementScore(SEEDED_STATS, DEFAULT_RANKING_CONFIG.weights),
      3,
    );
  });

  it('skips post_stats recomputation when none of the 6 engagement weights change', async () => {
    const sentinelUpdatedAt = new Date('2025-01-01T00:00:00.000Z');
    await seedPostWithStats(sentinelUpdatedAt);
    const app = createApp();

    // No-op weight patches & non-post_stats changes must not touch post_stats
    expect((await request(app).patch('/api/ranking/config').send({ weights: {} })).status).toBe(
      200,
    );
    expect(
      (
        await request(app)
          .patch('/api/ranking/config')
          .send({ weights: { profile_click: 3.25 } })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .patch('/api/ranking/config')
          .send({ scoring: { inNetworkBoost: 1.6 } })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .patch('/api/ranking/config')
          .send({ weights: { like: DEFAULT_RANKING_CONFIG.weights.like } })
      ).status,
    ).toBe(200);

    const [untouched] = await db.select().from(postStats).where(eq(postStats.postId, POST_ID));
    expect(untouched?.updatedAt.toISOString()).toBe(sentinelUpdatedAt.toISOString());

    // Changing an actual post_stats weight triggers recomputation
    const changed = await request(app)
      .patch('/api/ranking/config')
      .send({ weights: { like: 1.25 } });
    expect(changed.status).toBe(200);

    const [recomputed] = await db.select().from(postStats).where(eq(postStats.postId, POST_ID));
    expect(recomputed?.updatedAt.getTime()).toBeGreaterThan(sentinelUpdatedAt.getTime());
    expect(recomputed?.engagementScore).toBeCloseTo(
      computeEngagementScore(SEEDED_STATS, changed.body.weights),
      3,
    );
  });

  it('serializes overlapping PATCH and reset requests without lost updates or cache drift', async () => {
    await seedPostWithStats();
    const app = createApp();

    const results = await Promise.all([
      request(app)
        .patch('/api/ranking/config')
        .send({ weights: { like: 3.5 } }),
      request(app)
        .patch('/api/ranking/config')
        .send({ scoring: { inNetworkBoost: 1.8 } }),
      request(app)
        .patch('/api/ranking/config')
        .send({ decay: { recencyHalfLifeHours: 10 } }),
    ]);

    for (const res of results) {
      expect(res.status).toBe(200);
    }

    const finalRes = await request(app).get('/api/ranking/config');
    expect(finalRes.status).toBe(200);
    expect(finalRes.body.weights.like).toBe(3.5);
    expect(finalRes.body.scoring.inNetworkBoost).toBe(1.8);
    expect(finalRes.body.decay.recencyHalfLifeHours).toBe(10);

    const [statsAfterPatches] = await db
      .select()
      .from(postStats)
      .where(eq(postStats.postId, POST_ID));
    expect(statsAfterPatches?.engagementScore).toBeCloseTo(
      computeEngagementScore(SEEDED_STATS, finalRes.body.weights),
      3,
    );

    // Overlapping PATCH + reset must serialize and end with DB stats matching active persisted config
    const mixed = await Promise.all([
      request(app)
        .patch('/api/ranking/config')
        .send({ weights: { reply: 21.5 } }),
      request(app).post('/api/ranking/config/reset'),
    ]);
    for (const res of mixed) {
      expect(res.status).toBe(200);
    }

    const active = await request(app).get('/api/ranking/config');
    const [statsAfterMixed] = await db
      .select()
      .from(postStats)
      .where(eq(postStats.postId, POST_ID));
    expect(statsAfterMixed?.engagementScore).toBeCloseTo(
      computeEngagementScore(SEEDED_STATS, active.body.weights),
      3,
    );
  });

  it('persists config across fresh app instances (restart behavior) and rolls back on recompute failure', async () => {
    await seedPostWithStats();

    const firstApp = createApp();
    const patchRes = await request(firstApp)
      .patch('/api/ranking/config')
      .send({ weights: { reply: 19.5 }, diversity: { inNetworkRatio: 0.45 } });
    expect(patchRes.status).toBe(200);

    // A fresh app instance reads the persisted config from PostgreSQL rather than defaults
    const restartedApp = createApp();
    const afterRestart = await request(restartedApp).get('/api/ranking/config');
    expect(afterRestart.status).toBe(200);
    expect(afterRestart.body.weights.reply).toBe(19.5);
    expect(afterRestart.body.diversity.inNetworkRatio).toBe(0.45);

    const [beforeFailureStats] = await db
      .select()
      .from(postStats)
      .where(eq(postStats.postId, POST_ID));

    // Force post_stats UPDATE to fail inside the transaction and verify full rollback
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION fail_post_stats_update() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'simulated post_stats recompute failure';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await db.execute(sql`
      CREATE TRIGGER trg_fail_post_stats_update
      BEFORE UPDATE ON post_stats
      FOR EACH STATEMENT EXECUTE FUNCTION fail_post_stats_update();
    `);

    try {
      const failedRes = await request(restartedApp)
        .patch('/api/ranking/config')
        .send({ weights: { like: 9.5 } });
      expect(failedRes.status).toBe(500);
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS trg_fail_post_stats_update ON post_stats;`);
      await db.execute(sql`DROP FUNCTION IF EXISTS fail_post_stats_update();`);
    }

    const afterRollback = await request(restartedApp).get('/api/ranking/config');
    expect(afterRollback.status).toBe(200);
    expect(afterRollback.body.weights.like).toBe(DEFAULT_RANKING_CONFIG.weights.like);
    expect(afterRollback.body.weights.reply).toBe(19.5);

    const [afterFailureStats] = await db
      .select()
      .from(postStats)
      .where(eq(postStats.postId, POST_ID));
    expect(afterFailureStats?.engagementScore).toBe(beforeFailureStats?.engagementScore);
  });

  it('preserves representable small real scores (e.g. 5e-38) and flushes true underflows (1e-50, Number.MIN_VALUE) to 0', async () => {
    await db.insert(users).values({
      id: ALICE_ID,
      handle: 'alice_underflow_test',
      displayName: 'Alice',
    });
    await db.insert(posts).values({
      id: POST_ID,
      authorId: ALICE_ID,
      body: 'Testing float32 boundary and underflow safety',
    });
    await db.insert(postStats).values({
      postId: POST_ID,
      viewCount: 0,
      likeCount: 1,
      replyCount: 0,
      repostCount: 0,
      notInterestedCount: 0,
      reportCount: 0,
      engagementScore: 0.5,
    });

    const app = createApp();

    // 5e-38 is a normal nonzero IEEE-754 float32 and must be preserved, not zeroed
    const smallNormal = await request(app)
      .patch('/api/ranking/config')
      .send({ weights: { like: 5e-38 } });
    expect(smallNormal.status).toBe(200);

    const [afterSmallNormal] = await db
      .select()
      .from(postStats)
      .where(eq(postStats.postId, POST_ID));
    expect(Math.fround(afterSmallNormal!.engagementScore)).toBe(Math.fround(5e-38));
    expect(afterSmallNormal?.engagementScore).toBeGreaterThan(0);

    // 1e-44 is a representable nonzero float32 subnormal and must also be preserved
    const smallSubnormal = await request(app)
      .patch('/api/ranking/config')
      .send({ weights: { like: 1e-44 } });
    expect(smallSubnormal.status).toBe(200);

    const [afterSubnormal] = await db.select().from(postStats).where(eq(postStats.postId, POST_ID));
    expect(Math.fround(afterSubnormal!.engagementScore)).toBe(Math.fround(1e-44));
    expect(afterSubnormal?.engagementScore).toBeGreaterThan(0);

    // 1e-50 is below 2^-150 and rounds to 0 in IEEE-754 float32 without throwing underflow
    const tinyReal = await request(app)
      .patch('/api/ranking/config')
      .send({ weights: { like: 1e-50 } });
    expect(tinyReal.status).toBe(200);

    const [afterTinyReal] = await db.select().from(postStats).where(eq(postStats.postId, POST_ID));
    expect(afterTinyReal?.engagementScore).toBe(0);

    // Number.MIN_VALUE (5e-324) rounds to 0 without throwing underflow
    const tinyFloat8 = await request(app)
      .patch('/api/ranking/config')
      .send({ weights: { like: Number.MIN_VALUE } });
    expect(tinyFloat8.status).toBe(200);

    const [afterTinyFloat8] = await db
      .select()
      .from(postStats)
      .where(eq(postStats.postId, POST_ID));
    expect(afterTinyFloat8?.engagementScore).toBe(0);
  });
});
