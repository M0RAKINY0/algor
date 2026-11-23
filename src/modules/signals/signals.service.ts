import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  interactions,
  posts,
  postStats,
  postTopics,
  topics,
  userAuthorAffinity,
  users,
  userTopicAffinity,
} from '../../db/schema.js';
import { HttpError } from '../../lib/http-error.js';
import { decayScore } from '../ranking/ranking.scorer.js';
import { getRankingConfigSnapshot, readRankingConfigForShare } from '../ranking/ranking.service.js';
import {
  buildEngagementScoreSql,
  safeHalfLifeDecaySql,
  toSafePgRealSql,
} from '../ranking/ranking.sql.js';
import type { TimedAffinity, UserSignalsContext } from '../ranking/ranking.types.js';
import {
  MAX_EVENT_FUTURE_SKEW_MS,
  type InteractionType,
  type RecordEventInput,
} from './signals.schemas.js';

type DbReader = Pick<typeof db, 'select'>;

export interface RecordEventResult {
  recorded: boolean;
  duplicate: boolean;
  eventId: number | null;
  postId: string;
  type: InteractionType;
  weight: number;
  createdAt: string | null;
}

export interface DecayedAuthorSignal {
  authorId: string;
  handle: string;
  displayName: string;
  rawScore: number;
  decayedScore: number;
  updatedAt: string;
}

export interface DecayedTopicSignal {
  topicId: number;
  name: string;
  rawScore: number;
  decayedScore: number;
  updatedAt: string;
}

export interface UserSignalsResponse {
  userId: string;
  evaluatedAt: string;
  authors: DecayedAuthorSignal[];
  topics: DecayedTopicSignal[];
}

