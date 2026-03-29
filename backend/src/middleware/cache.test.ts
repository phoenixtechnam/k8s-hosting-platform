import { describe, it, expect, beforeEach } from 'vitest';
import { createCacheMiddleware, cacheOnSendHook, clearCache, getCacheStore } from './cache.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

function createMockRequest(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return {
    method: 'GET',
    url: '/api/v1/plans',
    ...overrides,
  } as unknown as FastifyRequest;
}

function createMockReply(): FastifyReply & { _statusCode: number; _headers: Record<string, string>; _sent: unknown } {
  const rep = {
    _statusCode: 200,
    _headers: {} as Record<string, string>,
    _sent: null as unknown,
    statusCode: 200,
    status(code: number) {
      rep._statusCode = code;
      rep.statusCode = code;
      return rep;
    },
    header(name: string, value: string) {
      rep._headers[name] = value;
      return rep;
    },
    getHeader(name: string) {
      return rep._headers[name];
    },
    send(body: unknown) {
      rep._sent = body;
      return rep;
    },
  };
  return rep as unknown as FastifyReply & { _statusCode: number; _headers: Record<string, string>; _sent: unknown };
}

describe('createCacheMiddleware', () => {
  beforeEach(() => {
    clearCache();
  });

  it('should set __cacheKey on request for cache miss', async () => {
    const middleware = createCacheMiddleware(60_000);
    const request = createMockRequest();
    const reply = createMockReply();

    await middleware(request, reply as unknown as FastifyReply);

    expect((request as unknown as Record<string, unknown>).__cacheKey).toBe('GET:/api/v1/plans');
    expect(reply._headers['x-cache']).toBe('MISS');
  });

  it('should return cached response on cache hit', async () => {
    const middleware = createCacheMiddleware(60_000);

    // Seed cache directly
    getCacheStore().set('GET:/api/v1/plans', {
      body: { data: [] },
      statusCode: 200,
      expiresAt: Date.now() + 60_000,
    });

    const request = createMockRequest();
    const reply = createMockReply();

    await middleware(request, reply as unknown as FastifyReply);

    expect(reply._headers['x-cache']).toBe('HIT');
    expect(reply._sent).toEqual({ data: [] });
  });

  it('should expire cache entries after TTL', async () => {
    const middleware = createCacheMiddleware(100);

    // Seed expired entry
    getCacheStore().set('GET:/api/v1/plans', {
      body: { data: 'old' },
      statusCode: 200,
      expiresAt: Date.now() - 1,
    });

    const request = createMockRequest();
    const reply = createMockReply();

    await middleware(request, reply as unknown as FastifyReply);

    expect(reply._headers['x-cache']).toBe('MISS');
    expect(getCacheStore().has('GET:/api/v1/plans')).toBe(false);
  });

  it('should skip caching for non-GET requests', async () => {
    const middleware = createCacheMiddleware(60_000);
    const request = createMockRequest({ method: 'POST' } as Partial<FastifyRequest>);
    const reply = createMockReply();

    await middleware(request, reply as unknown as FastifyReply);

    expect((request as unknown as Record<string, unknown>).__cacheKey).toBeUndefined();
    expect(reply._headers['x-cache']).toBeUndefined();
  });
});

describe('cacheOnSendHook', () => {
  beforeEach(() => {
    clearCache();
  });

  it('should cache 200 responses when __cacheKey is set', async () => {
    const request = createMockRequest();
    (request as unknown as Record<string, unknown>).__cacheKey = 'GET:/api/v1/plans';
    (request as unknown as Record<string, unknown>).__cacheTtl = 60_000;

    const reply = createMockReply();
    reply.statusCode = 200;

    const payload = JSON.stringify({ data: [] });
    const result = await cacheOnSendHook(request, reply as unknown as FastifyReply, payload);

    expect(result).toBe(payload);
    expect(getCacheStore().has('GET:/api/v1/plans')).toBe(true);
  });

  it('should not cache non-200 responses', async () => {
    const request = createMockRequest();
    (request as unknown as Record<string, unknown>).__cacheKey = 'GET:/api/v1/plans';
    (request as unknown as Record<string, unknown>).__cacheTtl = 60_000;

    const reply = createMockReply();
    reply.statusCode = 404;

    await cacheOnSendHook(request, reply as unknown as FastifyReply, '{"error":"not found"}');

    expect(getCacheStore().size).toBe(0);
  });
});

describe('clearCache', () => {
  it('should clear all entries without prefix', () => {
    const store = getCacheStore();
    store.set('GET:/api/v1/plans', { body: {}, statusCode: 200, expiresAt: Date.now() + 60_000 });
    store.set('GET:/api/v1/regions', { body: {}, statusCode: 200, expiresAt: Date.now() + 60_000 });

    clearCache();
    expect(store.size).toBe(0);
  });

  it('should clear only matching entries with prefix', () => {
    const store = getCacheStore();
    store.set('GET:/api/v1/plans', { body: {}, statusCode: 200, expiresAt: Date.now() + 60_000 });
    store.set('GET:/api/v1/regions', { body: {}, statusCode: 200, expiresAt: Date.now() + 60_000 });

    clearCache('GET:/api/v1/plans');
    expect(store.size).toBe(1);
    expect(store.has('GET:/api/v1/regions')).toBe(true);
  });
});
