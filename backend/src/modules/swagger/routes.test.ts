import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import { errorHandler } from '../../middleware/error-handler.js';

describe('swagger documentation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyJwt, { secret: 'test-secret-key-for-testing-only' });
    app.setErrorHandler(errorHandler);

    await app.register(fastifySwagger, {
      openapi: {
        info: {
          title: 'K8s Hosting Platform API',
          description: 'Management API for the Kubernetes web hosting platform',
          version: '0.1.0',
        },
        servers: [
          { url: 'http://localhost:3000', description: 'Development' },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT',
            },
          },
        },
      },
    });

    await app.register(fastifySwaggerUi, {
      routePrefix: '/api/docs',
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
      },
    });

    // Register a sample route with schema to validate OpenAPI generation
    app.get('/api/v1/admin/status', {
      schema: {
        tags: ['Admin'],
        summary: 'Health check / system status',
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'object',
                properties: {
                  status: { type: 'string' },
                  timestamp: { type: 'string' },
                  version: { type: 'string' },
                },
              },
            },
          },
        },
      },
    }, async () => ({
      data: { status: 'healthy', timestamp: new Date().toISOString(), version: '0.1.0' },
    }));

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/docs should return Swagger UI HTML', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/docs',
    });

    // Swagger UI redirects to /api/docs/ or returns 200 with HTML
    expect([200, 302]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      expect(res.headers['content-type']).toContain('text/html');
    }
  });

  it('GET /api/docs/json should return valid OpenAPI JSON', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/docs/json',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.openapi).toBeDefined();
    expect(body.openapi).toMatch(/^3\./);
    expect(body.info).toBeDefined();
    expect(body.paths).toBeDefined();
  });

  it('OpenAPI JSON should have correct title and version', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/docs/json',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.info.title).toBe('K8s Hosting Platform API');
    expect(body.info.version).toBe('0.1.0');
    expect(body.info.description).toBe(
      'Management API for the Kubernetes web hosting platform',
    );
  });

  it('OpenAPI JSON should include security schemes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/docs/json',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.components?.securitySchemes?.bearerAuth).toBeDefined();
    expect(body.components.securitySchemes.bearerAuth.type).toBe('http');
    expect(body.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
  });

  it('OpenAPI JSON should include registered route paths', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/docs/json',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.paths['/api/v1/admin/status']).toBeDefined();
    expect(body.paths['/api/v1/admin/status'].get).toBeDefined();
    expect(body.paths['/api/v1/admin/status'].get.tags).toContain('Admin');
  });
});
