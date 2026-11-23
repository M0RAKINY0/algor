import { z } from 'zod';

const weightNumber = () => z.number().finite().min(-10_000).max(10_000);
const halfLifeHours = () => z.number().finite().min(0.1).max(87_600);
const scoringWeight = () => z.number().finite().min(0).max(100);

export const interactionWeightsSchema = z
  .object({
    reply: weightNumber(),
    repost: weightNumber(),
    like: weightNumber(),
    profile_click: weightNumber(),
    view: weightNumber(),
    not_interested: weightNumber(),
    report: weightNumber(),
  })
  .strict();

export const decayConfigSchema = z
  .object({
    authorAffinityHalfLifeHours: halfLifeHours(),
    topicAffinityHalfLifeHours: halfLifeHours(),
    recencyHalfLifeHours: halfLifeHours(),
  })
  .strict();

export const scoringConfigSchema = z
  .object({
    authorAffinityWeight: scoringWeight(),
    topicAffinityWeight: scoringWeight(),
    engagementWeight: scoringWeight(),
    socialProofWeight: scoringWeight(),
    inNetworkBoost: z.number().finite().min(0.01).max(100),
    coldStartBias: scoringWeight(),
  })
  .strict();

export const diversityConfigSchema = z
  .object({
    authorRepeatDecay: z.number().finite().min(0.01).max(1),
    authorRepeatFloor: z.number().finite().min(0).max(1),
    maxConsecutivePerAuthor: z.number().int().min(1).max(20),
    inNetworkRatio: z.number().finite().min(0).max(1),
    candidateLimit: z.number().int().min(1).max(2000),
  })
  .strict();

export const rankingConfigSchema = z
  .object({
    weights: interactionWeightsSchema,
    decay: decayConfigSchema,
    scoring: scoringConfigSchema,
    diversity: diversityConfigSchema,
  })
  .strict();

export const patchRankingConfigSchema = z
  .object({
    weights: interactionWeightsSchema.partial().strict().optional(),
    decay: decayConfigSchema.partial().strict().optional(),
    scoring: scoringConfigSchema.partial().strict().optional(),
    diversity: diversityConfigSchema.partial().strict().optional(),
  })
  .strict();

export type InteractionWeights = z.infer<typeof interactionWeightsSchema>;
export type DecayConfig = z.infer<typeof decayConfigSchema>;
export type ScoringConfig = z.infer<typeof scoringConfigSchema>;
export type DiversityConfig = z.infer<typeof diversityConfigSchema>;
export type RankingConfig = z.infer<typeof rankingConfigSchema>;
export type PatchRankingConfig = z.infer<typeof patchRankingConfigSchema>;

export const DEFAULT_RANKING_CONFIG: Readonly<RankingConfig> = rankingConfigSchema.parse({
  weights: {
    reply: 13.5,
    repost: 1.0,
    like: 0.5,
    profile_click: 0.5,
    view: 0.0,
    not_interested: -74.0,
    report: -369.0,
  },
  decay: {
    authorAffinityHalfLifeHours: 168,
    topicAffinityHalfLifeHours: 336,
    recencyHalfLifeHours: 24,
  },
  scoring: {
    authorAffinityWeight: 2.0,
    topicAffinityWeight: 1.5,
    engagementWeight: 1.0,
    socialProofWeight: 1.2,
    inNetworkBoost: 1.25,
    coldStartBias: 0.1,
  },
  diversity: {
    authorRepeatDecay: 0.5,
    authorRepeatFloor: 0.25,
    maxConsecutivePerAuthor: 2,
    inNetworkRatio: 0.6,
    candidateLimit: 500,
  },
});

export function mergeRankingConfig(base: RankingConfig, patch: PatchRankingConfig): RankingConfig {
  const parsedPatch = patchRankingConfigSchema.parse(patch);
  return rankingConfigSchema.parse({
    weights: { ...base.weights, ...parsedPatch.weights },
    decay: { ...base.decay, ...parsedPatch.decay },
    scoring: { ...base.scoring, ...parsedPatch.scoring },
    diversity: { ...base.diversity, ...parsedPatch.diversity },
  });
}

// Only these 6 weights contribute to post_stats.engagement_score (`profile_click` affects
// user_author_affinity only and has no post_stats counter).
const POST_STATS_WEIGHT_KEYS = [
  'reply',
  'repost',
  'like',
  'view',
  'not_interested',
  'report',
] as const;

export function havePostStatsWeightsChanged(
  prev: InteractionWeights,
  next: InteractionWeights,
): boolean {
  return POST_STATS_WEIGHT_KEYS.some((key) => prev[key] !== next[key]);
}
