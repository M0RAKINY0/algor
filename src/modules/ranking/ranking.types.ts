export type CandidateSource = 'in_network' | 'topic_match' | 'social_proof' | 'trending';

export interface PostStatsSnapshot {
  viewCount: number;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  notInterestedCount: number;
  reportCount: number;
}

export interface TimedAffinity {
  score: number;
  updatedAt: Date;
}

export interface UserSignalsContext {
  authorAffinities: ReadonlyMap<string, TimedAffinity>;
  topicAffinities: ReadonlyMap<number, TimedAffinity>;
}

export interface CandidatePost {
  id: string;
  authorId: string;
  createdAt: Date;
  inNetwork: boolean;
  sources: CandidateSource[];
  topicIds: number[];
  stats: PostStatsSnapshot;
  socialProofCount: number;
}

export interface ScoreBreakdown {
  sources: CandidateSource[];
  raw: {
    authorAffinity: number;
    topicAffinity: number;
    engagement: number;
    socialProofCount: number;
    ageHours: number;
  };
  terms: {
    author: number;
    topic: number;
    engagement: number;
    socialProof: number;
    coldStartBias: number;
  };
  multipliers: {
    recency: number;
    network: number;
    authorDiversity: number;
  };
  baseScore: number;
  finalScore: number;
}

export interface ScoredCandidate<T extends CandidatePost = CandidatePost> {
  candidate: T;
  score: number;
  breakdown: ScoreBreakdown;
}
