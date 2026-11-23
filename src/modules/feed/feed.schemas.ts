import { z } from 'zod';
import { HttpError } from '../../lib/http-error.js';

const CANONICAL_BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

const booleanQueryParam = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .optional()
    .transform((val) => {
      if (val === undefined) return defaultValue;
      if (typeof val === 'boolean') return val;
      return val === 'true' || val === '1';
    });

export const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(512).optional(),
  debug: booleanQueryParam(false),
});

/**
 * Opaque continuation token carrying the last served post ID and trailing author-run state
 * so consecutive-author diversity limits carry seamlessly across paginated feed requests
 * (while PostgreSQL `impressions` tracks the full seen set).
 */
export const feedCursorPayloadSchema = z
  .object({
    v: z.literal(1),
    lastPostId: z.uuid().transform((v) => v.toLowerCase()),
    lastAuthorId: z.uuid().transform((v) => v.toLowerCase()),
    lastAuthorRun: z.number().int().min(1).max(50),
  })
  .strict();

export type FeedQuery = z.infer<typeof feedQuerySchema>;
export type FeedCursorPayload = z.infer<typeof feedCursorPayloadSchema>;

export function encodeFeedCursor(payload: FeedCursorPayload): string {
  const validated = feedCursorPayloadSchema.parse(payload);
  return Buffer.from(JSON.stringify(validated), 'utf8').toString('base64url');
}

export function decodeFeedCursor(raw: string): FeedCursorPayload {
  if (!CANONICAL_BASE64URL_RE.test(raw)) {
    throw new HttpError(400, 'Invalid feed cursor');
  }

  const decoded = Buffer.from(raw, 'base64url');
  // Reject noncanonical encodings (trailing bits, padding, or ignored chars).
  if (decoded.toString('base64url') !== raw) {
    throw new HttpError(400, 'Invalid feed cursor');
  }

  try {
    const parsed: unknown = JSON.parse(decoded.toString('utf8'));
    const result = feedCursorPayloadSchema.safeParse(parsed);
    if (!result.success) {
      throw new HttpError(400, 'Invalid feed cursor');
    }
    return result.data;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Invalid feed cursor');
  }
}
