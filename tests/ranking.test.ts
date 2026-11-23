import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RANKING_CONFIG,
  havePostStatsWeightsChanged,
  mergeRankingConfig,
  type RankingConfig,
} from '../src/config/ranking.js';
import {
  aggregateTopicAffinity,
  applyAuthorDiversity,
  computeEngagementScore,
  decayScore,
  rankCandidates,
  scoreCandidate,
  signedLog,
} from '../src/modules/ranking/ranking.scorer.js';
import type { CandidatePost, UserSignalsContext } from '../src/modules/ranking/ranking.types.js';

const getRankingConfigSnapshot = vi.fn();
const patchRankingConfig = vi.fn();
const resetRankingConfigToDefaults = vi.fn();

vi.mock('../src/modules/ranking/ranking.service.js', () => ({
  getRankingConfigSnapshot,
  patchRankingConfig,
  resetRankingConfigToDefaults,
}));

const { createApp } = await import('../src/app.js');

const NOW = new Date('2026-11-23T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const EMPTY_STATS = {
  viewCount: 0,
  likeCount: 0,
  replyCount: 0,
  repostCount: 0,
  notInterestedCount: 0,
  reportCount: 0,
};

function makeCandidate(overrides: Partial<CandidatePost> = {}): CandidatePost {
  return {
    id: 'post-1',
    authorId: 'author-1',
    createdAt: NOW,
    inNetwork: false,
    sources: ['trending'],
    topicIds: [],
    stats: { ...EMPTY_STATS },
    socialProofCount: 0,
    ...overrides,
  };
}

function makeSignals(
  authors: Array<[string, number, Date]> = [],
  topics: Array<[number, number, Date]> = [],
): UserSignalsContext {
  return {
    authorAffinities: new Map(authors.map(([id, score, updatedAt]) => [id, { score, updatedAt }])),
    topicAffinities: new Map(topics.map(([id, score, updatedAt]) => [id, { score, updatedAt }])),
  };
}

describe('ranking config schemas & helpers', () => {
  it('exposes X-inspired defaults and merges consecutive partial updates without clobbering siblings', () => {
    expect(DEFAULT_RANKING_CONFIG.weights).toEqual({
      reply: 13.5,
      repost: 1.0,
      like: 0.5,
      profile_click: 0.5,
      view: 0.0,
      not_interested: -74.0,
      report: -369.0,
    });

    const first = mergeRankingConfig(DEFAULT_RANKING_CONFIG, {
      weights: { reply: 20.0 },
      decay: { recencyHalfLifeHours: 12 },
    });
    const second = mergeRankingConfig(first, {
      weights: { like: 2.0 },
    });

    expect(second.weights.like).toBe(2.0);
    expect(second.weights.reply).toBe(20.0);
    expect(second.decay.recencyHalfLifeHours).toBe(12);
    expect(second.decay.authorAffinityHalfLifeHours).toBe(
      DEFAULT_RANKING_CONFIG.decay.authorAffinityHalfLifeHours,
    );
  });

  it('detects whether any of the 6 post_stats engagement weights changed', () => {
    const base = DEFAULT_RANKING_CONFIG.weights;
    expect(havePostStatsWeightsChanged(base, { ...base })).toBe(false);
    // profile_click is not stored in post_stats, so changing it should not force a rebuild
    expect(havePostStatsWeightsChanged(base, { ...base, profile_click: 4.0 })).toBe(false);
    expect(havePostStatsWeightsChanged(base, { ...base, like: 1.5 })).toBe(true);
    expect(havePostStatsWeightsChanged(base, { ...base, report: -500 })).toBe(true);
  });

  it('rejects out-of-bounds values and unknown keys', () => {
    expect(() =>
      mergeRankingConfig(DEFAULT_RANKING_CONFIG, { decay: { recencyHalfLifeHours: 0 } }),
    ).toThrow();
    expect(() =>
      mergeRankingConfig(DEFAULT_RANKING_CONFIG, { decay: { recencyHalfLifeHours: 100_000 } }),
    ).toThrow();
    expect(() =>
      mergeRankingConfig(DEFAULT_RANKING_CONFIG, { weights: { like: 50_000 } }),
    ).toThrow();
    expect(() =>
      mergeRankingConfig(DEFAULT_RANKING_CONFIG, { scoring: { inNetworkBoost: 101 } }),
    ).toThrow();
    expect(() =>
      mergeRankingConfig(DEFAULT_RANKING_CONFIG, { diversity: { authorRepeatDecay: 0 } }),
    ).toThrow();
    expect(() =>
      mergeRankingConfig(DEFAULT_RANKING_CONFIG, { diversity: { inNetworkRatio: 1.5 } }),
    ).toThrow();
    expect(() =>
      mergeRankingConfig(DEFAULT_RANKING_CONFIG, { weights: { unknown: 1 } } as never),
    ).toThrow();
  });
});

