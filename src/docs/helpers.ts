import { z } from 'zod';

export type JsonSchema = Record<string, unknown>;

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema: JsonSchema;
  example?: unknown;
}

export interface OpenApiMediaType {
  schema: JsonSchema;
  example?: unknown;
}

export interface OpenApiRequestBody {
  required?: boolean;
  description?: string;
  content: Record<string, OpenApiMediaType>;
}

export interface OpenApiResponse {
  description: string;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiOperation {
  tags?: string[];
  summary: string;
  description?: string;
  operationId?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses: Record<string, OpenApiResponse>;
}

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type OpenApiPathItem = Partial<Record<HttpMethod, OpenApiOperation>>;

export interface OpenApiTag {
  name: string;
  description?: string;
}

export interface OpenApiModule {
  tags?: OpenApiTag[];
  schemas?: Record<string, JsonSchema>;
  paths: Record<string, OpenApiPathItem>;
}

// Convert any Zod schema into an OpenAPI 3.0 compatible JSON Schema object.
export function toOpenApiSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { target: 'openapi-3.0' }) as JsonSchema;
}

export function schemaRef(name: string): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}

export function jsonContent(
  schema: JsonSchema,
  example?: unknown,
): Record<string, OpenApiMediaType> {
  return {
    'application/json': example === undefined ? { schema } : { schema, example },
  };
}

export function errorResponse(description: string, schemaName = 'ErrorResponse'): OpenApiResponse {
  return {
    description,
    content: jsonContent(schemaRef(schemaName)),
  };
}
