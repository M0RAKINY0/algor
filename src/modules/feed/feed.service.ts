import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { impressions } from '../../db/schema.js';
import { hasMoreEligiblePosts, retrieveCandidates } from '../candidates/candidates.service.js';
import { rankCandidates } from '../ranking/ranking.scorer.js';
import { readRankingConfigForShare } from '../ranking/ranking.service.js';
import { toSafePgRealSql } from '../ranking/ranking.sql.js';
import type { ScoreBreakdown } from '../ranking/ranking.types.js';
import { loadUserSignalsContext } from '../signals/signals.service.js';
import { assembleFeed, type AuthorRunState } from './feed.mixer.js';
import { decodeFeedCursor, encodeFeedCursor, type FeedQuery } from './feed.schemas.js';

export interface FeedItem {
  id: string;
  author: {
    id: string;
    handle: string;
    displayName: string;
  };
  body: string;
  replyToId: string | null;
  topics: string[];
  createdAt: string;
  inNetwork: boolean;
  stats: {
    viewCount: number;
    likeCount: number;
    replyCount: number;
    repostCount: number;
  };
  score: number;
  position: number;
  debug?: ScoreBreakdown;
}

export interface FeedResponse {
  items: FeedItem[];
  nextCursor: string | null;
  hasMore: boolean;
  meta: {
    candidateCount: number;
    returnedCount: number;
    inNetworkCount: number;
    outOfNetworkCount: number;
  };
}

function computeTrailingAuthorRun(
  items: ReadonlyArray<{ author: { id: string } }>,
  initialRun?: AuthorRunState,
): { authorId: string; count: number } | null {
  const last = items.at(-1);
  if (!last) return null;

  let count = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.author.id === last.author.id) {
      count += 1;
    } else {
      break;
    }
  }

  if (count === items.length && initialRun?.authorId === last.author.id) {
    count += initialRun.count;
  }

  return { authorId: last.author.id, count: Math.min(50, count) };
}

export async function getFeed(
  userId: string,
  query: FeedQuery,
  now: Date = new Date(),
): Promise<FeedResponse> {
  const canonicalUserId = userId.toLowerCase();
  const excludePostIds = new Set<string>();
  let initialRun: AuthorRunState | undefined;

  if (query.cursor) {
    const cursor = decodeFeedCursor(query.cursor);
    excludePostIds.add(cursor.lastPostId);
    initialRun = { authorId: cursor.lastAuthorId, count: cursor.lastAuthorRun };
  }

  // Serialize page allocation + impression recording per viewer inside a single transaction
  // using a transaction-scoped advisory lock so concurrent GET /api/feed calls for the same
  // user never return overlapping posts, overwrite servedAt, or deadlock on impression rows.
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`algor:feed:${canonicalUserId}`}, 0))`,
    );

    const config = await readRankingConfigForShare(tx);
    const candidates = await retrieveCandidates(canonicalUserId, config, {
      now,
      excludePostIds,
      executor: tx,
    });

    if (candidates.length === 0) {
      return {
        items: [],
        nextCursor: null,
        hasMore: false,
        meta: {
          candidateCount: 0,
          returnedCount: 0,
          inNetworkCount: 0,
          outOfNetworkCount: 0,
        },
      };
    }

    const authorIds = candidates.map((c) => c.authorId);
    const topicIds = candidates.flatMap((c) => c.topicIds);
    const signals = await loadUserSignalsContext(canonicalUserId, authorIds, topicIds, tx);

    const ranked = rankCandidates(candidates, signals, config, now);
    const assembled = assembleFeed(ranked, query.limit, config, initialRun);

    // Stage 5: Atomically claim impressions in deterministic post_id order without overwriting
    // any previously recorded impression timestamp.
    if (assembled.length > 0) {
      const impressionRows = assembled
        .map((item, position) => ({
          userId: canonicalUserId,
          postId: item.candidate.id,
          score: toSafePgRealSql(sql`${item.score}::double precision`),
          position,
          servedAt: now,
        }))
        .sort((a, b) => a.postId.localeCompare(b.postId));

      await tx.insert(impressions).values(impressionRows).onConflictDoNothing();
    }

    // Accurate continuation check: if the assembled page consumed the entire candidate batch,
    // probe with the exact same 4-source eligibility predicates for at least one remaining post.
    const hasMore =
      ranked.length > assembled.length
        ? true
        : assembled.length > 0
          ? await hasMoreEligiblePosts(canonicalUserId, config, {
              now,
              excludePostIds,
              executor: tx,
            })
          : false;

    let inNetworkCount = 0;
    const items: FeedItem[] = assembled.map((entry, position) => {
      const { candidate, score, breakdown } = entry;
      if (candidate.inNetwork) inNetworkCount += 1;

      return {
        id: candidate.id,
        author: candidate.author,
        body: candidate.body,
        replyToId: candidate.replyToId,
        topics: candidate.topicNames,
        createdAt: candidate.createdAt.toISOString(),
        inNetwork: candidate.inNetwork,
        stats: {
          viewCount: candidate.stats.viewCount,
          likeCount: candidate.stats.likeCount,
          replyCount: candidate.stats.replyCount,
          repostCount: candidate.stats.repostCount,
        },
        score,
        position,
        ...(query.debug ? { debug: breakdown } : {}),
      };
    });

    const lastItem = items.at(-1);
    const trailingRun = computeTrailingAuthorRun(items, initialRun);
    const nextCursor =
      hasMore && lastItem && trailingRun
        ? encodeFeedCursor({
            v: 1,
            lastPostId: lastItem.id,
            lastAuthorId: trailingRun.authorId,
            lastAuthorRun: trailingRun.count,
          })
        : null;

    return {
      items,
      nextCursor,
      hasMore,
      meta: {
        candidateCount: candidates.length,
        returnedCount: items.length,
        inNetworkCount,
        outOfNetworkCount: items.length - inNetworkCount,
      },
    };
  });
}
