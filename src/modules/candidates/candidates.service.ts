import { and, asc, desc, eq, inArray, ne, notInArray, sql, type SQL } from 'drizzle-orm';
import type { RankingConfig } from '../../config/ranking.js';
import { db } from '../../db/index.js';
import {
  follows,
  interactions,
  posts,
  postStats,
  postTopics,
  topics,
  users,
  userTopicAffinity,
} from '../../db/schema.js';
import { decayScore } from '../ranking/ranking.scorer.js';
import type {
  CandidatePost,
  CandidateSource,
  PostStatsSnapshot,
} from '../ranking/ranking.types.js';

type DbReader = Pick<typeof db, 'select'>;

export interface HydratedCandidatePost extends CandidatePost {
  body: string;
  replyToId: string | null;
  author: {
    id: string;
    handle: string;
    displayName: string;
  };
  topicNames: string[];
}

export interface RetrieveCandidatesOptions {
  now?: Date;
  excludePostIds?: ReadonlySet<string>;
  executor?: DbReader;
}

const ZERO_STATS: PostStatsSnapshot = {
  viewCount: 0,
  likeCount: 0,
  replyCount: 0,
  repostCount: 0,
  notInterestedCount: 0,
  reportCount: 0,
};

const SOURCE_ORDER: readonly CandidateSource[] = [
  'in_network',
  'topic_match',
  'social_proof',
  'trending',
];

const TOP_USER_TOPICS_LIMIT = 10;

function notBlockedOrMutedAuthor(userId: string, authorIdColumn: unknown): SQL {
  return sql`(
    NOT EXISTS (
      SELECT 1 FROM blocks b
      WHERE (b.blocker_id = ${userId}::uuid AND b.blocked_id = ${authorIdColumn})
         OR (b.blocker_id = ${authorIdColumn} AND b.blocked_id = ${userId}::uuid)
    )
    AND NOT EXISTS (
      SELECT 1 FROM mutes m
      WHERE m.muter_id = ${userId}::uuid AND m.muted_id = ${authorIdColumn}
    )
  )`;
}

/**
 * Constant-parameter indexed SQL exclusion filter for eligible candidate posts:
 * excludes own posts, bidirectional blocks, mutes, already-impressed posts, and
 * posts the viewer previously marked `not_interested` or `report`.
 */
function buildEligiblePostConditions(
  userId: string,
  extraExcludePostIds?: readonly string[],
): SQL[] {
  const conditions: SQL[] = [
    ne(posts.authorId, userId),
    notBlockedOrMutedAuthor(userId, posts.authorId),
    sql`NOT EXISTS (
      SELECT 1 FROM impressions imp
      WHERE imp.user_id = ${userId}::uuid AND imp.post_id = ${posts.id}
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM interactions hi
      WHERE hi.user_id = ${userId}::uuid
        AND hi.post_id = ${posts.id}
        AND hi.type IN ('not_interested', 'report')
    )`,
  ];

  if (extraExcludePostIds && extraExcludePostIds.length > 0) {
    conditions.push(notInArray(posts.id, [...extraExcludePostIds]));
  }

  return conditions;
}

/**
 * O(1) lookahead check for whether at least one additional post retrievable by any of the 4
 * candidate sources (`in_network`, `topic_match`, `social_proof`, `trending`) exists outside
 * the already-served set (used when a page consumes its entire candidate batch).
 */
export async function hasMoreEligiblePosts(
  userId: string,
  config: RankingConfig,
  options: RetrieveCandidatesOptions = {},
): Promise<boolean> {
  const canonicalUserId = userId.toLowerCase();
  const now = options.now ?? new Date();
  const executor = options.executor ?? db;
  const extraExcludePostIds = options.excludePostIds ? [...options.excludePostIds] : [];

  const userTopicRows = await executor
    .select({
      topicId: userTopicAffinity.topicId,
      score: userTopicAffinity.score,
      updatedAt: userTopicAffinity.updatedAt,
    })
    .from(userTopicAffinity)
    .where(eq(userTopicAffinity.userId, canonicalUserId));

  const topTopicIds = userTopicRows
    .map((row) => ({
      topicId: row.topicId,
      decayed: decayScore(row.score, row.updatedAt, config.decay.topicAffinityHalfLifeHours, now),
    }))
    .filter((row) => row.decayed > 0)
    .sort((a, b) => b.decayed - a.decayed || a.topicId - b.topicId)
    .slice(0, TOP_USER_TOPICS_LIMIT)
    .map((row) => row.topicId);

  const sourcePredicates: SQL[] = [
    // trending
    sql`COALESCE(${postStats.engagementScore}, 0) >= 0`,
    // in_network
    sql`EXISTS (
      SELECT 1 FROM follows f
      WHERE f.follower_id = ${canonicalUserId}::uuid AND f.followee_id = ${posts.authorId}
    )`,
    // social_proof
    sql`EXISTS (
      SELECT 1 FROM interactions i
      INNER JOIN follows f
        ON f.follower_id = ${canonicalUserId}::uuid AND f.followee_id = i.user_id
      WHERE i.post_id = ${posts.id}
        AND i.type IN ('like', 'repost')
        AND ${notBlockedOrMutedAuthor(canonicalUserId, sql`f.followee_id`)}
    )`,
  ];

  if (topTopicIds.length > 0) {
    sourcePredicates.push(
      sql`EXISTS (
        SELECT 1 FROM post_topics pt
        WHERE pt.post_id = ${posts.id}
          AND pt.topic_id IN (${sql.join(
            topTopicIds.map((id) => sql`${id}`),
            sql`, `,
          )})
      )`,
    );
  }

  const anySourceMatches = sql`(${sql.join(sourcePredicates, sql` OR `)})`;

  const [row] = await executor
    .select({ id: posts.id })
    .from(posts)
    .leftJoin(postStats, eq(postStats.postId, posts.id))
    .where(
      and(...buildEligiblePostConditions(canonicalUserId, extraExcludePostIds), anySourceMatches),
    )
    .limit(1);

  return row !== undefined;
}

