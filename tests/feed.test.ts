import { describe, expect, it } from 'vitest';
import { DEFAULT_RANKING_CONFIG, type RankingConfig } from '../src/config/ranking.js';
import { assembleFeed } from '../src/modules/feed/feed.mixer.js';
import {
  decodeFeedCursor,
  encodeFeedCursor,
  feedQuerySchema,
} from '../src/modules/feed/feed.schemas.js';
import type { CandidatePost, ScoredCandidate } from '../src/modules/ranking/ranking.types.js';

const NOW = new Date('2026-11-23T12:00:00.000Z');
const AUTHOR_A = '11111111-1111-4111-8111-111111111111';
const POST_A = '33333333-3333-4333-8333-333333333333';

function makeScored(
  id: string,
  authorId: string,
  score: number,
  inNetwork: boolean,
): ScoredCandidate<CandidatePost> {
  return {
    candidate: {
      id,
      authorId,
      createdAt: NOW,
      inNetwork,
      sources: [inNetwork ? 'in_network' : 'trending'],
      topicIds: [],
      stats: {
        viewCount: 0,
        likeCount: 0,
        replyCount: 0,
        repostCount: 0,
        notInterestedCount: 0,
        reportCount: 0,
      },
      socialProofCount: 0,
    },
    score,
    breakdown: {
      sources: [inNetwork ? 'in_network' : 'trending'],
      raw: { authorAffinity: 0, topicAffinity: 0, engagement: 0, socialProofCount: 0, ageHours: 0 },
      terms: { author: 0, topic: 0, engagement: 0, socialProof: 0, coldStartBias: score },
      multipliers: { recency: 1, network: 1, authorDiversity: 1 },
      baseScore: score,
      finalScore: score,
    },
  };
}

describe('feed query & cursor schemas', () => {
  it('parses debug booleans strictly without coercing "false" to true', () => {
    expect(feedQuerySchema.parse({})).toEqual({ limit: 20, debug: false });
    expect(feedQuerySchema.parse({ limit: '10', debug: 'false' })).toEqual({
      limit: 10,
      debug: false,
    });
    expect(feedQuerySchema.parse({ debug: '0' }).debug).toBe(false);
    expect(feedQuerySchema.parse({ debug: 'true' }).debug).toBe(true);
    expect(feedQuerySchema.parse({ debug: '1' }).debug).toBe(true);
    expect(() => feedQuerySchema.parse({ debug: 'yes' })).toThrow();
    expect(() => feedQuerySchema.parse({ limit: '0' })).toThrow();
    expect(() => feedQuerySchema.parse({ limit: '51' })).toThrow();
  });

  it('round-trips canonical base64url cursors and rejects noncanonical or malformed cursors', () => {
    const payload = {
      v: 1 as const,
      lastPostId: POST_A,
      lastAuthorId: AUTHOR_A,
      lastAuthorRun: 2,
    };
    const token = encodeFeedCursor(payload);
    expect(decodeFeedCursor(token)).toEqual(payload);

    // Reject malformed, padded, or noncanonical encodings
    expect(() => decodeFeedCursor('not-valid-json')).toThrow(/Invalid feed cursor/);
    expect(() => decodeFeedCursor(`${token}=`)).toThrow(/Invalid feed cursor/);
    expect(() => decodeFeedCursor(`${token} `)).toThrow(/Invalid feed cursor/);
    const badSchema = Buffer.from(JSON.stringify({ v: 2, lastPostId: 'bad' })).toString(
      'base64url',
    );
    expect(() => decodeFeedCursor(badSchema)).toThrow(/Invalid feed cursor/);
  });
});

describe('assembleFeed diversity mixer', () => {
  it('enforces maxConsecutivePerAuthor within a page and across pages via initialRun', () => {
    const cfg: RankingConfig = {
      ...structuredClone(DEFAULT_RANKING_CONFIG),
      diversity: {
        ...DEFAULT_RANKING_CONFIG.diversity,
        maxConsecutivePerAuthor: 1,
        inNetworkRatio: 1.0,
      },
    };

    const ranked = [
      makeScored('a1', 'alice', 10, true),
      makeScored('a2', 'alice', 9, true),
      makeScored('a3', 'alice', 8, true),
      makeScored('b1', 'bob', 7, true),
      makeScored('c1', 'carol', 6, true),
    ];

    const page = assembleFeed(ranked, 5, cfg);
    expect(page.map((p) => p.candidate.id)).toEqual(['a1', 'b1', 'a2', 'c1', 'a3']);

    // Starting a new page immediately after `alice` with cap=1 should lead with `bob` first
    const nextPage = assembleFeed(
      [makeScored('a4', 'alice', 10, true), makeScored('b2', 'bob', 6, true)],
      2,
      cfg,
      { authorId: 'alice', count: 1 },
    );
    expect(nextPage.map((p) => p.candidate.id)).toEqual(['b2', 'a4']);
  });

  it('balances in-network and out-of-network pools and falls back to highest score when all violate author cap', () => {
    const cfg: RankingConfig = {
      ...structuredClone(DEFAULT_RANKING_CONFIG),
      diversity: {
        ...DEFAULT_RANKING_CONFIG.diversity,
        maxConsecutivePerAuthor: 1,
        inNetworkRatio: 0.5,
      },
    };

    const ranked = [
      makeScored('in-1', 'a1', 10, true),
      makeScored('in-2', 'a2', 9, true),
      makeScored('in-3', 'a3', 8, true),
      makeScored('out-1', 'b1', 7, false),
      makeScored('out-2', 'b2', 6, false),
      makeScored('out-3', 'b3', 5, false),
    ];

    const page = assembleFeed(ranked, 6, cfg);
    expect(page.filter((p) => p.candidate.inNetwork)).toHaveLength(3);
    expect(page.filter((p) => !p.candidate.inNetwork)).toHaveLength(3);

    // When all remaining candidates are by the same author (all violate maxConsecutivePerAuthor=1),
    // fallback must pick the highest-scoring post overall even if its network flag differs from preferred pool.
    const allViolating = [
      makeScored('solo-hi', 'solo', 9, false),
      makeScored('solo-lo', 'solo', 4, true),
    ];
    const fallback = assembleFeed(allViolating, 2, cfg, { authorId: 'solo', count: 1 });
    expect(fallback.map((p) => p.candidate.id)).toEqual(['solo-hi', 'solo-lo']);
  });
});
