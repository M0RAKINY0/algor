import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { Client } from 'pg';
import { env } from '../src/config/env.js';
import { db, pool } from '../src/db/index.js';
import { interactions } from '../src/db/schema.js';
import { ingestGraph, ingestPosts, ingestUsers } from '../src/modules/ingest/ingest.service.js';
import type { InteractionType } from '../src/modules/signals/signals.schemas.js';
import { recordEvent } from '../src/modules/signals/signals.service.js';

export const SEED_USERS = {
  alice: {
    id: '10000000-0000-4000-8000-000000000001',
    handle: 'alice',
    displayName: 'Alice Chen',
    bio: 'Ranking pipelines, ML, and Postgres',
  },
  bob: {
    id: '10000000-0000-4000-8000-000000000002',
    handle: 'bob',
    displayName: 'Bob Patel',
    bio: 'TypeScript & backend engineering',
  },
  carol: {
    id: '10000000-0000-4000-8000-000000000003',
    handle: 'carol',
    displayName: 'Carol Diaz',
    bio: 'Distributed systems and Rust',
  },
  dave: {
    id: '10000000-0000-4000-8000-000000000004',
    handle: 'dave',
    displayName: 'Dave Kim',
    bio: 'Applied AI & search relevance',
  },
  eve: {
    id: '10000000-0000-4000-8000-000000000005',
    handle: 'eve',
    displayName: 'Eve Okafor',
    bio: 'Database internals & indexing',
  },
  frank: {
    id: '10000000-0000-4000-8000-000000000006',
    handle: 'frank',
    displayName: 'Frank Miller',
    bio: 'Frontend architecture & CSS',
  },
  grace: {
    id: '10000000-0000-4000-8000-000000000007',
    handle: 'grace',
    displayName: 'Grace Lin',
    bio: 'Compiler tooling & WebAssembly',
  },
  heidi: {
    id: '10000000-0000-4000-8000-000000000008',
    handle: 'heidi',
    displayName: 'Heidi Mensah',
    bio: 'MLOps & feature stores',
  },
  spammer: {
    id: '10000000-0000-4000-8000-000000000009',
    handle: 'noisy_bot',
    displayName: 'Noisy Bot',
    bio: 'Automated hype posts',
  },
} as const;

// Fixed reference timestamp in the recent past so seed posts and seed events have deterministic
// identities across reruns (making repeatable events like `reply` strictly idempotent).
const SEED_EPOCH_MS = Date.parse('2026-11-22T12:00:00.000Z');
const hoursBeforeEpoch = (h: number) => new Date(SEED_EPOCH_MS - h * 3_600_000).toISOString();

