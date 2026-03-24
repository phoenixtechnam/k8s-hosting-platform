# Caching Strategy: Three-Layer Approach

**Status:** Pre-Phase 1 Planning  
**Last Updated:** March 3, 2026  
**Owner:** Backend & Performance Team

## Overview

Multi-layer caching improves performance and reduces database load:
- **Layer 1 (HTTP):** Browser & CDN caching
- **Layer 2 (Application):** In-memory cache (Redis)
- **Layer 3 (Database):** Query result cache

**Target:** Reduce API latency from ~300ms to ~50ms for cached responses

---

## Layer 1: HTTP Caching

### Cache-Control Headers

```typescript
// middleware/caching.ts

export const setCacheHeaders = (duration: number) => {
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', `public, max-age=${duration}`);
    res.setHeader('ETag', generateETag(res.body));
    next();
  };
};

// Usage in routes
app.get('/api/regions', setCacheHeaders(3600), (req, res) => {
  // Regions rarely change, cache for 1 hour
  const regions = await getRegions();
  res.json(regions);
});

app.get('/api/clients/:id', setCacheHeaders(300), (req, res) => {
  // Client details, cache for 5 minutes
  const client = await getClient(req.params.id);
  res.json(client);
});

app.get('/api/workloads/:id/logs', setCacheHeaders(60), (req, res) => {
  // Logs update frequently, cache for 1 minute
  const logs = await getLogs(req.params.id);
  res.json(logs);
});
```

### Cache Invalidation Headers

```typescript
// On resource update, clear related caches
app.put('/api/clients/:id', async (req, res) => {
  const client = await updateClient(req.params.id, req.body);

  // Invalidate client detail cache
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  res.json(client);
});
```

### CDN Integration (Cloudflare / CloudFront)

```
For public endpoints (status pages, help docs):
- Cache static content indefinitely
- Cache dynamic content for 5 minutes
- Purge cache on updates via webhook
```

---

## Layer 2: Application Cache (Redis)

### Redis Setup

```yaml
# kubernetes/redis/redis-statefulset.yaml

apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
  namespace: platform
spec:
  serviceName: redis
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
      - name: redis
        image: redis:7-alpine
        ports:
        - containerPort: 6379
        volumeMounts:
        - name: redis-data
          mountPath: /data
        command: ["redis-server", "--appendonly", "yes"]
      volumeClaimTemplates:
      - metadata:
          name: redis-data
        spec:
          accessModes: ["ReadWriteOnce"]
          storageClassName: "longhorn"
          resources:
            requests:
              storage: 10Gi
```

### Redis Client Implementation

```typescript
// lib/redis.ts

import Redis from 'ioredis';

export const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis.platform.svc.cluster.local',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  maxRetriesPerRequest: 3
});

redis.on('error', (err) => {
  console.error('Redis error:', err);
});

redis.on('connect', () => {
  console.log('Redis connected');
});
```

### Caching Patterns

#### 1. Cache-Aside (Lazy Loading)

```typescript
// Get client from cache or database
export const getClient = async (clientId: string) => {
  const cacheKey = `client:${clientId}`;

  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Not in cache, fetch from database
  const client = await db.clients.findById(clientId);
  if (client) {
    // Store in cache for 30 minutes
    await redis.setex(cacheKey, 30 * 60, JSON.stringify(client));
  }

  return client;
};
```

#### 2. Write-Through

```typescript
// Update client and cache
export const updateClient = async (clientId: string, updates: any) => {
  const client = await db.clients.update(clientId, updates);

  // Update cache
  const cacheKey = `client:${clientId}`;
  await redis.setex(cacheKey, 30 * 60, JSON.stringify(client));

  // Invalidate list cache
  await redis.del('clients:list');

  return client;
};
```

#### 3. Write-Behind (Async Write)

```typescript
// Log event asynchronously, update cache immediately
export const logEvent = async (event: any) => {
  // Update cache immediately
  const cacheKey = `events:${event.client_id}`;
  await redis.lpush(cacheKey, JSON.stringify(event));
  await redis.ltrim(cacheKey, 0, 99);  // Keep latest 100

  // Queue for database write (fire and forget)
  await queue.enqueue('audit_log_write', { event });
};
```

### Cache Key Naming Convention

```typescript
// Consistent cache key structure
const getCacheKey = (resource: string, id: string, variant?: string) => {
  return variant 
    ? `${resource}:${id}:${variant}`
    : `${resource}:${id}`;
};

// Examples
const key1 = getCacheKey('client', 'client-123');            // client:client-123
const key2 = getCacheKey('client', 'client-123', 'details'); // client:client-123:details
const key3 = getCacheKey('workloads', 'client-123', 'list'); // workloads:client-123:list
```

### Cache Invalidation