export async function recordEvent(
  userId: string,
  input: RecordEventInput,
  now: Date = new Date(),
): Promise<RecordEventResult> {
  const canonicalUserId = userId.toLowerCase();
  const canonicalPostId = input.postId.toLowerCase();
  const eventTime = input.createdAt ? new Date(input.createdAt) : now;

  if (eventTime.getTime() > now.getTime() + MAX_EVENT_FUTURE_SKEW_MS) {
    throw new HttpError(400, 'Event createdAt cannot be in the future');
  }

  const eventTimeIso = eventTime.toISOString();

  return db.transaction(async (tx) => {
    const [post] = await tx
      .select({ id: posts.id, authorId: posts.authorId })
      .from(posts)
      .where(eq(posts.id, canonicalPostId));

    if (!post) {
      throw new HttpError(404, 'Post not found');
    }

    // Hold a FOR SHARE lock on ranking_config so concurrent weight rebuilds serialize cleanly
    // with this incremental post_stats update.
    const config = await readRankingConfigForShare(tx);
    const weight = config.weights[input.type];

    const inserted = await tx
      .insert(interactions)
      .values({
        userId: canonicalUserId,
        postId: canonicalPostId,
        type: input.type,
        createdAt: eventTime,
      })
      .onConflictDoNothing()
      .returning({ id: interactions.id, createdAt: interactions.createdAt });

    const created = inserted[0];
    if (!created) {
      return {
        recorded: false,
        duplicate: true,
        eventId: null,
        postId: canonicalPostId,
        type: input.type,
        weight,
        createdAt: null,
      };
    }

    // Update post_stats for every interaction type except `profile_click` (no post_stats counter).
    if (input.type !== 'profile_click') {
      const dView = input.type === 'view' ? 1 : 0;
      const dLike = input.type === 'like' ? 1 : 0;
      const dReply = input.type === 'reply' ? 1 : 0;
      const dRepost = input.type === 'repost' ? 1 : 0;
      const dNotInterested = input.type === 'not_interested' ? 1 : 0;
      const dReport = input.type === 'report' ? 1 : 0;

      const initialEngagement = buildEngagementScoreSql(
        {
          replyCount: sql`${dReply}`,
          repostCount: sql`${dRepost}`,
          likeCount: sql`${dLike}`,
          viewCount: sql`${dView}`,
          notInterestedCount: sql`${dNotInterested}`,
          reportCount: sql`${dReport}`,
        },
        config.weights,
      );

      const updatedEngagement = buildEngagementScoreSql(
        {
          replyCount: sql`(${postStats.replyCount} + ${dReply})`,
          repostCount: sql`(${postStats.repostCount} + ${dRepost})`,
          likeCount: sql`(${postStats.likeCount} + ${dLike})`,
          viewCount: sql`(${postStats.viewCount} + ${dView})`,
          notInterestedCount: sql`(${postStats.notInterestedCount} + ${dNotInterested})`,
          reportCount: sql`(${postStats.reportCount} + ${dReport})`,
        },
        config.weights,
      );

      await tx
        .insert(postStats)
        .values({
          postId: canonicalPostId,
          viewCount: dView,
          likeCount: dLike,
          replyCount: dReply,
          repostCount: dRepost,
          notInterestedCount: dNotInterested,
          reportCount: dReport,
          engagementScore: initialEngagement,
          updatedAt: eventTime,
        })
        .onConflictDoUpdate({
          target: postStats.postId,
          set: {
            viewCount: sql`${postStats.viewCount} + ${dView}`,
            likeCount: sql`${postStats.likeCount} + ${dLike}`,
            replyCount: sql`${postStats.replyCount} + ${dReply}`,
            repostCount: sql`${postStats.repostCount} + ${dRepost}`,
            notInterestedCount: sql`${postStats.notInterestedCount} + ${dNotInterested}`,
            reportCount: sql`${postStats.reportCount} + ${dReport}`,
            engagementScore: updatedEngagement,
            updatedAt: sql`GREATEST(${postStats.updatedAt}, ${eventTimeIso}::timestamptz)`,
          },
        });
    }

    // Update decaying author & topic affinities for non-self interactions with nonzero weight.
    // Both the stored score and the incoming event weight are decayed to
    // `GREATEST(existing.updated_at, eventTime)` so out-of-order/backdated events are
    // order-independent up to PostgreSQL `real` (float32, ~1e-6 relative) rounding tolerance.
    if (post.authorId !== canonicalUserId && weight !== 0) {
      const initialAffinity = toSafePgRealSql(sql`${weight}::double precision`);

      const authorExistingAgeHours = sql`GREATEST(
        0::double precision,
        EXTRACT(EPOCH FROM (${eventTimeIso}::timestamptz - ${userAuthorAffinity.updatedAt})) / 3600.0::double precision
      )`;
      const authorIncomingAgeHours = sql`GREATEST(
        0::double precision,
        EXTRACT(EPOCH FROM (${userAuthorAffinity.updatedAt} - ${eventTimeIso}::timestamptz)) / 3600.0::double precision
      )`;

      const combinedAuthorExpr = sql`(
        ${safeHalfLifeDecaySql(
          sql`${userAuthorAffinity.score}`,
          authorExistingAgeHours,
          config.decay.authorAffinityHalfLifeHours,
        )}
        + ${safeHalfLifeDecaySql(
          sql`${weight}::double precision`,
          authorIncomingAgeHours,
          config.decay.authorAffinityHalfLifeHours,
        )}
      )`;

      await tx
        .insert(userAuthorAffinity)
        .values({
          userId: canonicalUserId,
          authorId: post.authorId,
          score: initialAffinity,
          updatedAt: eventTime,
        })
        .onConflictDoUpdate({
          target: [userAuthorAffinity.userId, userAuthorAffinity.authorId],
          set: {
            score: toSafePgRealSql(combinedAuthorExpr),
            updatedAt: sql`GREATEST(${userAuthorAffinity.updatedAt}, ${eventTimeIso}::timestamptz)`,
          },
        });

      const postTopicRows = await tx
        .select({ topicId: postTopics.topicId })
        .from(postTopics)
        .where(eq(postTopics.postId, canonicalPostId))
        .orderBy(asc(postTopics.topicId));

      if (postTopicRows.length > 0) {
        const topicExistingAgeHours = sql`GREATEST(
          0::double precision,
          EXTRACT(EPOCH FROM (${eventTimeIso}::timestamptz - ${userTopicAffinity.updatedAt})) / 3600.0::double precision
        )`;
        const topicIncomingAgeHours = sql`GREATEST(
          0::double precision,
          EXTRACT(EPOCH FROM (${userTopicAffinity.updatedAt} - ${eventTimeIso}::timestamptz)) / 3600.0::double precision
        )`;

        const combinedTopicExpr = sql`(
          ${safeHalfLifeDecaySql(
            sql`${userTopicAffinity.score}`,
            topicExistingAgeHours,
            config.decay.topicAffinityHalfLifeHours,
          )}
          + ${safeHalfLifeDecaySql(
            sql`${weight}::double precision`,
            topicIncomingAgeHours,
            config.decay.topicAffinityHalfLifeHours,
          )}
        )`;

        await tx
          .insert(userTopicAffinity)
          .values(
            postTopicRows.map((row) => ({
              userId: canonicalUserId,
              topicId: row.topicId,
              score: initialAffinity,
              updatedAt: eventTime,
            })),
          )
          .onConflictDoUpdate({
            target: [userTopicAffinity.userId, userTopicAffinity.topicId],
            set: {
              score: toSafePgRealSql(combinedTopicExpr),
              updatedAt: sql`GREATEST(${userTopicAffinity.updatedAt}, ${eventTimeIso}::timestamptz)`,
            },
          });
      }
    }

    return {
      recorded: true,
      duplicate: false,
      eventId: created.id,
      postId: canonicalPostId,
      type: input.type,
      weight,
      createdAt: created.createdAt.toISOString(),
    };
  });
}

