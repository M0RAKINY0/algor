import { z } from 'zod';
import {
  errorResponse,
  jsonContent,
  schemaRef,
  toOpenApiSchema,
  type OpenApiModule,
} from '../../docs/helpers.js';
import {
  handleSchema,
  ingestGraphSchema,
  ingestPostsSchema,
  ingestUsersSchema,
} from './ingest.schemas.js';

const ingestedUserSchema = z.object({
  id: z.uuid(),
  handle: handleSchema,
  displayName: z.string().min(1).max(60),
  bio: z.string().max(160).nullable(),
  createdAt: z.iso.datetime(),
});

const ingestUsersResponseSchema = z.object({
  count: z.number().int().nonnegative(),
  users: z.array(ingestedUserSchema),
});

const ingestedPostSchema = z.object({
  id: z.uuid(),
  authorId: z.uuid(),
  body: z.string().min(1).max(280),
  replyToId: z.uuid().nullable(),
  topics: z.array(z.string()),
  createdAt: z.iso.datetime(),
});

const ingestPostsResponseSchema = z.object({
  count: z.number().int().nonnegative(),
  posts: z.array(ingestedPostSchema),
});

const ingestGraphResponseSchema = z.object({
  applied: z.number().int().nonnegative(),
});

const exampleUserId = '11111111-1111-4111-8111-111111111111';
const exampleTargetUserId = '22222222-2222-4222-8222-222222222222';
const examplePostId = '33333333-3333-4333-8333-333333333333';

export const ingestDocs: OpenApiModule = {
  tags: [
    {
      name: 'Ingest',
      description:
        'Thin intake endpoints to feed users, posts (with hashtag topics), and social graph edges into the recommendation engine',
    },
  ],
  schemas: {
    IngestUsersInput: toOpenApiSchema(ingestUsersSchema),
    IngestUsersResponse: toOpenApiSchema(ingestUsersResponseSchema),
    IngestPostsInput: toOpenApiSchema(ingestPostsSchema),
    IngestPostsResponse: toOpenApiSchema(ingestPostsResponseSchema),
    IngestGraphInput: toOpenApiSchema(ingestGraphSchema),
    IngestGraphResponse: toOpenApiSchema(ingestGraphResponseSchema),
  },
  paths: {
    '/api/ingest/users': {
      post: {
        tags: ['Ingest'],
        summary: 'Upsert users',
        description:
          'Batch-upserts users by case-insensitive handle. Optional `id` can be supplied for deterministic seeding.',
        operationId: 'ingestUsers',
        requestBody: {
          required: true,
          content: jsonContent(schemaRef('IngestUsersInput'), {
            users: [{ handle: 'alice', displayName: 'Alice', bio: 'ML & feeds' }],
          }),
        },
        responses: {
          '200': {
            description: 'Users upserted',
            content: jsonContent(schemaRef('IngestUsersResponse'), {
              count: 1,
              users: [
                {
                  id: exampleUserId,
                  handle: 'alice',
                  displayName: 'Alice',
                  bio: 'ML & feeds',
                  createdAt: '2026-11-21T16:00:00.000Z',
                },
              ],
            }),
          },
          '400': errorResponse('Validation failed', 'ValidationErrorResponse'),
          '409': errorResponse('User id conflicts with an existing user'),
        },
      },
    },
    '/api/ingest/posts': {
      post: {
        tags: ['Ingest'],
        summary: 'Ingest posts and extract topics',
        description:
          'Batch-inserts posts (idempotent when `id` is supplied), extracts lowercase `#hashtag` topics from `body`, and merges any explicit `topics`. Accepts optional `createdAt` for recency-decay testing.',
        operationId: 'ingestPosts',
        requestBody: {
          required: true,
          content: jsonContent(schemaRef('IngestPostsInput'), {
            posts: [
              {
                authorId: exampleUserId,
                body: 'Tuning ranking weights with #TypeScript and #Postgres',
                topics: ['ranking'],
              },
            ],
          }),
        },
        responses: {
          '201': {
            description: 'Posts ingested',
            content: jsonContent(schemaRef('IngestPostsResponse'), {
              count: 1,
              posts: [
                {
                  id: examplePostId,
                  authorId: exampleUserId,
                  body: 'Tuning ranking weights with #TypeScript and #Postgres',
                  replyToId: null,
                  topics: ['postgres', 'ranking', 'typescript'],
                  createdAt: '2026-11-21T16:00:00.000Z',
                },
              ],
            }),
          },
          '400': errorResponse(
            'Validation failed or referenced authorId/replyToId does not exist',
            'ValidationErrorResponse',
          ),
        },
      },
    },
    '/api/ingest/graph': {
      post: {
        tags: ['Ingest'],
        summary: 'Apply social graph edges',
        description:
          'Idempotently applies follow, unfollow, block, unblock, mute, or unmute edges between users in order.',
        operationId: 'ingestGraph',
        requestBody: {
          required: true,
          content: jsonContent(schemaRef('IngestGraphInput'), {
            edges: [
              {
                action: 'follow',
                sourceUserId: exampleUserId,
                targetUserId: exampleTargetUserId,
              },
            ],
          }),
        },
        responses: {
          '200': {
            description: 'Graph edges applied',
            content: jsonContent(schemaRef('IngestGraphResponse'), { applied: 1 }),
          },
          '400': errorResponse(
            'Validation failed or referenced user does not exist',
            'ValidationErrorResponse',
          ),
        },
      },
    },
  },
};