```typescript
// Pattern-based invalidation
export const invalidateClientCache = async (clientId: string) => {
  const pattern = `client:${clientId}*`;
  const keys = await redis.keys(pattern);
  
  if (keys.length > 0) {
    await redis.del(...keys);
  }

  // Invalidate list cache too
  await redis.del('clients:list');
};

// Bulk invalidation
export const invalidateCachePattern = async (pattern: string) => {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
};
```

### Cache Expiration

```typescript
// Set expiration on cache entries
const CACHE_TTL = {
  clients: 30 * 60,           // 30 minutes
  workloads: 5 * 60,          // 5 minutes
  domains: 10 * 60,           // 10 minutes
  monitoring: 60,             // 1 minute (fresh data)
  audit_logs: 0,              // No caching (always fresh)
  regions: 24 * 60 * 60,      // 24 hours (rarely change)
  plans: 24 * 60 * 60,        // 24 hours
  users: 30 * 60,             // 30 minutes
};

// Use in get operations
const ttl = CACHE_TTL[resourceType] || 10 * 60;
await redis.setex(cacheKey, ttl, JSON.stringify(data));
```

### Distributed Caching

```typescript
// For multi-instance deployments, use Redis Pub/Sub
redis.subscribe('cache-invalidation', (err, count) => {
  if (err) console.error('Subscribe error:', err);
});

redis.on('message', (channel, message) => {
  if (channel === 'cache-invalidation') {
    const { pattern } = JSON.parse(message);
    // Invalidate pattern in local memory if using L1 cache
    invalidateLocalCache(pattern);
  }
});

// When invalidating, broadcast to all instances
export const broadcastCacheInvalidation = async (pattern: string) => {
  await redis.publish('cache-invalidation', JSON.stringify({ pattern }));
};
```

---

## Layer 3: Database Query Cache

### Query Result Caching

```typescript
// Cache expensive database queries
const getCachedWorkloads = async (clientId: string, filters: any) => {
  const cacheKey = `workloads:${clientId}:${JSON.stringify(filters)}`;

  // Check cache
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // Execute query
  const query = db.workloads.where({ client_id: clientId });
  if (filters.status) query = query.where({ status: filters.status });
  
  const workloads = await query.toArray();

  // Cache for 5 minutes
  await redis.setex(cacheKey, 5 * 60, JSON.stringify(workloads));

  return workloads;
};
```

### Dataloader for N+1 Problem

```typescript
// Use DataLoader to batch database queries
import DataLoader from 'dataloader';

const workloadLoader = new DataLoader(async (clientIds) => {
  const workloads = await db.workloads.whereIn('client_id', clientIds);
  
  return clientIds.map(clientId =>
    workloads.filter(w => w.client_id === clientId)
  );
});

// In resolver or route
app.get('/api/clients/:id/workloads', async (req, res) => {
  const workloads = await workloadLoader.load(req.params.id);
  res.json(workloads);
});
```

### Database Connection Pooling

```typescript
// Reduce connection overhead
const pool = new Pool({
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Monitor pool
setInterval(() => {
  console.log(`Pool size: ${pool.totalCount}, available: ${pool.idleCount}`);
}, 60000);
```

---

## Cache Warming

### Pre-load Frequently Accessed Data

```typescript
// On application startup
export const warmCache = async () => {
  console.log('Warming cache...');

  // Cache all regions (rarely change)
  const regions = await db.regions.find();
  for (const region of regions) {
    await redis.setex(
      `region:${region.id}`,
      24 * 60 * 60,
      JSON.stringify(region)
    );
  }

  // Cache all plans
  const plans = await db.plans.find();
  for (const plan of plans) {
    await redis.setex(
      `plan:${plan.id}`,
      24 * 60 * 60,
      JSON.stringify(plan)
    );
  }

  // Cache RBAC roles
  const roles = await db.rbacRoles.find();
  for (const role of roles) {
    await redis.setex(
      `role:${role.id}`,
      12 * 60 * 60,
      JSON.stringify(role)
    );
  }

  console.log('Cache warmed successfully');
};

// Call on startup
app.listen(3000, async () => {
  await warmCache();
});
```

---

## Monitoring Cache Performance

### Cache Hit Ratio

```typescript
// Track cache hits and misses
let cacheHits = 0;
let cacheMisses = 0;

export const getCacheMetrics = () => {
  const hitRatio = cacheHits / (cacheHits + cacheMisses) * 100;
  return {
    hits: cacheHits,
    misses: cacheMisses,
    hitRatio: hitRatio.toFixed(2) + '%'
  };
};

// In monitoring
const metrics = await prometheus.register.metrics();
// Cache hit ratio: 85% (target: > 80%)
```

### Redis Memory Usage

```bash
# Monitor Redis memory
redis-cli INFO memory

# Output:
# used_memory_human: 2.5G
# used_memory_peak_human: 3.0G
# maxmemory_policy: allkeys-lru  # Evict least recently used when full
```

### Cache Eviction Policy

