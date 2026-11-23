import { eq } from 'drizzle-orm';
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
import { buildEngagementScoreSql } from './ranking.sql.js';

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
 * Signal writes call this so incremental `post_stats` updates always use the exact same weight
 * version as concurrent config rebuilds.
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
  await executor.update(postStats).set({
    engagementScore: buildEngagementScoreSql(
      {
        replyCount: postStats.replyCount,
        repostCount: postStats.repostCount,
        likeCount: postStats.likeCount,
        viewCount: postStats.viewCount,
        notInterestedCount: postStats.notInterestedCount,
        reportCount: postStats.reportCount,
      },
      weights,
    ),
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
