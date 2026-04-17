# API Pagination Strategy

**Status:** Pre-Phase 1 Planning  
**Last Updated:** March 3, 2026  
**Owner:** Backend Team

## Overview

This document standardizes pagination across all 80+ REST API endpoints. Proper pagination is critical for:
- **Performance:** Prevent loading thousands of records
- **Consistency:** Predictable API behavior across all endpoints
- **User Experience:** Smooth infinite scroll and data navigation
- **Analytics:** Track API usage patterns

---

## Pagination Strategy: Cursor-Based (Recommended)

### Why Cursor-Based Over Offset-Based?

| Aspect | Offset-Based | Cursor-Based |
| --- | --- | --- |
| **Performance** | O(n) - slow with large offsets | O(1) - constant time |
| **Data Consistency** | ❌ Shows duplicates if data inserted | ✅ Consistent across pages |
| **Scalability** | ❌ Breaks with millions of rows | ✅ Works at any scale |
| **Cursor Handling** | N/A | Simple base64 encoding |
| **Industry Standard** | Legacy systems | Modern APIs (GitHub, Stripe, Slack) |

### Cursor Format

Cursors are **opaque, base64-encoded** strings containing:
- **Table/Resource identifier** (e.g., `workload`)
- **Sort field value** (e.g., `created_at = 2026-01-15T10:30:00Z`)
- **Primary key** (e.g., `id = abc-123`)

```
Cursor: eyJyZXNvdXJjZSI6Indvcmtsb2FkIiwic29ydCI6IjIwMjYtMDEtMTVUMTA6MzA6MDBaIiwiaWQiOiJhYmMtMTIzIn0=

// Decoded:
{
  "resource": "workload",
  "sort": "2026-01-15T10:30:00Z",
  "id": "abc-123"
}
```

**Benefit:** Opaque format prevents clients from modifying cursor logic.

---

## Standard Pagination Response Format

### List Endpoint Response

All list endpoints must return this structure:

```json
{
  "data": [
    {
      "id": "workload-123",
      "name": "My App",
      "status": "running",
      "created_at": "2026-01-15T10:30:00Z"
    },
    {
      "id": "workload-456",
      "name": "Database Server",
      "status": "running",
      "created_at": "2026-01-14T09:15:00Z"
    }
  ],
  "pagination": {
    "cursor": "next_cursor_value_here",
    "has_more": true,
    "page_size": 20,
    "total_count": 245
  }
}
```

### Response Fields

| Field | Type | Description |
| --- | --- | --- |
| `data` | Array | Current page of items |
| `pagination.cursor` | String | Base64 cursor for next page (null if last page) |
| `pagination.has_more` | Boolean | True if more results available |
| `pagination.page_size` | Integer | Number of items returned |
| `pagination.total_count` | Integer | Total items matching filter (optional, calculate if needed) |

---

## Request Parameters

### Standard Query Parameters

```
GET /api/clients?
  limit=20
  &cursor=next_cursor_value
  &sort=created_at:desc
  &filter[status]=active
  &filter[region_id]=us-east-1
  &include=workloads,domains
```

### Parameter Definitions

| Parameter | Type | Default | Max | Description |
| --- | --- | --- | --- | --- |
| `limit` | Integer | 20 | 100 | Items per page |
| `cursor` | String | null | - | Opaque cursor from previous response |
| `sort` | String | `created_at:desc` | - | Format: `field:asc\|desc` |
| `filter[*]` | String | - | - | Filter by field (e.g., `filter[status]=active`) |
| `include` | String (CSV) | - | - | Include related resources (e.g., `include=workloads,domains`) |
| `search` | String | - | 255 chars | Full-text search across specified fields |

### Sorting Options

**Default sort order:** `created_at:desc` (newest first)

**Allowed sort fields** (per endpoint):

```
Clients:     created_at, updated_at, company_name, status
Workloads:   created_at, updated_at, name, status
Domains:     created_at, domain_name, status
Backups:     created_at, size_bytes, status
AuditLogs:   timestamp, action_type, resource_type
```

---

## Filter Syntax

### Basic Filters

```
GET /api/clients?filter[status]=active
GET /api/workloads?filter[status]=running&filter[client_id]=client-123
```

### Advanced Filters (Optional)

For Phase 2+, support filter operators:

```
GET /api/usage_metrics?filter[value][gte]=100&filter[value][lte]=500
GET /api/audit_logs?filter[timestamp][gte]=2026-01-01&filter[timestamp][lte]=2026-01-31
```

### Filter Operators

```
$eq      Equal
$ne      Not equal
$gt      Greater than
$gte     Greater than or equal
$lt      Less than
$lte     Less than or equal
$in      In array
$nin     Not in array
```

---

## Code Examples

### JavaScript/Node.js Client

