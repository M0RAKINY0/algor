import { z } from 'zod';

export const interactionTypeSchema = z.enum([
  'view',
  'like',
  'reply',
  'repost',
  'profile_click',
  'not_interested',
  'report',
]);

// Allow up to 60s of forward clock skew; reject far-future timestamps that would freeze decay.
export const MAX_EVENT_FUTURE_SKEW_MS = 60_000;

export const recordEventSchema = z
  .object({
    postId: z.uuid(),
    type: interactionTypeSchema,
    createdAt: z.iso.datetime().optional(),
  })
  .strict();

export const getSignalsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type InteractionType = z.infer<typeof interactionTypeSchema>;
export type RecordEventInput = z.infer<typeof recordEventSchema>;
export type GetSignalsQuery = z.infer<typeof getSignalsQuerySchema>;
