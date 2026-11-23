import {
  DEFAULT_RANKING_CONFIG,
  type InteractionWeights,
  type RankingConfig,
} from '../../config/ranking.js';
import type {
  CandidatePost,
  PostStatsSnapshot,
  ScoredCandidate,
  TimedAffinity,
  UserSignalsContext,
} from './ranking.types.js';

const MS_PER_HOUR = 3_600_000;

/**
 * Signed logarithmic compression: preserves negative signals while dampening
 * viral outliers so personal affinities aren't drowned out.
 */
export function signedLog(value: number): number {
  if (value === 0) return 0;
  return Math.sign(value) * Math.log1p(Math.abs(value));
}

/**
 * Exponential half-life decay: score * 2^(-ageHours / halfLifeHours).
 * Clamps negative ages (clock skew / future timestamps) to 0.
 */
export function decayScore(
  score: number,
  updatedAt: Date,
  halfLifeHours: number,
  now: Date = new Date(),
): number {
  if (score === 0) return 0;
  const ageHours = Math.max(0, (now.getTime() - updatedAt.getTime()) / MS_PER_HOUR);
  return score * Math.pow(2, -ageHours / halfLifeHours);
}

/**
 * Computes weighted engagement from raw post_stats counts using the active weights.
 */
export function computeEngagementScore(
  stats: PostStatsSnapshot,
  weights: InteractionWeights,
): number {
  return (
    stats.replyCount * weights.reply +
    stats.repostCount * weights.repost +
    stats.likeCount * weights.like +
    stats.viewCount * weights.view +
    stats.notInterestedCount * weights.not_interested +
    stats.reportCount * weights.report
  );
}

/**
 * Aggregates decayed topic affinities for a post's unique topics.
 * - Positive affinities divide by sqrt(uniqueTopicCount) so stuffing unrelated hashtags dilutes spam boosts.
 * - Negative affinities divide only by sqrt(negativeMatchCount) so unrelated hashtags cannot dilute penalties.
 */
export function aggregateTopicAffinity(
  topicIds: readonly number[],
  topicAffinities: ReadonlyMap<number, TimedAffinity>,
  halfLifeHours: number,
  now: Date = new Date(),
): number {
  if (topicIds.length === 0) return 0;
  const uniqueIds = new Set(topicIds);

  let posSum = 0;
  let negSum = 0;
  let negCount = 0;

  for (const topicId of uniqueIds) {
    const entry = topicAffinities.get(topicId);
    if (!entry) continue;
    const decayed = decayScore(entry.score, entry.updatedAt, halfLifeHours, now);
    if (decayed > 0) {
      posSum += decayed;
    } else if (decayed < 0) {
      negSum += decayed;
      negCount += 1;
    }
  }

  const posContribution = posSum > 0 ? posSum / Math.sqrt(uniqueIds.size) : 0;
  const negContribution = negCount > 0 ? negSum / Math.sqrt(negCount) : 0;
  return posContribution + negContribution;
}

function compareScored<T extends CandidatePost>(
  a: ScoredCandidate<T>,
  b: ScoredCandidate<T>,
): number {
  if (b.score !== a.score) return b.score - a.score;
  const createdDiff = b.candidate.createdAt.getTime() - a.candidate.createdAt.getTime();
  if (createdDiff !== 0) return createdDiff;
  return a.candidate.id.localeCompare(b.candidate.id);
}