```javascript
// Using opaque cursor-based pagination
const fetchClients = async (cursor = null) => {
  const params = new URLSearchParams({
    limit: 20,
    sort: 'created_at:desc',
    'filter[status]': 'active'
  });

  if (cursor) params.append('cursor', cursor);

  const response = await fetch(`/api/clients?${params}`);
  const { data, pagination } = await response.json();

  return { data, pagination };
};

// Infinite scroll
const clients = [];
let cursor = null;

async function loadMore() {
  const { data, pagination } = await fetchClients(cursor);
  clients.push(...data);
  
  if (pagination.has_more) {
    cursor = pagination.cursor; // Store for next call
  }
}
```

### React Hook for Pagination

```typescript
const useList = <T,>(endpoint: string, limit = 20) => {
  const [data, setData] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const fetchMore = async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        limit: limit.toString(),
        ...(cursor && { cursor })
      });

      const response = await fetch(`${endpoint}?${params}`);
      const { data: newData, pagination } = await response.json();

      setData(prev => [...prev, ...newData]);
      setCursor(pagination.cursor);
      setHasMore(pagination.has_more);
    } finally {
      setIsLoading(false);
    }
  };

  return { data, fetchMore, hasMore, isLoading };
};

// Usage in component
function ClientsList() {
  const { data, fetchMore, hasMore } = useList('/api/clients');

  return (
    <>
      {data.map(client => (
        <ClientCard key={client.id} client={client} />
      ))}
      {hasMore && <button onClick={fetchMore}>Load More</button>}
    </>
  );
}
```

### Backend Implementation (Node.js/Fastify)

```typescript
import { decodeCursor, encodeCursor } from '../utils/cursor';

app.get('/api/clients', async (req, reply) => {
  const tenantId = req.user.tenant_id;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const cursor = req.query.cursor;
  const sort = req.query.sort || 'created_at:desc';

  // Decode cursor
  let whereClause: any = { client_id: tenantId };
  if (cursor) {
    const decodedCursor = decodeCursor(cursor);
    // Apply cursor filtering (greater than / less than based on sort direction)
    whereClause.created_at = { [sort.includes('desc') ? '$lt' : '$gt']: decodedCursor.sort };
  }

  // Apply filters
  if (req.query.filter) {
    Object.entries(req.query.filter).forEach(([key, value]) => {
      whereClause[key] = value;
    });
  }

  // Fetch limit + 1 to detect if more results exist
  const clients = await db.clients.find(whereClause)
    .sort(sort)
    .limit(limit + 1)
    .lean();

  const hasMore = clients.length > limit;
  const data = clients.slice(0, limit);

  // Generate next cursor
  let nextCursor = null;
  if (hasMore) {
    const lastItem = data[data.length - 1];
    nextCursor = encodeCursor({
      resource: 'client',
      sort: lastItem.created_at.toISOString(),
      id: lastItem.id
    });
  }

  reply.send({
    data,
    pagination: {
      cursor: nextCursor,
      has_more: hasMore,
      page_size: data.length,
      total_count: await db.clients.countDocuments(whereClause) // Optional
    }
  });
});
```

---

## Cursor Encoding/Decoding Utilities

### TypeScript Utilities

```typescript
// utils/cursor.ts

interface CursorData {
  resource: string;
  sort: string;
  id: string;
}

export const encodeCursor = (data: CursorData): string => {
  return Buffer.from(JSON.stringify(data)).toString('base64');
};

export const decodeCursor = (cursor: string): CursorData => {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8'));
  } catch (e) {
    throw new Error('Invalid cursor format');
  }
};

// Validation
export const validateCursor = (cursor: string): boolean => {
  try {
    decodeCursor(cursor);
    return true;
  } catch {
    return false;
  }
};
```

---

## Special Cases & Handling

### Include Related Resources (Eager Loading)

Request related data in a single call:

```
GET /api/clients?include=workloads,domains,backups

Response:
{
  "data": [
    {
      "id": "client-123",
      "company_name": "Acme Corp",
      "workloads": [
        { "id": "workload-1", "name": "Web App" }
      ],
      "domains": [
        { "id": "domain-1", "domain_name": "acme.com" }
      ],
      "backups": [...]
    }
  ],
  "pagination": {...}
}
```

**Implementation notes:**
- Only include if explicitly requested (avoid over-fetching by default)
- Limit nested resource depth (max 2 levels)
- Apply same pagination to nested resources if many (defer to Phase 2)

### Full-Text Search

```
GET /api/workloads?search=web&filter[status]=running

// Searches across: name, description, and other text fields
```

### Bulk Operations (Non-Paginated)

Endpoints that return small, guaranteed-small result sets don't need pagination:

```
GET /api/regions        # Max 20 regions, no pagination needed
GET /api/plans          # Max 10 plans, no pagination needed
GET /api/users/roles    # Small set of roles, no pagination needed
```

---

## Error Handling

### Invalid Cursor