export async function retrieveCandidates(
  userId: string,
  config: RankingConfig,
  options: RetrieveCandidatesOptions = {},
): Promise<HydratedCandidatePost[]> {
  const canonicalUserId = userId.toLowerCase();
  const now = options.now ?? new Date();
  const executor = options.executor ?? db;
  const candidateLimit = config.diversity.candidateLimit;
  const perSourceLimit = Math.min(candidateLimit, Math.max(25, Math.ceil(candidateLimit / 2)));
  const extraExcludePostIds = options.excludePostIds ? [...options.excludePostIds] : [];

  // 1. Load the viewer's topic affinities to select top positive decayed topics (max 10 IDs).
  const userTopicRows = await executor
    .select({
      topicId: userTopicAffinity.topicId,
      score: userTopicAffinity.score,
      updatedAt: userTopicAffinity.updatedAt,
    })
    .from(userTopicAffinity)
    .where(eq(userTopicAffinity.userId, canonicalUserId));

  const topTopicIds = userTopicRows
    .map((row) => ({
      topicId: row.topicId,
      decayed: decayScore(row.score, row.updatedAt, config.decay.topicAffinityHalfLifeHours, now),
    }))
    .filter((row) => row.decayed > 0)
    .sort((a, b) => b.decayed - a.decayed || a.topicId - b.topicId)
    .slice(0, TOP_USER_TOPICS_LIMIT)
    .map((row) => row.topicId);

  const eligibleFilters = buildEligiblePostConditions(canonicalUserId, extraExcludePostIds);

  // 2. Retrieve candidate IDs from all 4 sources sequentially on the transaction connection
  // (avoids pipelining concurrent queries on a single pg.Client inside db.transaction).
  const inNetworkRows = await executor
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(
      follows,
      and(eq(follows.followerId, canonicalUserId), eq(follows.followeeId, posts.authorId)),
    )
    .where(and(...eligibleFilters))
    .orderBy(desc(posts.createdAt), asc(posts.id))
    .limit(perSourceLimit);

  const topicMatchRows =
    topTopicIds.length > 0
      ? await executor
          .select({ id: posts.id })
          .from(posts)
          .innerJoin(postTopics, eq(postTopics.postId, posts.id))
          .where(and(inArray(postTopics.topicId, topTopicIds), ...eligibleFilters))
          .groupBy(posts.id, posts.createdAt)
          .orderBy(desc(posts.createdAt), asc(posts.id))
          .limit(perSourceLimit)
      : [];

  const socialProofRows = await executor
    .select({
      id: posts.id,
      proofCount: sql<number>`count(distinct ${interactions.userId})::int`,
    })
    .from(interactions)
    .innerJoin(
      follows,
      and(eq(follows.followerId, canonicalUserId), eq(follows.followeeId, interactions.userId)),
    )
    .innerJoin(posts, eq(posts.id, interactions.postId))
    .where(
      and(
        inArray(interactions.type, ['like', 'repost']),
        notBlockedOrMutedAuthor(canonicalUserId, follows.followeeId),
        ...eligibleFilters,
      ),
    )
    .groupBy(posts.id, posts.createdAt)
    .orderBy(
      desc(sql`count(distinct ${interactions.userId})`),
      desc(posts.createdAt),
      asc(posts.id),
    )
    .limit(perSourceLimit);

  const trendingRows = await executor
    .select({ id: posts.id })
    .from(posts)
    .leftJoin(postStats, eq(postStats.postId, posts.id))
    .where(and(sql`COALESCE(${postStats.engagementScore}, 0) >= 0`, ...eligibleFilters))
    .orderBy(
      desc(sql`COALESCE(${postStats.engagementScore}, 0)`),
      desc(posts.createdAt),
      asc(posts.id),
    )
    .limit(perSourceLimit);

  // 3. Round-robin merge & deduplicate up to `candidateLimit`.
  // `sources` records which capped retrieval queues surfaced the post (a post may still have
  // nonzero hydrated `socialProofCount` if it entered via another queue below the social_proof cap).
  const sourceLists: Array<{ source: CandidateSource; ids: string[] }> = [
    { source: 'in_network', ids: inNetworkRows.map((r) => r.id) },
    { source: 'topic_match', ids: topicMatchRows.map((r) => r.id) },
    { source: 'social_proof', ids: socialProofRows.map((r) => r.id) },
    { source: 'trending', ids: trendingRows.map((r) => r.id) },
  ];

  const retrievedSourcesByPost = new Map<string, Set<CandidateSource>>();
  for (const { source, ids } of sourceLists) {
    for (const id of ids) {
      let set = retrievedSourcesByPost.get(id);
      if (!set) {
        set = new Set();
        retrievedSourcesByPost.set(id, set);
      }
      set.add(source);
    }
  }

  const selectedIds: string[] = [];
  const selectedSet = new Set<string>();
  const cursors = sourceLists.map(() => 0);

  while (selectedIds.length < candidateLimit) {
    let progressed = false;
    for (let s = 0; s < sourceLists.length && selectedIds.length < candidateLimit; s++) {
      const list = sourceLists[s]!.ids;
      while (cursors[s]! < list.length) {
        const id = list[cursors[s]!]!;
        cursors[s] = cursors[s]! + 1;
        if (!selectedSet.has(id)) {
          selectedSet.add(id);
          selectedIds.push(id);
          progressed = true;
          break;
        }
      }
    }
    if (!progressed) break;
  }

  if (selectedIds.length === 0) {
    return [];
  }

  // 4. Hydrate post metadata, in-network flag, topics, stats, and full eligible social-proof counts.
  const postRows = await executor
    .select({
      id: posts.id,
      authorId: posts.authorId,
      body: posts.body,
      replyToId: posts.replyToId,
      createdAt: posts.createdAt,
      authorHandle: users.handle,
      authorDisplayName: users.displayName,
      inNetwork: sql<boolean>`EXISTS (
        SELECT 1 FROM follows f
        WHERE f.follower_id = ${canonicalUserId}::uuid AND f.followee_id = ${posts.authorId}
      )`,
    })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(inArray(posts.id, selectedIds));

  const postTopicRows = await executor
    .select({
      postId: postTopics.postId,
      topicId: topics.id,
      topicName: topics.name,
    })
    .from(postTopics)
    .innerJoin(topics, eq(topics.id, postTopics.topicId))
    .where(inArray(postTopics.postId, selectedIds))
    .orderBy(asc(topics.name));

  const statsRows = await executor
    .select()
    .from(postStats)
    .where(inArray(postStats.postId, selectedIds));

  const hydratedProofRows = await executor
    .select({
      postId: interactions.postId,
      proofCount: sql<number>`count(distinct ${interactions.userId})::int`,
    })
    .from(interactions)
    .innerJoin(
      follows,
      and(eq(follows.followerId, canonicalUserId), eq(follows.followeeId, interactions.userId)),
    )
    .where(
      and(
        inArray(interactions.postId, selectedIds),
        inArray(interactions.type, ['like', 'repost']),
        notBlockedOrMutedAuthor(canonicalUserId, follows.followeeId),
      ),
    )
    .groupBy(interactions.postId);

  const topicsByPost = new Map<string, { ids: number[]; names: string[] }>();
  for (const row of postTopicRows) {
    let bucket = topicsByPost.get(row.postId);
    if (!bucket) {
      bucket = { ids: [], names: [] };
      topicsByPost.set(row.postId, bucket);
    }
    bucket.ids.push(row.topicId);
    bucket.names.push(row.topicName);
  }

  const statsByPost = new Map<string, PostStatsSnapshot>();
  for (const row of statsRows) {
    statsByPost.set(row.postId, {
      viewCount: row.viewCount,
      likeCount: row.likeCount,
      replyCount: row.replyCount,
      repostCount: row.repostCount,
      notInterestedCount: row.notInterestedCount,
      reportCount: row.reportCount,
    });
  }

  const proofByPost = new Map<string, number>();
  for (const row of hydratedProofRows) {
    proofByPost.set(row.postId, row.proofCount);
  }

  return postRows.map((row) => {
    const topicBucket = topicsByPost.get(row.id);
    const matchedSources = retrievedSourcesByPost.get(row.id);
    const orderedSources = SOURCE_ORDER.filter((src) => matchedSources?.has(src));

    return {
      id: row.id,
      authorId: row.authorId,
      body: row.body,
      replyToId: row.replyToId,
      createdAt: row.createdAt,
      author: {
        id: row.authorId,
        handle: row.authorHandle,
        displayName: row.authorDisplayName,
      },
      inNetwork: Boolean(row.inNetwork),
      sources: orderedSources,
      topicIds: topicBucket?.ids ?? [],
      topicNames: topicBucket?.names ?? [],
      stats: statsByPost.get(row.id) ?? { ...ZERO_STATS },
      socialProofCount: proofByPost.get(row.id) ?? 0,
    };
  });
}
