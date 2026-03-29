import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';

interface CacheEntry {
  readonly body: unknown;
  readonly statusCode: number;
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function buildCacheKey(request: FastifyRequest): string {
  return `${request.method}:${request.url}`;
}

function isExpired(entry: CacheEntry): boolean {
  return Date.now() >= entry.expiresAt;
}

/**
 * Creates a Fastify preHandler hook that caches GET 200 responses in-memory.
 * Uses preHandler (not onRequest) so auth runs first.
 *
 * Usage:
 *   app.get('/path', { preHandler: createCacheMiddleware(300_000) }, handler);
 */
export function createCacheMiddleware(ttlMs: number) {
  return async function cacheHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // Only cache GET requests
    if (request.method !== 'GET') return;

    const key = buildCacheKey(request);
    const entry = cache.get(key);

    if (entry && !isExpired(entry)) {
      // Cache hit — send cached response immediately
      reply.header('x-cache', 'HIT');
      reply.send(entry.body);
      return;
    }

    // Cache miss — remove expired entry if present
    if (entry) cache.delete(key);
    reply.header('x-cache', 'MISS');

    // Store key + TTL on request for the onSend capture
    (request as unknown as Record<string, unknown>).__cacheKey = key;
    (request as unknown as Record<string, unknown>).__cacheTtl = ttlMs;
  };
}

/**
 * Global onSend hook to capture responses for caching.
 * Register once: app.addHook('onSend', cacheOnSendHook)
 */
export async function cacheOnSendHook(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  const key = (request as unknown as Record<string, unknown>).__cacheKey as string | undefined;
  const ttl = (request as unknown as Record<string, unknown>).__cacheTtl as number | undefined;

  if (key && ttl && reply.statusCode === 200) {
    const body = typeof payload === 'string' ? JSON.parse(payload) : payload;
    cache.set(key, {
      body,
      statusCode: 200,
      expiresAt: Date.now() + ttl,
    });
  }

  return payload;
}

/**
 * Clears cached entries. If a prefix is provided, only entries whose key
 * starts with the prefix are removed. Otherwise the entire cache is cleared.
 */
export function clearCache(prefix?: string): void {
  if (!prefix) {
    cache.clear();
    return;
  }

  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

/**
 * Exposed for testing — returns the underlying cache Map.
 */
export function getCacheStore(): Map<string, CacheEntry> {
  return cache;
}
