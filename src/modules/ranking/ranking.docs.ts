import {
  DEFAULT_RANKING_CONFIG,
  patchRankingConfigSchema,
  rankingConfigSchema,
} from '../../config/ranking.js';
import {
  errorResponse,
  jsonContent,
  schemaRef,
  toOpenApiSchema,
  type OpenApiModule,
} from '../../docs/helpers.js';

export const rankingDocs: OpenApiModule = {
  tags: [
    {
      name: 'Ranking',
      description: 'Inspect and live-tune engagement weights, decay half-lives, and feed diversity',
    },
  ],
  schemas: {
    RankingConfig: toOpenApiSchema(rankingConfigSchema),
    PatchRankingConfigInput: toOpenApiSchema(patchRankingConfigSchema),
  },
  paths: {
    '/api/ranking/config': {
      get: {
        tags: ['Ranking'],
        summary: 'Get active ranking configuration',
        description:
          'Returns the active persisted interaction weights, decay half-lives, scoring multipliers, and diversity knobs.',
        operationId: 'getRankingConfig',
        responses: {
          '200': {
            description: 'Current ranking configuration',
            content: jsonContent(schemaRef('RankingConfig'), DEFAULT_RANKING_CONFIG),
          },
          '500': errorResponse('Internal server error'),
        },
      },
      patch: {
        tags: ['Ranking'],
        summary: 'Live-update ranking configuration',
        description:
          'Atomically merges partial updates into the persisted ranking configuration inside a PostgreSQL transaction. When any `post_stats` engagement weight changes, recomputes `post_stats.engagement_score` in the same transaction. Requires `x-admin-key` when `ADMIN_API_KEY` is configured (mandatory in production).',
        operationId: 'patchRankingConfig',
        security: [{ AdminKeyHeader: [] }],
        requestBody: {
          required: true,
          content: jsonContent(schemaRef('PatchRankingConfigInput'), {
            weights: { like: 1.0, reply: 15.0 },
            decay: { recencyHalfLifeHours: 12 },
            diversity: { inNetworkRatio: 0.5 },
          }),
        },
        responses: {
          '200': {
            description: 'Updated ranking configuration',
            content: jsonContent(schemaRef('RankingConfig'), DEFAULT_RANKING_CONFIG),
          },
          '400': errorResponse('Validation failed', 'ValidationErrorResponse'),
          '401': errorResponse('Invalid or missing x-admin-key header'),
          '500': errorResponse('Internal server error'),
          '503': errorResponse('Admin API key is not configured'),
        },
      },
    },
    '/api/ranking/config/reset': {
      post: {
        tags: ['Ranking'],
        summary: 'Reset ranking configuration to defaults',
        description:
          'Atomically restores the default X-inspired interaction weights, decay half-lives, scoring multipliers, and diversity knobs, recomputing `post_stats.engagement_score` if any engagement weight changed. Requires `x-admin-key` when `ADMIN_API_KEY` is configured (mandatory in production).',
        operationId: 'resetRankingConfig',
        security: [{ AdminKeyHeader: [] }],
        responses: {
          '200': {
            description: 'Default ranking configuration restored',
            content: jsonContent(schemaRef('RankingConfig'), DEFAULT_RANKING_CONFIG),
          },
          '401': errorResponse('Invalid or missing x-admin-key header'),
          '500': errorResponse('Internal server error'),
          '503': errorResponse('Admin API key is not configured'),
        },
      },
    },
  },
};