```json
{
  "error": {
    "code": "INVALID_CURSOR",
    "message": "The provided cursor is invalid or expired",
    "status": 400
  }
}
```

### Invalid Limit

```json
{
  "error": {
    "code": "INVALID_LIMIT",
    "message": "Limit must be between 1 and 100",
    "status": 400
  }
}
```

### Invalid Sort Field

```json
{
  "error": {
    "code": "INVALID_SORT_FIELD",
    "message": "Cannot sort by 'password' on this endpoint",
    "status": 400
  }
}
```

---

## Performance Considerations

### Database Query Optimization

```sql
-- Indexed for cursor pagination
SELECT * FROM clients
WHERE client_id = $1
  AND created_at < $2  -- Cursor filter
  AND status = $3      -- Additional filter
ORDER BY created_at DESC
LIMIT 21;              -- +1 to detect has_more
```

### N+1 Problem Prevention

Use eager loading for `include` parameters:

```typescript
// Bad: N+1 queries
const clients = await db.clients.find().limit(20);
const withWorkloads = await Promise.all(
  clients.map(c => db.workloads.find({ client_id: c.id }))
);

// Good: Single batch query
const clients = await db.clients.find().limit(20);
const workloads = await db.workloads.find({
  client_id: { $in: clients.map(c => c.id) }
});
```

### Cursor Calculation Cost

- **Encoding cursor:** O(1) - simple JSON serialization
- **Decoding cursor:** O(1) - simple JSON deserialization
- **Database lookup with cursor:** O(log n) - indexed scan

No additional performance cost over offset pagination.

---

## OpenAPI Schema

```yaml
parameters:
  - name: limit
    in: query
    schema:
      type: integer
      minimum: 1
      maximum: 100
      default: 20
    description: Number of items to return

  - name: cursor
    in: query
    schema:
      type: string
    description: Opaque cursor from previous response for pagination

  - name: sort
    in: query
    schema:
      type: string
      enum: [created_at:asc, created_at:desc, updated_at:asc, updated_at:desc]
      default: created_at:desc

responses:
  '200':
    description: List of resources
    content:
      application/json:
        schema:
          type: object
          properties:
            data:
              type: array
              items:
                $ref: '#/components/schemas/Resource'
            pagination:
              type: object
              properties:
                cursor:
                  type: string
                  nullable: true
                  description: Cursor for next page (null if last page)
                has_more:
                  type: boolean
                page_size:
                  type: integer
                total_count:
                  type: integer
```

---

## Migration Guide for Existing Endpoints

If refactoring existing offset-based pagination:

### Phase 1 (Current)
- Implement cursor-based pagination for new endpoints
- Existing endpoints can continue with offset until Phase 2

### Phase 2 (Planned)
- Migrate all remaining endpoints to cursor-based
- Deprecate offset-based pagination with 90-day notice

### Deprecation Response Header
```
Deprecation: true
Sunset: Wed, 31 Dec 2026 23:59:59 GMT
Link: <https://docs.k8s-platform.local-dev/migration/pagination>; rel="deprecation"
```

---

## Testing Strategy

### Unit Tests

```typescript
describe('Pagination', () => {
  it('should encode and decode cursor', () => {
    const data = { resource: 'client', sort: '2026-01-15T10:30:00Z', id: 'abc-123' };
    const encoded = encodeCursor(data);
    const decoded = decodeCursor(encoded);
    expect(decoded).toEqual(data);
  });

  it('should reject invalid cursor', () => {
    expect(() => decodeCursor('invalid!@#$')).toThrow();
  });
});
```

### Integration Tests

```typescript
describe('List Endpoints', () => {
  it('should return paginated results with cursor', async () => {
    const res1 = await client.get('/api/clients?limit=5');
    expect(res1.data.pagination.has_more).toBe(true);
    expect(res1.data.pagination.cursor).toBeDefined();

    const res2 = await client.get(`/api/clients?limit=5&cursor=${res1.data.pagination.cursor}`);
    expect(res2.data.data[0].id).not.toBe(res1.data.data[0].id);
  });

  it('should handle invalid cursor gracefully', async () => {
    const res = await client.get('/api/clients?cursor=invalid');
    expect(res.status).toBe(400);
  });
});
```

---

## Checklist for Implementation

- [ ] Create cursor encoding/decoding utilities
- [ ] Update all list endpoints to use cursor-based pagination
- [ ] Add pagination parameters to OpenAPI spec
- [ ] Update API documentation with examples
- [ ] Add pagination tests (unit + integration)
- [ ] Performance test with 1M+ records
- [ ] Update client SDKs with pagination helpers
- [ ] Document migration path for existing clients

---

## References

- GitHub API: https://docs.github.com/en/rest/guides/traversing-with-pagination
- Stripe API: https://stripe.com/docs/api/pagination
- Slack API: https://api.slack.com/docs/pagination
- Cursor-based pagination guide: https://www.sitepoint.com/pagination-with-cursor
