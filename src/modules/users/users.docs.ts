import { z } from 'zod';
import {
  errorResponse,
  jsonContent,
  schemaRef,
  toOpenApiSchema,
  type OpenApiModule,
} from '../../docs/helpers.js';
import { createUserSchema, handleSchema, updateUserSchema } from './users.schemas.js';

const userProfileSchema = z.object({
  id: z.uuid(),
  handle: handleSchema,
  displayName: z.string().min(1).max(60),
  bio: z.string().max(160).nullable(),
  createdAt: z.iso.datetime(),
  followerCount: z.number().int().nonnegative(),
  followingCount: z.number().int().nonnegative(),
});

const exampleProfile = {
  id: '11111111-1111-4111-8111-111111111111',
  handle: 'alice',
  displayName: 'Alice',
  bio: 'Building recommendation feeds',
  createdAt: '2026-11-21T12:00:00.000Z',
  followerCount: 12,
  followingCount: 5,
};

export const usersDocs: OpenApiModule = {
  tags: [{ name: 'Users', description: 'User profiles and dev identity lookup' }],
  schemas: {
    CreateUserInput: toOpenApiSchema(createUserSchema),
    UpdateUserInput: toOpenApiSchema(updateUserSchema),
    UserProfile: toOpenApiSchema(userProfileSchema),
  },
  paths: {
    '/api/users': {
      post: {
        tags: ['Users'],
        summary: 'Create a user',
        description: 'Creates a new user profile. Handles are unique case-insensitively.',
        operationId: 'createUser',
        requestBody: {
          required: true,
          content: jsonContent(schemaRef('CreateUserInput'), {
            handle: 'alice',
            displayName: 'Alice',
            bio: 'Building recommendation feeds',
          }),
        },
        responses: {
          '201': {
            description: 'User created',
            content: jsonContent(schemaRef('UserProfile'), exampleProfile),
          },
          '400': errorResponse('Validation failed', 'ValidationErrorResponse'),
          '409': errorResponse('Handle is already taken'),
        },
      },
    },
    '/api/users/me': {
      get: {
        tags: ['Users'],
        summary: 'Get current user profile',
        description: 'Returns the profile for the user identified by the `x-user-id` header.',
        operationId: 'getCurrentUser',
        security: [{ UserIdHeader: [] }],
        responses: {
          '200': {
            description: 'Current user profile',
            content: jsonContent(schemaRef('UserProfile'), exampleProfile),
          },
          '401': errorResponse('Missing, malformed, or unknown x-user-id header'),
        },
      },
      patch: {
        tags: ['Users'],
        summary: 'Update current user profile',
        description:
          'Updates `displayName` and/or `bio` for the current user. At least one field must be provided.',
        operationId: 'updateCurrentUser',
        security: [{ UserIdHeader: [] }],
        requestBody: {
          required: true,
          content: jsonContent(schemaRef('UpdateUserInput'), {
            displayName: 'Alice M.',
            bio: 'Still building feeds',
          }),
        },
        responses: {
          '200': {
            description: 'Updated user profile',
            content: jsonContent(schemaRef('UserProfile'), exampleProfile),
          },
          '400': errorResponse('Validation failed', 'ValidationErrorResponse'),
          '401': errorResponse('Missing, malformed, or unknown x-user-id header'),
        },
      },
    },
    '/api/users/{handle}': {
      get: {
        tags: ['Users'],
        summary: 'Get user profile by handle',
        description: 'Looks up a user profile by handle (case-insensitive).',
        operationId: 'getUserByHandle',
        parameters: [
          {
            name: 'handle',
            in: 'path',
            required: true,
            description: '1-30 letters, numbers, or underscores',
            schema: toOpenApiSchema(handleSchema),
            example: 'alice',
          },
        ],
        responses: {
          '200': {
            description: 'User profile',
            content: jsonContent(schemaRef('UserProfile'), exampleProfile),
          },
          '400': errorResponse('Invalid handle format', 'ValidationErrorResponse'),
          '404': errorResponse('User not found'),
        },
      },
    },
  },
};
