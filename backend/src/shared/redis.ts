// In-memory LRU cache, replacing the previous ioredis dependency.
//
// Why: Redis was used for ONLY a per-platform-api-pod TTL cache of
// resource metrics + a liveness ping + a self-stat. Dropping Redis
// removes a stateful component (single-replica = SPOF) and trades
// it for an in-process cache with strict bounds.
//
// Memory-leak posture:
//   - lru-cache enforces both `max` (entry count) and `ttl` (age).
//     Entries past either bound are evicted on access. There is no
//     timer per entry by default — we keep `ttlAutopurge: false`
//     so eviction is lazy on get/set, avoiding setInterval leaks
//     in long-running pods.
//   - Cache values are JSON strings (small, bounded by clientCount
//     × per-client-metrics size — measured at ~1-2 KB per entry).
//   - Total worst-case footprint: max=10000 entries × 2KB = ~20MB
//     per platform-api pod. Headroom matches the previous Redis
//     query path.
//   - No closures over external state. Set/get are O(1) hash ops.
//
// API surface intentionally mimics ioredis subset used by callers
// (setex, get, mget, info, ping). Tests + typecheck don't change.

import { LRUCache } from 'lru-cache';

const MAX_ENTRIES = 10_000;          // hard upper bound
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min — matches previous CACHE_TTL

class InMemoryRedisLike {
  private cache: LRUCache<string, string>;

  constructor() {
    this.cache = new LRUCache({
      max: MAX_ENTRIES,
      ttl: DEFAULT_TTL_MS,
      ttlAutopurge: false,           // lazy eviction — no timer leak
      updateAgeOnGet: false,         // keep insertion-time TTL semantics
      updateAgeOnHas: false,
    });
  }

  // ioredis: SETEX key seconds value
  // Wraps cache.set with per-key TTL override.
  setex(key: string, seconds: number, value: string): Promise<'OK'> {
    this.cache.set(key, value, { ttl: seconds * 1000 });
    return Promise.resolve('OK');
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.cache.get(key) ?? null);
  }

  // ioredis: MGET key1 key2 …
  mget(...keys: string[]): Promise<(string | null)[]> {
    return Promise.resolve(keys.map((k) => this.cache.get(k) ?? null));
  }

  // Used only by health probe — return immediately. Keeps the
  // health-check call site working without code changes.
  ping(): Promise<'PONG'> {
    return Promise.resolve('PONG');
  }

  // Used by storage/service.ts to report cache footprint in the
  // admin storage-inventory dashboard. Approximate the resident
  // size by counting string lengths.
  info(_section?: string): Promise<string> {
    let bytes = 0;
    for (const v of this.cache.values()) bytes += v.length;
    return Promise.resolve(`# Memory\nused_memory:${bytes}\n`);
  }

  // Test helper.
  clear(): void {
    this.cache.clear();
  }
}

let client: InMemoryRedisLike | null = null;

export function getRedis(): InMemoryRedisLike {
  if (!client) client = new InMemoryRedisLike();
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    client.clear();
    client = null;
  }
}

// Type alias used by storage/service.ts cast — kept compatible.
export type RedisLike = InMemoryRedisLike;