export function scoreCandidate<T extends CandidatePost>(
  candidate: T,
  signals: UserSignalsContext,
  config: RankingConfig = DEFAULT_RANKING_CONFIG,
  now: Date = new Date(),
): ScoredCandidate<T> {
  const authorEntry = signals.authorAffinities.get(candidate.authorId);
  const authorAffinity = authorEntry
    ? decayScore(
        authorEntry.score,
        authorEntry.updatedAt,
        config.decay.authorAffinityHalfLifeHours,
        now,
      )
    : 0;

  const topicAffinity = aggregateTopicAffinity(
    candidate.topicIds,
    signals.topicAffinities,
    config.decay.topicAffinityHalfLifeHours,
    now,
  );

  const engagement = computeEngagementScore(candidate.stats, config.weights);
  const socialProofCount = Math.max(0, candidate.socialProofCount);
  const ageHours = Math.max(0, (now.getTime() - candidate.createdAt.getTime()) / MS_PER_HOUR);

  const authorTerm = config.scoring.authorAffinityWeight * signedLog(authorAffinity);
  const topicTerm = config.scoring.topicAffinityWeight * signedLog(topicAffinity);
  const engagementTerm = config.scoring.engagementWeight * signedLog(engagement);
  const socialProofTerm = config.scoring.socialProofWeight * Math.log1p(socialProofCount);
  const signalSum = authorTerm + topicTerm + engagementTerm + socialProofTerm;

  // Apply coldStartBias only to non-negative candidates so mildly penalized posts stay negative.
  const coldStartBias = signalSum >= 0 ? config.scoring.coldStartBias : 0;

  const terms = {
    author: authorTerm,
    topic: topicTerm,
    engagement: engagementTerm,
    socialProof: socialProofTerm,
    coldStartBias,
  };

  const baseScore = signalSum + coldStartBias;

  const rawRecency = Math.pow(2, -ageHours / config.decay.recencyHalfLifeHours);
  const rawNetwork = candidate.inNetwork ? config.scoring.inNetworkBoost : 1.0;

  // Only decay/boost positive scores so heavily penalized posts don't drift upward with age,
  // and report the exact applied multipliers in `breakdown` (1.0 when skipped).
  const recency = baseScore > 0 ? rawRecency : 1.0;
  const network = baseScore > 0 ? rawNetwork : 1.0;
  const finalScore = baseScore * recency * network;

  return {
    candidate,
    score: finalScore,
    breakdown: {
      sources: [...candidate.sources],
      raw: {
        authorAffinity,
        topicAffinity,
        engagement,
        socialProofCount,
        ageHours,
      },
      terms,
      multipliers: {
        recency,
        network,
        authorDiversity: 1.0,
      },
      baseScore,
      finalScore,
    },
  };
}

/**
 * X-style author diversity pass: attenuates each repeat post by the same author
 * using `floor + (1 - floor) * decay^k` (for positive scores) and re-sorts.
 */
export function applyAuthorDiversity<T extends CandidatePost>(
  scored: ReadonlyArray<ScoredCandidate<T>>,
  config: RankingConfig = DEFAULT_RANKING_CONFIG,
): ScoredCandidate<T>[] {
  const ordered = [...scored].sort(compareScored);
  const countByAuthor = new Map<string, number>();
  const { authorRepeatDecay: decay, authorRepeatFloor: floor } = config.diversity;

  const diversified = ordered.map((item) => {
    const seen = countByAuthor.get(item.candidate.authorId) ?? 0;
    countByAuthor.set(item.candidate.authorId, seen + 1);

    const rawMultiplier = seen === 0 ? 1.0 : floor + (1 - floor) * Math.pow(decay, seen);
    const authorDiversity = item.score > 0 ? rawMultiplier : 1.0;
    const finalScore = item.score * authorDiversity;

    return {
      candidate: item.candidate,
      score: finalScore,
      breakdown: {
        ...item.breakdown,
        multipliers: {
          ...item.breakdown.multipliers,
          authorDiversity,
        },
        finalScore,
      },
    };
  });

  return diversified.sort(compareScored);
}

/**
 * Full ranking pass: scores all candidates and applies author diversity attenuation.
 */
export function rankCandidates<T extends CandidatePost>(
  candidates: ReadonlyArray<T>,
  signals: UserSignalsContext,
  config: RankingConfig = DEFAULT_RANKING_CONFIG,
  now: Date = new Date(),
): ScoredCandidate<T>[] {
  const scored = candidates.map((candidate) => scoreCandidate(candidate, signals, config, now));
  return applyAuthorDiversity(scored, config);
}
