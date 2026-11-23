import { sql, type SQL } from 'drizzle-orm';
import type { InteractionWeights } from '../../config/ranking.js';

export interface PostStatsSqlExpressions {
  replyCount: SQL | unknown;
  repostCount: SQL | unknown;
  likeCount: SQL | unknown;
  viewCount: SQL | unknown;
  notInterestedCount: SQL | unknown;
  reportCount: SQL | unknown;
}

/**
 * Safely casts a PostgreSQL `double precision` expression to `real` (IEEE-754 float32):
 * - Flushes only exact round-to-nearest-even float32 underflows (|x| <= 2^-150) to 0::real
 *   so representable normal and subnormal `real` values are preserved without underflow errors.
 * - Clamps extreme magnitudes to [-1e30, 1e30] so float32 overflow is impossible.
 */
export function toSafePgRealSql(doubleExpr: SQL): SQL {
  return sql`CASE
    WHEN abs(${doubleExpr}) <= power(2::double precision, -150) THEN 0::real
    ELSE (GREATEST(-1e30::double precision, LEAST(1e30::double precision, ${doubleExpr})))::real
  END`;
}

/**
 * Safely decays a PostgreSQL numeric value by `2^(-ageHours / halfLifeHours)` in `double precision`
 * without ever raising PostgreSQL `dpow` or `float8mul` underflow errors:
 * - Any value already at or below `2^-150` stays below the float32 cutoff after decay (returns 0).
 * - After 260 half-lives, even the maximum clamped `real` magnitude (`1e30 < 2^100`) decays below
 *   `2^-160 < 2^-150` (returns 0).
 * - For all other inputs, `abs(value) * 2^(-exp) > 2^-150 * 2^-260 = 2^-410 >> 2^-1022`, well
 *   above float64 underflow.
 */
export function safeHalfLifeDecaySql(
  valueExpr: SQL,
  ageHoursExpr: SQL,
  halfLifeHours: number,
): SQL {
  const halfLivesExpr = sql`(${ageHoursExpr} / ${halfLifeHours}::double precision)`;
  return sql`CASE
    WHEN abs(${valueExpr}::double precision) <= power(2::double precision, -150)
      OR ${halfLivesExpr} >= 260::double precision
    THEN 0::double precision
    ELSE (${valueExpr}::double precision) * power(2::double precision, -(${halfLivesExpr}))
  END`;
}

/**
 * Shared SQL expression computing `post_stats.engagement_score` from the 6 counter expressions
 * and active interaction weights. Used identically by full weight rebuilds and incremental events.
 */
export function buildEngagementScoreSql(
  counts: PostStatsSqlExpressions,
  weights: InteractionWeights,
): SQL {
  const scoreExpr = sql`(
    (${counts.replyCount}::double precision * ${weights.reply}::double precision)
    + (${counts.repostCount}::double precision * ${weights.repost}::double precision)
    + (${counts.likeCount}::double precision * ${weights.like}::double precision)
    + (${counts.viewCount}::double precision * ${weights.view}::double precision)
    + (${counts.notInterestedCount}::double precision * ${weights.not_interested}::double precision)
    + (${counts.reportCount}::double precision * ${weights.report}::double precision)
  )`;

  return toSafePgRealSql(scoreExpr);
}