describe('ranking math helpers', () => {
  it('computes signed logarithmic compression preserving sign and zero', () => {
    expect(signedLog(0)).toBe(0);
    expect(signedLog(Math.E - 1)).toBeCloseTo(1, 6);
    expect(signedLog(-(Math.E - 1))).toBeCloseTo(-1, 6);
    expect(signedLog(1000)).toBeLessThan(signedLog(10) * 3);
  });

  it('decays scores by half-life and clamps future timestamps to age 0', () => {
    expect(decayScore(10, NOW, 24, NOW)).toBeCloseTo(10, 6);
    expect(decayScore(10, hoursAgo(24), 24, NOW)).toBeCloseTo(5, 6);
    expect(decayScore(10, hoursAgo(48), 24, NOW)).toBeCloseTo(2.5, 6);
    expect(decayScore(-10, hoursAgo(24), 24, NOW)).toBeCloseTo(-5, 6);
    expect(decayScore(10, hoursAgo(-5), 24, NOW)).toBeCloseTo(10, 6);
    expect(decayScore(0, hoursAgo(24), 24, NOW)).toBe(0);
  });

  it('computes weighted engagement from post_stats counts', () => {
    const score = computeEngagementScore(
      {
        viewCount: 100,
        likeCount: 10,
        replyCount: 2,
        repostCount: 3,
        notInterestedCount: 0,
        reportCount: 0,
      },
      DEFAULT_RANKING_CONFIG.weights,
    );
    // 2*13.5 + 3*1.0 + 10*0.5 + 100*0.0 = 35
    expect(score).toBeCloseTo(35, 6);

    const penalized = computeEngagementScore(
      { ...EMPTY_STATS, likeCount: 2, reportCount: 1 },
      DEFAULT_RANKING_CONFIG.weights,
    );
    // 2*0.5 + 1*(-369) = -368
    expect(penalized).toBeCloseTo(-368, 6);
  });

  it('aggregates topic affinity resisting positive spam without letting unrelated tags dilute penalties', () => {
    const signals = makeSignals(
      [],
      [
        [1, 10, NOW],
        [2, 10, NOW],
        [3, -20, NOW],
        [4, -20, NOW],
      ],
    );

    expect(aggregateTopicAffinity([], signals.topicAffinities, 336, NOW)).toBe(0);
    // Duplicate topic IDs should not double-count
    expect(aggregateTopicAffinity([1, 1, 1], signals.topicAffinities, 336, NOW)).toBeCloseTo(10, 6);
    // Two positive topics: (10 + 10) / sqrt(2)
    expect(aggregateTopicAffinity([1, 2], signals.topicAffinities, 336, NOW)).toBeCloseTo(
      20 / Math.SQRT2,
      6,
    );
    // Stuffing unrelated tags dilutes positive affinity: 10 / sqrt(4) = 5
    expect(
      aggregateTopicAffinity([1, 99, 100, 101], signals.topicAffinities, 336, NOW),
    ).toBeCloseTo(5, 6);
    // Stuffing unrelated tags must NOT dilute a negative topic penalty: -20 / sqrt(1) = -20
    expect(
      aggregateTopicAffinity([3, 99, 100, 101], signals.topicAffinities, 336, NOW),
    ).toBeCloseTo(-20, 6);
    // Two negative topics combine with sqrt(negCount): (-20 + -20) / sqrt(2)
    expect(aggregateTopicAffinity([3, 4, 99, 100], signals.topicAffinities, 336, NOW)).toBeCloseTo(
      -40 / Math.SQRT2,
      6,
    );
    // Mixed positive + negative: 10 / sqrt(2) + (-20) / sqrt(1)
    expect(aggregateTopicAffinity([1, 3], signals.topicAffinities, 336, NOW)).toBeCloseTo(
      10 / Math.SQRT2 - 20,
      6,
    );
  });
});