export const SEED_POSTS = [
  {
    id: '20000000-0000-4000-8000-000000000001',
    authorId: SEED_USERS.bob.id,
    body: 'Type-safe Drizzle queries with explicit float casts saved us a subtle bug #typescript #postgres',
    createdAt: hoursBeforeEpoch(1),
  },
  {
    id: '20000000-0000-4000-8000-000000000002',
    authorId: SEED_USERS.bob.id,
    body: 'Why half-life exponential decay beats bucketed time windows for feed ranking #ranking #postgres',
    createdAt: hoursBeforeEpoch(3),
  },
  {
    id: '20000000-0000-4000-8000-000000000003',
    authorId: SEED_USERS.bob.id,
    body: 'Author diversity attenuation keeps one prolific poster from taking over the top 10 #ranking #typescript',
    createdAt: hoursBeforeEpoch(5),
  },
  {
    id: '20000000-0000-4000-8000-000000000004',
    authorId: SEED_USERS.dave.id,
    body: 'Comparing two-tower retrieval vs. simple 4-source SQL candidate generation #ai #ranking',
    createdAt: hoursBeforeEpoch(2),
  },
  {
    id: '20000000-0000-4000-8000-000000000005',
    authorId: SEED_USERS.dave.id,
    body: 'Explainable debug payloads make tuning recommendation weights 10x faster #ai #ml',
    createdAt: hoursBeforeEpoch(8),
  },
  {
    id: '20000000-0000-4000-8000-000000000006',
    authorId: SEED_USERS.eve.id,
    body: 'Using SELECT FOR SHARE on a singleton config row prevents cache rebuild races #postgres #systems',
    createdAt: hoursBeforeEpoch(1.5),
  },
  {
    id: '20000000-0000-4000-8000-000000000007',
    authorId: SEED_USERS.eve.id,
    body: 'Partial unique indexes in PostgreSQL are underrated for idempotent event logs #postgres',
    createdAt: hoursBeforeEpoch(12),
  },
  {
    id: '20000000-0000-4000-8000-000000000008',
    authorId: SEED_USERS.carol.id,
    body: 'Zero-copy parsers in #rust make telemetry ingestion fly #systems',
    createdAt: hoursBeforeEpoch(2.5),
  },
  {
    id: '20000000-0000-4000-8000-000000000009',
    authorId: SEED_USERS.carol.id,
    body: 'Notes on backpressure and bounded queues in async #rust services #systems',
    createdAt: hoursBeforeEpoch(18),
  },
  {
    id: '20000000-0000-4000-8000-000000000010',
    authorId: SEED_USERS.heidi.id,
    body: 'Cold-start feeds need a smart out-of-network trending fallback #ai #ranking',
    createdAt: hoursBeforeEpoch(4),
  },
  {
    id: '20000000-0000-4000-8000-000000000011',
    authorId: SEED_USERS.frank.id,
    body: 'Container queries + subgrid finally made responsive dashboards enjoyable #css #frontend',
    createdAt: hoursBeforeEpoch(3.5),
  },
  {
    id: '20000000-0000-4000-8000-000000000012',
    authorId: SEED_USERS.grace.id,
    body: 'Compiling small scoring kernels to #wasm for browser previews #rust #typescript',
    createdAt: hoursBeforeEpoch(6),
  },
  {
    id: '20000000-0000-4000-8000-000000000013',
    authorId: SEED_USERS.spammer.id,
    body: 'BUY NOW 1000X ENGAGEMENT HACK #crypto #ai #rust #typescript #postgres',
    createdAt: hoursBeforeEpoch(0.5),
  },
] as const;

export const SEED_EVENTS: ReadonlyArray<{
  userId: string;
  postId: string;
  type: InteractionType;
  createdAt: string;
}> = [
  // Alice engages strongly with Bob's Postgres/ranking posts and Dave's AI posts
  {
    userId: SEED_USERS.alice.id,
    postId: SEED_POSTS[1].id,
    type: 'reply',
    createdAt: hoursBeforeEpoch(2.5),
  },
  {
    userId: SEED_USERS.alice.id,
    postId: SEED_POSTS[1].id,
    type: 'like',
    createdAt: hoursBeforeEpoch(2.4),
  },
  {
    userId: SEED_USERS.alice.id,
    postId: SEED_POSTS[4].id,
    type: 'like',
    createdAt: hoursBeforeEpoch(7.0),
  },
  {
    userId: SEED_USERS.alice.id,
    postId: SEED_POSTS[4].id,
    type: 'repost',
    createdAt: hoursBeforeEpoch(6.9),
  },
  // Bob & Dave create social proof on Eve's and Heidi's out-of-network posts
  {
    userId: SEED_USERS.bob.id,
    postId: SEED_POSTS[5].id,
    type: 'like',
    createdAt: hoursBeforeEpoch(1.2),
  },
  {
    userId: SEED_USERS.bob.id,
    postId: SEED_POSTS[5].id,
    type: 'repost',
    createdAt: hoursBeforeEpoch(1.1),
  },
  {
    userId: SEED_USERS.dave.id,
    postId: SEED_POSTS[5].id,
    type: 'reply',
    createdAt: hoursBeforeEpoch(1.0),
  },
  {
    userId: SEED_USERS.dave.id,
    postId: SEED_POSTS[9].id,
    type: 'like',
    createdAt: hoursBeforeEpoch(3.2),
  },
  {
    userId: SEED_USERS.bob.id,
    postId: SEED_POSTS[9].id,
    type: 'like',
    createdAt: hoursBeforeEpoch(3.1),
  },
  // Trending engagement on Carol's & Grace's posts
  {
    userId: SEED_USERS.eve.id,
    postId: SEED_POSTS[7].id,
    type: 'reply',
    createdAt: hoursBeforeEpoch(2.0),
  },
  {
    userId: SEED_USERS.grace.id,
    postId: SEED_POSTS[7].id,
    type: 'like',
    createdAt: hoursBeforeEpoch(1.9),
  },
  {
    userId: SEED_USERS.carol.id,
    postId: SEED_POSTS[11].id,
    type: 'repost',
    createdAt: hoursBeforeEpoch(5.0),
  },
  // Community reports spammer post
  {
    userId: SEED_USERS.bob.id,
    postId: SEED_POSTS[12].id,
    type: 'report',
    createdAt: hoursBeforeEpoch(0.3),
  },
  {
    userId: SEED_USERS.eve.id,
    postId: SEED_POSTS[12].id,
    type: 'not_interested',
    createdAt: hoursBeforeEpoch(0.2),
  },
];

