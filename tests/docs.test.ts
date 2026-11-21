import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

describe('docs routes', () => {
  it('serves the OpenAPI spec at /openapi.json and Swagger UI at /docs', async () => {
    const app = createApp();

    const spec = await request(app).get('/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toBe('3.0.3');
    expect(spec.body.info.title).toBe('Algor API');
    expect(spec.body.components.securitySchemes.UserIdHeader).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'x-user-id',
    });
    expect(Object.keys(spec.body.paths)).toEqual(
      expect.arrayContaining([
        '/health',
        '/api/ingest/users',
        '/api/ingest/posts',
        '/api/ingest/graph',
      ]),
    );
    expect(Object.keys(spec.body.components.schemas)).toEqual(
      expect.arrayContaining([
        'HealthResponse',
        'ErrorResponse',
        'ValidationErrorResponse',
        'IngestUsersInput',
        'IngestUsersResponse',
        'IngestPostsInput',
        'IngestPostsResponse',
        'IngestGraphInput',
        'IngestGraphResponse',
      ]),
    );

    const ui = await request(app).get('/docs').redirects(1);
    expect(ui.status).toBe(200);
    expect(ui.headers['content-type']).toMatch(/text\/html/);
    expect(ui.text).toContain('id="swagger-ui"');
    expect(ui.text).toContain('Algor API Docs');

    const initScript = await request(app).get('/docs/swagger-ui-init.js');
    expect(initScript.status).toBe(200);
    expect(initScript.text).toContain('Algor API');
  });
});