describe('scoreCandidate & rankCandidates', () => {
  const cfg: RankingConfig = structuredClone(DEFAULT_RANKING_CONFIG);

  it('keeps cold-start posts positive via coldStartBias without lifting mildly negative sums above zero', () => {
    const coldStart = scoreCandidate(makeCandidate(), makeSignals(), cfg, NOW);
    expect(coldStart.score).toBeCloseTo(cfg.scoring.coldStartBias, 6);
    expect(coldStart.breakdown.terms.coldStartBias).toBe(cfg.scoring.coldStartBias);
    expect(coldStart.breakdown.finalScore).toBe(coldStart.score);

    // Mild negative author affinity produces a small negative signalSum (-0.04), which must stay negative
    const mildlyNegative = scoreCandidate(
      makeCandidate({ authorId: 'mild-neg', inNetwork: true }),
      makeSignals([['mild-neg', -0.02, NOW]]),
      cfg,
      NOW,
    );
    expect(mildlyNegative.breakdown.terms.coldStartBias).toBe(0);
    expect(mildlyNegative.score).toBeLessThan(0);
    expect(mildlyNegative.breakdown.multipliers).toEqual({
      recency: 1.0,
      network: 1.0,
      authorDiversity: 1.0,
    });
  });

  it('applies recency decay and in-network boost to positive scores', () => {
    const basePost = makeCandidate({
      stats: { ...EMPTY_STATS, likeCount: 20, replyCount: 2 },
    });

    const freshOut = scoreCandidate(basePost, makeSignals(), cfg, NOW);
    const oldOut = scoreCandidate(
      { ...basePost, createdAt: hoursAgo(cfg.decay.recencyHalfLifeHours) },
      makeSignals(),
      cfg,
      NOW,
    );
    const freshIn = scoreCandidate({ ...basePost, inNetwork: true }, makeSignals(), cfg, NOW);

    expect(oldOut.score).toBeCloseTo(freshOut.score * 0.5, 6);
    expect(freshIn.score).toBeCloseTo(freshOut.score * cfg.scoring.inNetworkBoost, 6);
    expect(freshIn.breakdown.multipliers.network).toBe(cfg.scoring.inNetworkBoost);
  });

  it('keeps negative posts negative and reports exact applied multipliers in debug breakdown', () => {
    const signals = makeSignals([['toxic-author', -74, NOW]]);
    const freshBad = scoreCandidate(
      makeCandidate({
        authorId: 'toxic-author',
        inNetwork: true,
        stats: { ...EMPTY_STATS, reportCount: 1 },
      }),
      signals,
      cfg,
      NOW,
    );
    const oldBad = scoreCandidate(
      makeCandidate({
        authorId: 'toxic-author',
        inNetwork: true,
        createdAt: hoursAgo(72),
        stats: { ...EMPTY_STATS, reportCount: 1 },
      }),
      signals,
      cfg,
      NOW,
    );

    expect(freshBad.score).toBeLessThan(0);
    expect(oldBad.score).toBeCloseTo(freshBad.score, 6);
    expect(oldBad.breakdown.multipliers).toEqual({
      recency: 1.0,
      network: 1.0,
      authorDiversity: 1.0,
    });
    expect(
      oldBad.breakdown.baseScore *
        oldBad.breakdown.multipliers.recency *
        oldBad.breakdown.multipliers.network *
        oldBad.breakdown.multipliers.authorDiversity,
    ).toBeCloseTo(oldBad.breakdown.finalScore, 6);
  });

  it('attenuates repeat posts from the same author so another author can overtake them', () => {
    const signals = makeSignals([
      ['alice', 20, NOW],
      ['bob', 12, NOW],
    ]);

    const candidates = [
      makeCandidate({ id: 'alice-1', authorId: 'alice', inNetwork: true }),
      makeCandidate({ id: 'alice-2', authorId: 'alice', inNetwork: true }),
      makeCandidate({ id: 'alice-3', authorId: 'alice', inNetwork: true }),
      makeCandidate({ id: 'bob-1', authorId: 'bob', inNetwork: true }),
    ];

    const ranked = rankCandidates(candidates, signals, cfg, NOW);
    expect(ranked.map((r) => r.candidate.id)).toEqual(['alice-1', 'bob-1', 'alice-2', 'alice-3']);

    // Diversity multipliers: 1.0, 0.25 + 0.75*0.5 = 0.625, 0.25 + 0.75*0.25 = 0.4375
    const byId = new Map(ranked.map((r) => [r.candidate.id, r]));
    expect(byId.get('alice-1')?.breakdown.multipliers.authorDiversity).toBeCloseTo(1.0, 6);
    expect(byId.get('alice-2')?.breakdown.multipliers.authorDiversity).toBeCloseTo(0.625, 6);
    expect(byId.get('alice-3')?.breakdown.multipliers.authorDiversity).toBeCloseTo(0.4375, 6);
    expect(byId.get('bob-1')?.breakdown.multipliers.authorDiversity).toBeCloseTo(1.0, 6);
  });

  it('does not boost negative-scored posts during author diversity attenuation', () => {
    const bad1 = scoreCandidate(
      makeCandidate({ id: 'bad-1', authorId: 'spam', stats: { ...EMPTY_STATS, reportCount: 1 } }),
      makeSignals(),
      cfg,
      NOW,
    );
    const bad2 = scoreCandidate(
      makeCandidate({ id: 'bad-2', authorId: 'spam', stats: { ...EMPTY_STATS, reportCount: 1 } }),
      makeSignals(),
      cfg,
      NOW,
    );

    const diversified = applyAuthorDiversity([bad1, bad2], cfg);
    expect(diversified[0]?.score).toBe(bad1.score);
    expect(diversified[1]?.score).toBe(bad2.score);
    expect(diversified[1]?.breakdown.multipliers.authorDiversity).toBe(1.0);
  });

  it('uses deterministic tie-breaking: newer createdAt first, then ascending id', () => {
    // Same score (negative, so recency does not alter score), different timestamps + tied timestamps
    const sharedStats = { ...EMPTY_STATS, reportCount: 1 };
    const candidates = [
      makeCandidate({ id: 'older', authorId: 'a1', createdAt: hoursAgo(5), stats: sharedStats }),
      makeCandidate({ id: 'newer-b', authorId: 'a2', createdAt: hoursAgo(1), stats: sharedStats }),
      makeCandidate({ id: 'newer-a', authorId: 'a3', createdAt: hoursAgo(1), stats: sharedStats }),
    ];

    const ranked = rankCandidates(candidates, makeSignals(), cfg, NOW);
    expect(ranked.map((r) => r.candidate.id)).toEqual(['newer-a', 'newer-b', 'older']);
  });
});