```yaml
# Redis eviction policy (in Kubernetes)
apiVersion: v1
kind: ConfigMap
metadata:
  name: redis-config
data:
  redis.conf: |
    maxmemory 5gb
    maxmemory-policy allkeys-lru  # Evict least recently used keys
    # Other policies:
    # - allkeys-lfu: Least frequently used
    # - allkeys-random: Random
    # - volatile-lru: LRU among keys with TTL
```

---

## Cache Stampede Prevention

### Lock-Based Approach

```typescript
// Prevent multiple processes from recomputing same cache
export const getCachedWithLock = async (key: string, compute: () => Promise<any>) => {
  // Try to get from cache
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  // Try to acquire lock
  const lockKey = `lock:${key}`;
  const lockAcquired = await redis.set(
    lockKey,
    '1',
    'EX', 10,    // 10 second lock timeout
    'NX'         // Only set if not exists
  );

  if (lockAcquired) {
    try {
      // Compute value
      const value = await compute();
      
      // Cache it
      await redis.setex(key, 30 * 60, JSON.stringify(value));
      
      return value;
    } finally {
      // Release lock
      await redis.del(lockKey);
    }
  } else {
    // Another process is computing, wait and retry
    await sleep(100);
    return getCachedWithLock(key, compute);
  }
};
```

### Probabilistic Expiration

```typescript
// Refresh cache before expiry to avoid stampede
export const setProbabilisticExpire = async (key: string, value: any, ttl: number) => {
  const beta = 1.0;
  const now = Date.now();
  
  // Store value with metadata
  const data = {
    value,
    xFreshnessTTL: ttl,
    xRecalculateAfter: now + ttl
  };

  await redis.setex(key, ttl, JSON.stringify(data));
};

export const getProbabilisticCached = async (key: string, compute: () => Promise<any>) => {
  const cached = await redis.get(key);
  if (!cached) {
    const value = await compute();
    await setProbabilisticExpire(key, value, 30 * 60);
    return value;
  }

  const data = JSON.parse(cached);
  const now = Date.now();

  // If near expiry, refresh proactively
  if (now > data.xRecalculateAfter) {
    // Compute in background
    compute().then(value => {
      setProbabilisticExpire(key, value, 30 * 60);
    }).catch(console.error);
  }

  return data.value;
};
```

---

## Testing Cache Behavior

```typescript
describe('Caching Strategy', () => {
  beforeEach(async () => {
    await redis.flushdb();  // Clear cache before each test
  });

  it('should return cached value on second request', async () => {
    const clientId = 'client-123';
    
    // First request - cache miss
    const client1 = await getClient(clientId);
    expect(client1.id).toBe(clientId);

    // Verify cached
    const cached = await redis.get(`client:${clientId}`);
    expect(cached).toBeDefined();

    // Second request - cache hit (should not query database)
    const client2 = await getClient(clientId);
    expect(client2).toEqual(client1);
  });

  it('should invalidate cache on update', async () => {
    const clientId = 'client-123';

    // Populate cache
    await getClient(clientId);
    let cached = await redis.get(`client:${clientId}`);
    expect(cached).toBeDefined();

    // Update client
    await updateClient(clientId, { companyName: 'New Name' });

    // Verify cache cleared
    cached = await redis.get(`client:${clientId}`);
    expect(cached).toBeNull();
  });

  it('should prevent cache stampede with locking', async () => {
    let computeCount = 0;
    const compute = async () => {
      computeCount++;
      await sleep(100);
      return { value: 'expensive' };
    };

    // Simulate 10 concurrent requests
    const results = await Promise.all(
      Array(10).fill(null).map(() =>
        getCachedWithLock('expensive-key', compute)
      )
    );

    // Should compute only once despite 10 requests
    expect(computeCount).toBe(1);
    expect(results).toHaveLength(10);
    expect(results.every(r => r.value === 'expensive')).toBe(true);
  });

  it('should respect cache TTL', async () => {
    const key = 'temp-key';
    await redis.setex(key, 1, 'value');
    
    const v1 = await redis.get(key);
    expect(v1).toBe('value');

    await sleep(1100);
    
    const v2 = await redis.get(key);
    expect(v2).toBeNull();
  });
});
```

---

## Checklist

- [ ] Set up Redis cluster/single instance
- [ ] Implement Layer 1: HTTP caching headers
- [ ] Implement Layer 2: Redis application cache
- [ ] Implement Layer 3: Database query caching
- [ ] Configure cache invalidation on updates
- [ ] Set up DataLoader for N+1 prevention
- [ ] Configure connection pooling
- [ ] Implement cache warming on startup
- [ ] Monitor cache hit ratio (target: > 80%)
- [ ] Monitor Redis memory usage
- [ ] Prevent cache stampede with locking
- [ ] Test cache behavior under load
- [ ] Set up alerts for cache failures

---

## References

- Redis: https://redis.io/
- Cache-Control HTTP Headers: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control
- DataLoader: https://github.com/graphql/dataloader
- Cache Stampede: https://en.wikipedia.org/wiki/Cache_stampede
