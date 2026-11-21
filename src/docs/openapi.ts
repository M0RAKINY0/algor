import { z } from 'zod';
import { ingestDocs } from '../modules/ingest/ingest.docs.js';
import {
  jsonContent,
  schemaRef,
  toOpenApiSchema,
  type JsonSchema,
  type OpenApiModule,
  type OpenApiPathItem,
  type OpenApiTag,
} from './helpers.js';

const healthResponseSchema = z.object({
  status: z.literal('ok'),
});

const errorResponseSchema = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});

const validationIssueSchema = z.object({
  code: z.string(),
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
});

const validationErrorResponseSchema = z.object({
  error: z.literal('Validation failed'),
  details: z.array(validationIssueSchema),
});

const coreDocs: OpenApiModule = {
  tags: [{ name: 'Health', description: 'Service liveness check' }],
  schemas: {
    HealthResponse: toOpenApiSchema(healthResponseSchema),
    ErrorResponse: toOpenApiSchema(errorResponseSchema),
    ValidationErrorResponse: toOpenApiSchema(validationErrorResponseSchema),
  },
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        operationId: 'getHealth',
        responses: {
          '200': {
            description: 'Service is healthy',
            content: jsonContent(schemaRef('HealthResponse'), { status: 'ok' }),
          },
        },
      },
    },
  },
};

// Feature docs from src/modules register here alongside their routers in src/app.ts.
const modules: OpenApiModule[] = [coreDocs, ingestDocs];

function buildOpenApiDocument(mods: OpenApiModule[]) {
  const tags: OpenApiTag[] = [];
  const schemas: Record<string, JsonSchema> = {};
  const paths: Record<string, OpenApiPathItem> = {};

  for (const mod of mods) {
    if (mod.tags) tags.push(...mod.tags);
    if (mod.schemas) Object.assign(schemas, mod.schemas);
    Object.assign(paths, mod.paths);
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Algor API',
      version: '0.1.0',
      description: 'Recommendation feed API that learns from user behavior.',
    },
    servers: [{ url: '/', description: 'Current server' }],
    tags,
    components: {
      securitySchemes: {
        UserIdHeader: {
          type: 'apiKey',
          in: 'header',
          name: 'x-user-id',
          description:
            'Dev-only user identity header containing the caller UUID. Replaced by JWT auth later.',
        },
      },
      schemas,
    },
    paths,
  };
}

export const openApiDocument = buildOpenApiDocument(modules);