describe('ranking config routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serves GET, PATCH (with validation), and POST reset on /api/ranking/config', async () => {
    const app = createApp();

    getRankingConfigSnapshot.mockResolvedValueOnce(DEFAULT_RANKING_CONFIG);
    const getRes = await request(app).get('/api/ranking/config');
    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual(DEFAULT_RANKING_CONFIG);

    // Reject invalid values, out-of-bounds weights, and unknown keys
    expect(
      (
        await request(app)
          .patch('/api/ranking/config')
          .send({ decay: { recencyHalfLifeHours: -5 } })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .patch('/api/ranking/config')
          .send({ weights: { like: 99_999 } })
      ).status,
    ).toBe(400);
    expect((await request(app).patch('/api/ranking/config').send({ bogus: true })).status).toBe(
      400,
    );
    expect(patchRankingConfig).not.toHaveBeenCalled();

    const updated = {
      ...DEFAULT_RANKING_CONFIG,
      weights: { ...DEFAULT_RANKING_CONFIG.weights, like: 1.5 },
    };
    patchRankingConfig.mockResolvedValueOnce(updated);
    const patchRes = await request(app)
      .patch('/api/ranking/config')
      .send({ weights: { like: 1.5 } });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body).toEqual(updated);
    expect(patchRankingConfig).toHaveBeenCalledWith({ weights: { like: 1.5 } });

    resetRankingConfigToDefaults.mockResolvedValueOnce(DEFAULT_RANKING_CONFIG);
    const resetRes = await request(app).post('/api/ranking/config/reset');
    expect(resetRes.status).toBe(200);
    expect(resetRes.body).toEqual(DEFAULT_RANKING_CONFIG);
    expect(resetRankingConfigToDefaults).toHaveBeenCalledOnce();
  });
});