export async function seedDatabase(options: { silent?: boolean } = {}) {
  const log = options.silent ? () => {} : console.log;

  // Serialize concurrent seed runs via a PostgreSQL advisory lock on a standalone connection
  // (separate from the shared `pool`) so concurrent waiters can never starve pool connections.
  const lockClient = new Client({ connectionString: env.DATABASE_URL });
  let locked = false;
  await lockClient.connect();

  try {
    await lockClient.query(`SELECT pg_advisory_lock(hashtextextended('algor:seed', 0))`);
    locked = true;

    log('Seeding Algor database...');

    const { count: userCount } = await ingestUsers({
      users: Object.values(SEED_USERS),
    });
    log(`Upserted ${userCount} users.`);

    const { count: postCount } = await ingestPosts({
      posts: [...SEED_POSTS],
    });
    log(`Ingested ${postCount} new posts (${SEED_POSTS.length} total defined).`);

    const { applied } = await ingestGraph({
      edges: [
        // Alice follows Bob, Dave, and Carol; blocks spammer; mutes Frank
        { action: 'follow', sourceUserId: SEED_USERS.alice.id, targetUserId: SEED_USERS.bob.id },
        { action: 'follow', sourceUserId: SEED_USERS.alice.id, targetUserId: SEED_USERS.dave.id },
        { action: 'follow', sourceUserId: SEED_USERS.alice.id, targetUserId: SEED_USERS.carol.id },
        { action: 'block', sourceUserId: SEED_USERS.alice.id, targetUserId: SEED_USERS.spammer.id },
        { action: 'mute', sourceUserId: SEED_USERS.alice.id, targetUserId: SEED_USERS.frank.id },
        // Bob & Dave follow Eve and Heidi (drives social_proof for Alice)
        { action: 'follow', sourceUserId: SEED_USERS.bob.id, targetUserId: SEED_USERS.eve.id },
        { action: 'follow', sourceUserId: SEED_USERS.dave.id, targetUserId: SEED_USERS.eve.id },
        { action: 'follow', sourceUserId: SEED_USERS.dave.id, targetUserId: SEED_USERS.heidi.id },
        { action: 'follow', sourceUserId: SEED_USERS.carol.id, targetUserId: SEED_USERS.grace.id },
      ],
    });
    log(`Applied ${applied} social graph edges.`);

    // Deduplicate every seed event (including repeatable `reply` events) by its stable
    // `(userId, postId, type, createdAt)` tuple under the advisory lock above.
    let recorded = 0;
    for (const ev of SEED_EVENTS) {
      const eventDate = new Date(ev.createdAt);
      const [existing] = await db
        .select({ id: interactions.id })
        .from(interactions)
        .where(
          and(
            eq(interactions.userId, ev.userId),
            eq(interactions.postId, ev.postId),
            eq(interactions.type, ev.type),
            eq(interactions.createdAt, eventDate),
          ),
        )
        .limit(1);

      if (existing) continue;

      const res = await recordEvent(ev.userId, {
        postId: ev.postId,
        type: ev.type,
        createdAt: ev.createdAt,
      });
      if (res.recorded) recorded += 1;
    }
    log(`Recorded ${recorded} new interaction events (${SEED_EVENTS.length} total defined).`);

    log('\nSample caller IDs (pass via x-user-id header):');
    log(`  alice (in-network + affinity + block/mute): ${SEED_USERS.alice.id}`);
    log(`  heidi (cold-start user):                    ${SEED_USERS.heidi.id}`);

    return { userCount, postCount, applied, recorded };
  } finally {
    if (locked) {
      await lockClient
        .query(`SELECT pg_advisory_unlock(hashtextextended('algor:seed', 0))`)
        .catch(() => {});
    }
    await lockClient.end().catch(() => {});
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  seedDatabase()
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end();
    });
}
