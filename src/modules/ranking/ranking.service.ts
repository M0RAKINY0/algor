import { eq, sql } from 'drizzle-orm';
import {
  DEFAULT_RANKING_CONFIG,
  havePostStatsWeightsChanged,
  mergeRankingConfig,
  rankingConfigSchema,
  type InteractionWeights,
  type PatchRankingConfig,
  type RankingConfig,
} from '../../config/ranking.js';
import { db } from '../../db/index.js';
import { postStats, rankingConfig } from '../../db/schema.js';

const SINGLETON_ID = 1;

type DbExecutor = Pick<typeof db, 'select' | 'insert' | 'update'>;

async function ensureAndLockConfigRow(
  tx: DbExecutor,
): Promise<{ config: RankingConfig; version: number }> {
  await tx
    .insert(rankingConfig)
    .values({
      id: SINGLETON_ID,
      config: structuredClone(DEFAULT_RANKING_CONFIG),
      version: 1,
    })
    .onConflictDoNothing({ target: rankingConfig.id });

  const [row] = await tx
    .select({ config: rankingConfig.config, version: rankingConfig.version })
    .from(rankingConfig)
    .where(eq(rankingConfig.id, SINGLETON_ID))
    .for('update');

  return {
    config: rankingConfigSchema.parse(row!.config),
    version: row!.version,
  };
}

/**
 * Reads the active ranking config row inside an existing transaction with a `FOR SHARE` lock.
 * Upcoming `signals` writes can call this so incremental `post_stats` updates always use the
 * exact same weight version as concurrent config rebuilds.
 */
export async function readRankingConfigForShare(tx: DbExecutor): Promise<RankingConfig> {
  await tx
    .insert(rankingConfig)
    .values({
      id: SINGLETON_ID,
      config: structuredClone(DEFAULT_RANKING_CONFIG),
      version: 1,
    })
    .onConflictDoNothing({ target: rankingConfig.id });

  const [row] = await tx
    .select({ config: rankingConfig.config })
    .from(rankingConfig)
    .where(eq(rankingConfig.id, SINGLETON_ID))
    .for('share');

  return rankingConfigSchema.parse(row!.config);
}

export async function getRankingConfigSnapshot(): Promise<RankingConfig> {
  const [existing] = await db
    .select({ config: rankingConfig.config })
    .from(rankingConfig)
    .where(eq(rankingConfig.id, SINGLETON_ID));

  if (existing) {
    return rankingConfigSchema.parse(existing.config);
  }

  return db.transaction(async (tx) => {
    const { config } = await ensureAndLockConfigRow(tx);
    return config;
  });
}

export async function recomputePostEngagementScores(
  weights: InteractionWeights,
  executor: DbExecutor = db,
): Promise<void> {
  // Cast every integer count and fractional weight parameter explicitly to double precision
  // so PostgreSQL never infers decimal parameters (e.g. 13.5, 0.5) as integer.
  // In IEEE-754 float32 round-to-nearest-even, values with |x| <= 2^-150 (half of the smallest
  // nonzero float32 subnormal 2^-149) round to 0 and would raise PostgreSQL `real` underflow.
  // Flush only those exact values to 0::real while preserving every representable nonzero `real`.
  const scoreExpr = sql`(
    (${postStats.replyCount}::double precision * ${weights.reply}::double precision)
    + (${postStats.repostCount}::double precision * ${weights.repost}::double precision)
    + (${postStats.likeCount}::double precision * ${weights.like}::double precision)
    + (${postStats.viewCount}::double precision * ${weights.view}::double precision)
    + (${postStats.notInterestedCount}::double precision * ${weights.not_interested}::double precision)
    + (${postStats.reportCount}::double precision * ${weights.report}::double precision)
  )`;

  await executor.update(postStats).set({
    engagementScore: sql`CASE
      WHEN abs(${scoreExpr}) <= power(2::double precision, -150) THEN 0::real
      ELSE (${scoreExpr})::real
    END`,
    updatedAt: new Date(),
  });
}

export async function patchRankingConfig(patch: PatchRankingConfig): Promise<RankingConfig> {
  return db.transaction(async (tx) => {
    const { config: current, version } = await ensureAndLockConfigRow(tx);
    const next = mergeRankingConfig(current, patch);

    if (havePostStatsWeightsChanged(current.weights, next.weights)) {
      await recomputePostEngagementScores(next.weights, tx);
    }

    await tx
      .update(rankingConfig)
      .set({
        config: next,
        version: version + 1,
        updatedAt: new Date(),
      })
      .where(eq(rankingConfig.id, SINGLETON_ID));

    return structuredClone(next);
  });
}

export async function resetRankingConfigToDefaults(): Promise<RankingConfig> {
  return db.transaction(async (tx) => {
    const { config: current, version } = await ensureAndLockConfigRow(tx);
    const defaults = structuredClone(DEFAULT_RANKING_CONFIG);

    if (havePostStatsWeightsChanged(current.weights, defaults.weights)) {
      await recomputePostEngagementScores(defaults.weights, tx);
    }

    await tx
      .update(rankingConfig)
      .set({
        config: defaults,
        version: version + 1,
        updatedAt: new Date(),
      })
      .where(eq(rankingConfig.id, SINGLETON_ID));

    return structuredClone(defaults);
  });
}
