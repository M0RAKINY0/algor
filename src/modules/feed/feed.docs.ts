import { z } from 'zod';
import {
  errorResponse,
  jsonContent,
  schemaRef,
  toOpenApiSchema,
  type OpenApiModule,
} from '../../docs/helpers.js';

const scoreBreakdownSchema = z.object({
  sources: z.array(z.enum(['in_network', 'topic_match', 'social_proof', 'trending'])),
  raw: z.object({
    authorAffinity: z.number(),
    topicAffinity: z.number(),
    engagement: z.number(),
    socialProofCount: z.number().int().nonnegative(),
    ageHours: z.number().nonnegative(),
  }),
  terms: z.object({
    author: z.number(),
    topic: z.number(),
    engagement: z.number(),
    socialProof: z.number(),
    coldStartBias: z.number(),
  }),
  multipliers: z.object({
    recency: z.number(),
    network: z.number(),
    authorDiversity: z.number(),
  }),
  baseScore: z.number(),
  finalScore: z.number(),
});

const feedItemSchema = z.object({
  id: z.uuid(),
  author: z.object({
    id: z.uuid(),
    handle: z.string(),
    displayName: z.string(),
  }),
  body: z.string(),
  replyToId: z.uuid().nullable(),
  topics: z.array(z.string()),
  createdAt: z.iso.datetime(),
  inNetwork: z.boolean(),
  stats: z.object({
    viewCount: z.number().int().nonnegative(),
    likeCount: z.number().int().nonnegative(),
    replyCount: z.number().int().nonnegative(),
    repostCount: z.number().int().nonnegative(),
  }),
  score: z.number(),
  position: z.number().int().nonnegative(),
  debug: scoreBreakdownSchema.optional(),
});

const feedResponseSchema = z.object({
  items: z.array(feedItemSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  meta: z.object({
    candidateCount: z.number().int().nonnegative(),
    returnedCount: z.number().int().nonnegative(),
    inNetworkCount: z.number().int().nonnegative(),
    outOfNetworkCount: z.number().int().nonnegative(),
  }),
});

const exampleAuthorId = '22222222-2222-4222-8222-222222222222';
const examplePostId = '33333333-3333-4333-8333-333333333333';

export const feedDocs: OpenApiModule = {
  tags: [
    {
      name: 'Feed',
      description: 'Ranked, filtered, diversified recommendation feed with impression tracking',
    },
  ],
  schemas: {
    ScoreBreakdown: toOpenApiSchema(scoreBreakdownSchema),
    FeedItem: toOpenApiSchema(feedItemSchema),
    FeedResponse: toOpenApiSchema(feedResponseSchema),
  },
  paths: {
    '/api/feed': {
      get: {
        tags: ['Feed'],
        summary: 'Fetch personalized ranked feed',
        description:
          'Runs 4-source candidate retrieval (in-network, topic match, social proof, trending), excludes blocked/muted/seen/hidden/own posts, ranks with active weights and author diversity, mixes in-network vs. out-of-network, and atomically logs impressions per viewer. `debug.sources` indicates which capped retrieval queues surfaced the post, while `debug.raw.socialProofCount` reflects all eligible followed users who liked or reposted it. Returns `Cache-Control: private, no-store`.',
        operationId: 'getFeed',
        security: [{ UserIdHeader: [] }],
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Maximum items to return (1-50, default 20)',
            schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            example: 20,
          },
          {
            name: 'cursor',
            in: 'query',
            required: false,
            description:
              'Opaque canonical base64url continuation token from `nextCursor` (carries trailing author-run state across pages while `impressions` tracks the seen set)',
            schema: { type: 'string', minLength: 1, maxLength: 512 },
          },
          {
            name: 'debug',
            in: 'query',
            required: false,
            description:
              'Include full per-item score breakdown when true (accepts `true`, `false`, `1`, `0`)',
            schema: {
              type: 'string',
              enum: ['true', 'false', '1', '0'],
              default: 'false',
            },
            example: 'true',
          },
        ],
        responses: {
          '200': {
            description: 'Ranked, diversified feed page',
            content: jsonContent(schemaRef('FeedResponse'), {
              items: [
                {
                  id: examplePostId,
                  author: { id: exampleAuthorId, handle: 'bob', displayName: 'Bob' },
                  body: 'Benchmarking PostgreSQL ranking queries with #postgres and #typescript',
                  replyToId: null,
                  topics: ['postgres', 'typescript'],
                  createdAt: '2026-11-23T11:30:00.000Z',
                  inNetwork: true,
                  stats: { viewCount: 25, likeCount: 8, replyCount: 2, repostCount: 3 },
                  score: 6.42,
                  position: 0,
                },
              ],
              nextCursor: null,
              hasMore: false,
              meta: {
                candidateCount: 1,
                returnedCount: 1,
                inNetworkCount: 1,
                outOfNetworkCount: 0,
              },
            }),
          },
          '400': errorResponse('Validation failed or invalid feed cursor', 'ErrorResponse'),
          '401': errorResponse('Missing or invalid x-user-id / x-internal-key header'),
          '500': errorResponse('Internal server error'),
          '503': errorResponse('Internal API key is not configured for x-user-id trust boundary'),
        },
      },
    },
  },
};
