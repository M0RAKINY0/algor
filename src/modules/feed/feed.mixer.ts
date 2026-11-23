import { DEFAULT_RANKING_CONFIG, type RankingConfig } from '../../config/ranking.js';
import type { CandidatePost, ScoredCandidate } from '../ranking/ranking.types.js';

export interface AuthorRunState {
  authorId: string | null;
  count: number;
}

/**
 * Greedily assembles the final feed page from already-ranked candidates while enforcing:
 * 1. Target `inNetworkRatio` (in-network vs. out-of-network balance), falling back when one pool runs dry.
 * 2. `maxConsecutivePerAuthor` cap (optionally seeded with the trailing author run from a prior page),
 *    falling back directly to the highest-scoring remaining candidate only when every remaining candidate
 *    would violate the cap.
 */
export function assembleFeed<T extends CandidatePost>(
  ranked: ReadonlyArray<ScoredCandidate<T>>,
  limit: number,
  config: RankingConfig = DEFAULT_RANKING_CONFIG,
  initialRun?: AuthorRunState,
): ScoredCandidate<T>[] {
  if (limit <= 0 || ranked.length === 0) return [];

  const { maxConsecutivePerAuthor, inNetworkRatio } = config.diversity;
  const remaining = [...ranked];
  const selected: ScoredCandidate<T>[] = [];

  let inNetworkSelected = 0;
  let lastAuthorId: string | null = initialRun?.authorId ?? null;
  let consecutiveCount = initialRun?.authorId ? Math.max(0, initialRun.count) : 0;

  const canPlaceAuthor = (authorId: string): boolean =>
    authorId !== lastAuthorId || consecutiveCount < maxConsecutivePerAuthor;

  while (selected.length < limit && remaining.length > 0) {
    const targetInNetwork = Math.round((selected.length + 1) * inNetworkRatio);
    const preferInNetwork = inNetworkSelected < targetInNetwork;

    // 1. Preferred network pool + respects author cap
    let pickIndex = remaining.findIndex(
      (item) =>
        item.candidate.inNetwork === preferInNetwork && canPlaceAuthor(item.candidate.authorId),
    );

    // 2. Alternate network pool + respects author cap
    if (pickIndex === -1) {
      pickIndex = remaining.findIndex((item) => canPlaceAuthor(item.candidate.authorId));
    }

    // 3. Highest-scoring remaining candidate overall if every remaining candidate violates the cap
    if (pickIndex === -1) {
      pickIndex = 0;
    }

    const [picked] = remaining.splice(pickIndex, 1);
    if (!picked) break;

    selected.push(picked);
    if (picked.candidate.inNetwork) inNetworkSelected += 1;

    if (picked.candidate.authorId === lastAuthorId) {
      consecutiveCount += 1;
    } else {
      lastAuthorId = picked.candidate.authorId;
      consecutiveCount = 1;
    }
  }

  return selected;
}
