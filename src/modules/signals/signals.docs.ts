import { z } from 'zod';
import {
  errorResponse,
  jsonContent,
  schemaRef,
  toOpenApiSchema,
  type OpenApiModule,
} from '../../docs/helpers.js';
import { interactionTypeSchema, recordEventSchema } from './signals.schemas.js';

const recordEventResponseSchema = z.object({
  recorded: z.boolean(),
  duplicate: z.boolean(),
  eventId: z.number().int().nullable(),
  postId: z.uuid(),
  type: interactionTypeSchema,
  weight: z.number(),
  createdAt: z.iso.datetime().nullable(),
});

const decayedAuthorSignalSchema = z.object({
  authorId: z.uuid(),
  handle: z.string(),
  displayName: z.string(),
  rawScore: z.number(),
  decayedScore: z.number(),
  updatedAt: z.iso.datetime(),
});

const decayedTopicSignalSchema = z.object({
  topicId: z.number().int(),
  name: z.string(),
  rawScore: z.number(),
  decayedScore: z.number(),
  updatedAt: z.iso.datetime(),
});

const userSignalsResponseSchema = z.object({
  userId: z.uuid(),
  evaluatedAt: z.iso.datetime(),
  authors: z.array(decayedAuthorSignalSchema),
  topics: z.array(decayedTopicSignalSchema),
});

const exampleUserId = '11111111-1111-4111-8111-111111111111';
const exampleAuthorId = '22222222-2222-4222-8222-222222222222';
const examplePostId = '33333333-3333-4333-8333-333333333333';

export const signalsDocs: OpenApiModule = {
  tags: [
    {
      name: 'Signals',
      description: 'Record user interactions and inspect time-decayed author & topic affinities',
    },
  ],
  schemas: {
    RecordEventInput: toOpenApiSchema(recordEventSchema),
    RecordEventResponse: toOpenApiSchema(recordEventResponseSchema),
    UserSignalsResponse: toOpenApiSchema(userSignalsResponseSchema),
  },
  paths: {
    '/api/events': {
      post: {
        tags: ['Signals'],
        summary: 'Record an interaction event',
        description:
          'Logs an interaction (`view`, `like`, `reply`, `repost`, `profile_click`, `not_interested`, `report`), updates `post_stats`, and updates time-decayed author & topic affinities. One-shot interactions (`like`, `repost`, `not_interested`, `report`) are idempotent per `(user, post, type)` and return `200` with `duplicate: true` on repeats.',
        operationId: 'recordEvent',
        security: [{ UserIdHeader: [] }],
        requestBody: {
          required: true,
          content: jsonContent(schemaRef('RecordEventInput'), {
            postId: examplePostId,
            type: 'like',
          }),
        },
        responses: {
          '201': {
            description: 'Event recorded and signals updated',
            content: jsonContent(schemaRef('RecordEventResponse'), {
              recorded: true,
              duplicate: false,
              eventId: 1,
              postId: examplePostId,
              type: 'like',
              weight: 0.5,
              createdAt: '2026-11-23T12:00:00.000Z',
            }),
          },
          '200': {
            description: 'Duplicate one-shot interaction ignored idempotently',
            content: jsonContent(schemaRef('RecordEventResponse'), {
              recorded: false,
              duplicate: true,
              eventId: null,
              postId: examplePostId,
              type: 'like',
              weight: 0.5,
              createdAt: null,
            }),
          },
          '400': errorResponse('Validation failed or future createdAt rejected'),
          '401': errorResponse('Missing or invalid x-user-id / x-internal-key header'),
          '404': errorResponse('Post not found'),
          '500': errorResponse('Internal server error'),
          '503': errorResponse('Internal API key is not configured for x-user-id trust boundary'),
        },
      },
    },
    '/api/signals': {
      get: {
        tags: ['Signals'],
        summary: 'Inspect decayed author and topic affinities',
        description:
          'Returns the caller’s top time-decayed author and topic affinities computed using the active ranking decay half-lives.',
        operationId: 'getUserSignals',
        security: [{ UserIdHeader: [] }],
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Maximum number of authors and topics to return (1-100, default 20)',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            example: 20,
          },
        ],
        responses: {
          '200': {
            description: 'Caller’s decayed affinity profile',
            content: jsonContent(schemaRef('UserSignalsResponse'), {
              userId: exampleUserId,
              evaluatedAt: '2026-11-23T12:00:00.000Z',
              authors: [
                {
                  authorId: exampleAuthorId,
                  handle: 'bob',
                  displayName: 'Bob',
                  rawScore: 14.0,
                  decayedScore: 13.8,
                  updatedAt: '2026-11-23T11:00:00.000Z',
                },
              ],
              topics: [
                {
                  topicId: 1,
                  name: 'typescript',
                  rawScore: 14.0,
                  decayedScore: 13.9,
                  updatedAt: '2026-11-23T11:00:00.000Z',
                },
              ],
            }),
          },
          '400': errorResponse('Validation failed', 'ValidationErrorResponse'),
          '401': errorResponse('Missing or invalid x-user-id / x-internal-key header'),
          '500': errorResponse('Internal server error'),
          '503': errorResponse('Internal API key is not configured for x-user-id trust boundary'),
        },
      },
    },
  },
};