export async function getUserSignals(
  userId: string,
  limit = 20,
  now: Date = new Date(),
): Promise<UserSignalsResponse> {
  const canonicalUserId = userId.toLowerCase();

  const [config, authorRows, topicRows] = await Promise.all([
    getRankingConfigSnapshot(),
    db
      .select({
        authorId: userAuthorAffinity.authorId,
        handle: users.handle,
        displayName: users.displayName,
        score: userAuthorAffinity.score,
        updatedAt: userAuthorAffinity.updatedAt,
      })
      .from(userAuthorAffinity)
      .innerJoin(users, eq(users.id, userAuthorAffinity.authorId))
      .where(eq(userAuthorAffinity.userId, canonicalUserId)),
    db
      .select({
        topicId: userTopicAffinity.topicId,
        name: topics.name,
        score: userTopicAffinity.score,
        updatedAt: userTopicAffinity.updatedAt,
      })
      .from(userTopicAffinity)
      .innerJoin(topics, eq(topics.id, userTopicAffinity.topicId))
      .where(eq(userTopicAffinity.userId, canonicalUserId)),
  ]);

  const authors: DecayedAuthorSignal[] = authorRows
    .map((row) => ({
      authorId: row.authorId,
      handle: row.handle,
      displayName: row.displayName,
      rawScore: row.score,
      decayedScore: decayScore(
        row.score,
        row.updatedAt,
        config.decay.authorAffinityHalfLifeHours,
        now,
      ),
      updatedAt: row.updatedAt.toISOString(),
    }))
    .sort((a, b) => b.decayedScore - a.decayedScore || a.authorId.localeCompare(b.authorId))
    .slice(0, limit);

  const topicSignals: DecayedTopicSignal[] = topicRows
    .map((row) => ({
      topicId: row.topicId,
      name: row.name,
      rawScore: row.score,
      decayedScore: decayScore(
        row.score,
        row.updatedAt,
        config.decay.topicAffinityHalfLifeHours,
        now,
      ),
      updatedAt: row.updatedAt.toISOString(),
    }))
    .sort((a, b) => b.decayedScore - a.decayedScore || a.topicId - b.topicId)
    .slice(0, limit);

  return {
    userId: canonicalUserId,
    evaluatedAt: now.toISOString(),
    authors,
    topics: topicSignals,
  };
}

/**
 * Loads the subset of author and topic affinities needed to score a set of candidate posts.
 */
export async function loadUserSignalsContext(
  userId: string,
  authorIds: readonly string[],
  topicIds: readonly number[],
  executor: DbReader = db,
): Promise<UserSignalsContext> {
  const canonicalUserId = userId.toLowerCase();
  const uniqueAuthors = [...new Set(authorIds)];
  const uniqueTopics = [...new Set(topicIds)];

  const authorRows =
    uniqueAuthors.length > 0
      ? await executor
          .select({
            authorId: userAuthorAffinity.authorId,
            score: userAuthorAffinity.score,
            updatedAt: userAuthorAffinity.updatedAt,
          })
          .from(userAuthorAffinity)
          .where(
            and(
              eq(userAuthorAffinity.userId, canonicalUserId),
              inArray(userAuthorAffinity.authorId, uniqueAuthors),
            ),
          )
      : [];

  const topicRows =
    uniqueTopics.length > 0
      ? await executor
          .select({
            topicId: userTopicAffinity.topicId,
            score: userTopicAffinity.score,
            updatedAt: userTopicAffinity.updatedAt,
          })
          .from(userTopicAffinity)
          .where(
            and(
              eq(userTopicAffinity.userId, canonicalUserId),
              inArray(userTopicAffinity.topicId, uniqueTopics),
            ),
          )
      : [];

  const authorAffinities = new Map<string, TimedAffinity>(
    authorRows.map((r) => [r.authorId, { score: r.score, updatedAt: r.updatedAt }]),
  );
  const topicAffinities = new Map<number, TimedAffinity>(
    topicRows.map((r) => [r.topicId, { score: r.score, updatedAt: r.updatedAt }]),
  );

  return { authorAffinities, topicAffinities };
}
