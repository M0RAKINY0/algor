import { z } from 'zod';

export const handleSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]{1,30}$/, 'Handle must be 1-30 letters, numbers or underscores');

export const topicSchema = z
  .string()
  .trim()
  .regex(/^#?[A-Za-z0-9_]{1,50}$/, 'Topic must be 1-50 letters, numbers or underscores')
  .refine((v) => /[A-Za-z0-9]/.test(v), {
    message: 'Topic must contain at least one letter or number',
  });

export const ingestUserItemSchema = z.object({
  id: z.uuid().optional(),
  handle: handleSchema,
  displayName: z.string().trim().min(1).max(60),
  bio: z.string().trim().max(160).nullable().optional(),
});

export const ingestUsersSchema = z.object({
  users: z.array(ingestUserItemSchema).min(1).max(500),
});

export const ingestPostItemSchema = z.object({
  id: z.uuid().optional(),
  authorId: z.uuid(),
  body: z.string().trim().min(1, 'Post body cannot be empty').max(280, 'Post body max 280 chars'),
  replyToId: z.uuid().nullable().optional(),
  topics: z.array(topicSchema).max(20).optional(),
  createdAt: z.iso.datetime().optional(),
});

export const ingestPostsSchema = z.object({
  posts: z.array(ingestPostItemSchema).min(1).max(500),
});

export const graphActionSchema = z.enum([
  'follow',
  'unfollow',
  'block',
  'unblock',
  'mute',
  'unmute',
]);

export const graphEdgeSchema = z
  .object({
    action: graphActionSchema,
    sourceUserId: z.uuid(),
    targetUserId: z.uuid(),
  })
  .refine((e) => e.sourceUserId !== e.targetUserId, {
    message: 'sourceUserId and targetUserId must differ',
  });

export const ingestGraphSchema = z.object({
  edges: z.array(graphEdgeSchema).min(1).max(1000),
});

export type IngestUsersInput = z.infer<typeof ingestUsersSchema>;
export type IngestPostsInput = z.infer<typeof ingestPostsSchema>;
export type GraphEdgeInput = z.infer<typeof graphEdgeSchema>;
export type IngestGraphInput = z.infer<typeof ingestGraphSchema>;
