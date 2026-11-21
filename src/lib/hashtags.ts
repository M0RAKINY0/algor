const HASHTAG_RE = /(?:^|[^\w/])#([A-Za-z0-9_]+)/g;
const MAX_TOPIC_LENGTH = 50;

export function normalizeTopic(raw: string): string {
  return raw.trim().replace(/^#/, '').toLowerCase();
}

// Pull unique, lowercase topic names out of hashtags in a post body.
// Skips URL fragments (foo/#bar), mid-word hashes (foo#bar), underscores-only (#___),
// and tags longer than the 50-char topics.name column.
export function extractHashtags(body: string): string[] {
  const seen = new Set<string>();

  for (const match of body.matchAll(HASHTAG_RE)) {
    const raw = match[1];
    if (!raw || raw.length > MAX_TOPIC_LENGTH) continue;

    const normalized = raw.toLowerCase();
    if (!/[a-z0-9]/.test(normalized)) continue;

    seen.add(normalized);
  }

  return [...seen];
}
