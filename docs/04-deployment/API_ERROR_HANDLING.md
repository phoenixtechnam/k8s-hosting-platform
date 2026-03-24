# API Error Handling & Error Code Registry

**Status:** Pre-Phase 1 Planning  
**Last Updated:** March 3, 2026  
**Owner:** Backend & API Team

## Overview

Standardized error handling ensures:
- **Consistent API behavior** across all 80+ endpoints
- **Clear error messages** for debugging and integration
- **Proper HTTP status codes** aligned with REST conventions
- **Client-side error handling** with actionable remediation
- **Error tracking** for monitoring and alerting

---

## Error Response Format

### Standard Error Response

All error responses must follow this structure:

```json
{
  "error": {
    "code": "WORKLOAD_NOT_FOUND",
    "message": "The requested workload was not found",
    "status": 404,
    "timestamp": "2026-01-15T10:30:45.123Z",
    "request_id": "req-abc-12345",
    "details": {
      "workload_id": "workload-123",
      "client_id": "client-456"
    }
  }
}
```

### Response Fields

| Field | Type | Description |
| --- | --- | --- |
| `error.code` | String | Machine-readable error code (SCREAMING_SNAKE_CASE) |
| `error.message` | String | Human-readable error message |
| `error.status` | Integer | HTTP status code |
| `error.timestamp` | ISO 8601 | Error occurrence time (server time) |
| `error.request_id` | String | Unique request ID for correlation |
| `error.details` | Object | Additional context (optional) |
| `error.remediation` | String | How to fix the issue (optional) |

---

## HTTP Status Codes

### 2xx Success

| Code | Name | Usage |
| --- | --- | --- |
| 200 | OK | Request succeeded, response body included |
| 201 | Created | Resource successfully created |
| 202 | Accepted | Request accepted for async processing |
| 204 | No Content | Request succeeded, no response body |

### 4xx Client Errors

| Code | Name | Usage |
| --- | --- | --- |
| 400 | Bad Request | Invalid request parameters, validation failed |
| 401 | Unauthorized | Missing or invalid authentication |
| 403 | Forbidden | Authenticated but lacking permissions |
| 404 | Not Found | Resource does not exist |
| 409 | Conflict | Request conflicts with current state (e.g., duplicate) |
| 422 | Unprocessable Entity | Request syntax valid but semantic error |
| 429 | Too Many Requests | Rate limit exceeded |

### 5xx Server Errors

| Code | Name | Usage |
| --- | --- | --- |
| 500 | Internal Server Error | Unexpected server error |
| 502 | Bad Gateway | Service unavailable (dependency failure) |
| 503 | Service Unavailable | Server temporarily unavailable |
| 504 | Gateway Timeout | Upstream timeout |

---

## Error Code Registry

### Authentication & Authorization (1000-1999)

| Code | HTTP | Message | Remediation |
| --- | --- | --- | --- |
| `INVALID_CREDENTIALS` | 401 | Invalid email or password | Verify email and password |
| `ACCOUNT_DISABLED` | 401 | Your account has been disabled | Contact support |
| `EMAIL_NOT_VERIFIED` | 401 | Email verification required | Check email for verification link |
| `MISSING_BEARER_TOKEN` | 401 | Authorization header missing or invalid | Provide valid JWT in `Authorization: Bearer <token>` |
| `INVALID_TOKEN` | 401 | Token is invalid or expired | Re-authenticate to get new token |
| `EXPIRED_TOKEN` | 401 | Token has expired | Use refresh token to obtain new access token |
| `INSUFFICIENT_PERMISSIONS` | 403 | Insufficient permissions for this action | Contact admin for permission escalation |
| `MFA_REQUIRED` | 401 | Multi-factor authentication required | Complete MFA challenge |
| `MFA_INVALID_CODE` | 401 | MFA code is invalid or expired | Verify MFA code and try again |
| `SESSION_EXPIRED` | 401 | Your session has expired | Re-authenticate |

### Request Validation (2000-2999)

| Code | HTTP | Message | Remediation |
| --- | --- | --- | --- |
| `MISSING_REQUIRED_FIELD` | 400 | Required field missing: {field_name} | Provide missing required field |
| `INVALID_FIELD_FORMAT` | 400 | Invalid format for field '{field}': expected {expected}, got {actual} | Fix field format |
| `INVALID_FIELD_VALUE` | 400 | Invalid value for field '{field}' | Check field value against allowed values |
| `FIELD_TOO_LONG` | 400 | Field '{field}' exceeds maximum length of {max} characters | Reduce field length |
| `FIELD_TOO_SHORT` | 400 | Field '{field}' is shorter than minimum {min} characters | Increase field length |
| `INVALID_EMAIL` | 400 | Invalid email format | Provide valid email address |
| `INVALID_URL` | 400 | Invalid URL format | Provide valid URL (e.g., https://example.com) |
| `INVALID_JSON` | 400 | Request body contains invalid JSON | Check JSON syntax |
| `INVALID_QUERY_PARAMETER` | 400 | Invalid query parameter: {param} | Verify query parameter |
| `INVALID_PAGINATION_LIMIT` | 400 | Pagination limit must be between 1 and 100 | Adjust limit value |
| `INVALID_CURSOR` | 400 | Pagination cursor is invalid or expired | Restart pagination from beginning |
| `INVALID_SORT_FIELD` | 400 | Cannot sort by '{field}' on this endpoint | Use allowed sort fields |
| `DUPLICATE_ENTRY` | 409 | This {resource} already exists | Use unique identifier |

### Resource Not Found (3000-3999)

| Code | HTTP | Message | Remediation |
| --- | --- | --- | --- |
| `CLIENT_NOT_FOUND` | 404 | Client '{client_id}' not found | Verify client_id |
| `WORKLOAD_NOT_FOUND` | 404 | Workload '{workload_id}' not found | Verify workload_id exists in your client |
| `DOMAIN_NOT_FOUND` | 404 | Domain '{domain_name}' not found | Verify domain exists |
| `DATABASE_NOT_FOUND` | 404 | Database '{database_name}' not found | Verify database exists |
| `BACKUP_NOT_FOUND` | 404 | Backup '{backup_id}' not found | Verify backup_id |
| `SSH_KEY_NOT_FOUND` | 404 | SSH key '{key_id}' not found | Verify SSH key exists |
| `APPLICATION_NOT_FOUND` | 404 | Application '{app_id}' not found | Verify application ID |
| `REGION_NOT_FOUND` | 404 | Region '{region_code}' not found | Verify region code |
| `PLAN_NOT_FOUND` | 404 | Hosting plan not found | Verify plan code |
| `USER_NOT_FOUND` | 404 | User not found | Verify user exists |
| `RESOURCE_NOT_FOUND` | 404 | Resource not found | Verify resource exists |

### Resource Conflicts (4000-4999)

| Code | HTTP | Message | Remediation |
| --- | --- | --- | --- |
| `RESOURCE_ALREADY_EXISTS` | 409 | {Resource} '{name}' already exists | Use unique name or identifier |
| `WORKLOAD_ALREADY_RUNNING` | 409 | Workload is already running | Stop workload first or use different name |
| `DOMAIN_ALREADY_IN_USE` | 409 | Domain '{domain_name}' is already in use | Use different domain |
| `CANNOT_DELETE_RUNNING_WORKLOAD` | 409 | Cannot delete running workload (status: {status}) | Stop workload first |
| `CANNOT_MODIFY_SYSTEM_RESOURCE` | 409 | Cannot modify system resource | This resource is managed by system |
| `INCOMPATIBLE_PLAN` | 409 | Current plan incompatible with requested action | Upgrade plan or contact support |
| `PLAN_CHANGE_IN_PROGRESS` | 409 | Plan change already in progress | Wait for current change to complete |

### Resource Limits (5000-5999)

| Code | HTTP | Message | Remediation |
| --- | --- | --- | --- |
| `QUOTA_EXCEEDED` | 422 | {Resource} quota exceeded (limit: {limit}, current: {current}) | Remove unused resources or upgrade plan |
| `CPU_QUOTA_EXCEEDED` | 422 | CPU quota exceeded (limit: {limit} cores, requested: {requested}) | Reduce requested CPU or upgrade plan |
| `MEMORY_QUOTA_EXCEEDED` | 422 | Memory quota exceeded (limit: {limit} GB, requested: {requested}) | Reduce requested memory or upgrade plan |
| `STORAGE_QUOTA_EXCEEDED` | 422 | Storage quota exceeded (limit: {limit} GB, used: {used}) | Delete unused files or upgrade plan |
| `MAX_WORKLOADS_EXCEEDED` | 422 | Maximum workloads reached for your plan ({limit}) | Upgrade plan or delete unused workloads |
| `MAX_DOMAINS_EXCEEDED` | 422 | Maximum domains reached for your plan ({limit}) | Upgrade plan or remove unused domains |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests. Please retry after {retry_after} seconds | Implement exponential backoff and retry |

### Kubernetes & Deployment (6000-6999)

| Code | HTTP | Message | Remediation |
| --- | --- | --- | --- |
| `KUBERNETES_CLUSTER_UNAVAILABLE` | 503 | Kubernetes cluster is unavailable | Wait for cluster recovery |
| `NAMESPACE_CREATION_FAILED` | 500 | Failed to create Kubernetes namespace | Retry or contact support |
| `POD_DEPLOYMENT_FAILED` | 500 | Failed to deploy pod: {reason} | Check workload configuration and retry |
| `INSUFFICIENT_CLUSTER_RESOURCES` | 503 | Insufficient cluster resources to fulfill request | Wait or reduce resource request |
| `CONTAINER_IMAGE_PULL_FAILED` | 500 | Failed to pull container image | Verify image availability and retry |
| `WORKLOAD_HEALTH_CHECK_FAILED` | 500 | Workload failed health checks (status: {status}) | Check workload logs and configuration |
| `DEPLOYMENT_TIMEOUT` | 504 | Workload deployment exceeded timeout | Increase timeout or check workload image |

### Database (7000-7999)

| Code | HTTP | Message | Remediation |
| --- | --- | --- | --- |
| `DATABASE_CONNECTION_FAILED` | 500 | Unable to connect to database | Verify database is running and credentials |
| `DATABASE_QUERY_FAILED` | 500 | Database query failed: {reason} | Check query syntax and try again |
| `DATABASE_LOCK_TIMEOUT` | 500 | Database operation timed out (locked by another operation) | Retry after a few seconds |
| `INVALID_DATABASE_CREDENTIALS` | 400 | Invalid database credentials | Verify username and password |
| `DATABASE_BACKUP_FAILED` | 500 | Failed to backup database | Check backup storage and retry |
| `DATABASE_RESTORE_FAILED` | 500 | Failed to restore database from backup | Verify backup integrity and retry |
| `DATABASE_MIGRATION_FAILED` | 500 | Database migration failed: {reason} | Review migration logs and correct errors |

### External Services (8000-8999)

| Code | HTTP | Message | Remediation |
| --- | --- | --- | --- |
| `DNS_PROVIDER_ERROR` | 500 | DNS provider returned error: {provider}: {error} | Verify DNS provider credentials/configuration |
| `BILLING_SERVICE_ERROR` | 500 | Billing service error | Retry or contact support |
| `EMAIL_DELIVERY_FAILED` | 500 | Failed to send email: {reason} | Check email configuration |
| `SMTP_CONNECTION_ERROR` | 500 | Unable to connect to SMTP server | Verify SMTP settings and retry |
| `STORAGE_PROVIDER_ERROR` | 500 | Storage provider error: {provider} | Verify storage credentials/configuration |
| `BACKUP_STORAGE_ERROR` | 500 | Unable to write to backup storage | Verify storage has available space |

### Business Logic (9000-9999)

| Code | HTTP | Message | Remediation |
| --- | --- | --- | --- |
| `SUBSCRIPTION_EXPIRED` | 403 | Your subscription has expired | Renew subscription |
| `SUBSCRIPTION_SUSPENDED` | 403 | Your subscription is suspended | Contact support |
| `TRIAL_EXPIRED` | 403 | Your trial period has expired | Upgrade to paid plan |
| `PAYMENT_FAILED` | 402 | Payment failed: {reason} | Update payment method and retry |
| `INVALID_COUPON` | 400 | Coupon code is invalid or expired | Verify coupon code |
| `FEATURE_NOT_AVAILABLE` | 403 | This feature is not available on your plan | Upgrade plan |
| `FEATURE_DISABLED` | 403 | This feature has been disabled | Contact support |
| `OPERATION_NOT_ALLOWED` | 403 | This operation is not allowed | Verify action is permitted |

### System & Configuration (10000-10999)

| Code | HTTP | Message | Remediation |
| --- | --- | --- | --- |
| `SYSTEM_MAINTENANCE` | 503 | System is undergoing maintenance | Please try again later |
| `FEATURE_FLAG_DISABLED` | 403 | This feature is not enabled | Contact support to enable feature |
| `INVALID_CONFIGURATION` | 500 | Invalid system configuration | Contact support |
| `VERSION_MISMATCH` | 400 | API version mismatch | Update client to latest version |

---

## Error Response Examples

### Example 1: Validation Error

**Request:**
```bash
POST /api/clients HTTP/1.1
Content-Type: application/json

{
  "company_name": "Acme Corp",
  "company_email": "invalid-email"
}
```

**Response:**
```json
HTTP/1.1 400 Bad Request

{
  "error": {
    "code": "INVALID_EMAIL",
    "message": "Invalid email format",
    "status": 400,
    "timestamp": "2026-01-15T10:30:45.123Z",
    "request_id": "req-12345-abcde",
    "details": {
      "field": "company_email",
      "value": "invalid-email"
    },
    "remediation": "Provide valid email address (e.g., admin@example.com)"
  }
}
```

### Example 2: Authentication Error

**Request:**
```bash
GET /api/workloads HTTP/1.1
Authorization: Bearer invalid.token.here
```

**Response:**
```json
HTTP/1.1 401 Unauthorized

{
  "error": {
    "code": "INVALID_TOKEN",
    "message": "Token is invalid or expired",
    "status": 401,
    "timestamp": "2026-01-15T10:30:45.123Z",
    "request_id": "req-12345-abcde",
    "remediation": "Re-authenticate to get new token"
  }
}
```

### Example 3: Resource Not Found

**Request:**
```bash
GET /api/workloads/invalid-id HTTP/1.1
Authorization: Bearer valid.token.here
```

**Response:**
```json
HTTP/1.1 404 Not Found

{
  "error": {
    "code": "WORKLOAD_NOT_FOUND",
    "message": "Workload 'invalid-id' not found",
    "status": 404,
    "timestamp": "2026-01-15T10:30:45.123Z",
    "request_id": "req-12345-abcde",
    "details": {
      "workload_id": "invalid-id",
      "client_id": "client-123"
    },
    "remediation": "Verify workload_id exists in your client"
  }
}
```

### Example 4: Quota Exceeded

**Request:**
```bash
POST /api/workloads HTTP/1.1
Authorization: Bearer valid.token.here
Content-Type: application/json

{
  "name": "new-workload",
  "container_image_id": "php-8.1"
}
```

**Response:**
```json
HTTP/1.1 422 Unprocessable Entity

{
  "error": {
    "code": "MAX_WORKLOADS_EXCEEDED",
    "message": "Maximum workloads reached for your plan (10)",
    "status": 422,
    "timestamp": "2026-01-15T10:30:45.123Z",
    "request_id": "req-12345-abcde",
    "details": {
      "limit": 10,
      "current": 10,
      "plan": "starter"
    },
    "remediation": "Upgrade plan or delete unused workloads"
  }
}
```

---

## Error Handling in Code

### Node.js/Fastify Implementation

```typescript
// utils/errors.ts

export class ApiError extends Error {
  constructor(
    public code: string,
    public message: string,
    public status: number,
    public details?: Record<string, any>,
    public remediation?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const createError = (
  code: string,
  message: string,
  status: number,
  details?: Record<string, any>,
  remediation?: string
): ApiError => {
  return new ApiError(code, message, status, details, remediation);
};

// errors/definitions.ts

export const ERROR_CODES = {
  INVALID_CREDENTIALS: createError(
    'INVALID_CREDENTIALS',
    'Invalid email or password',
    401,
    {},
    'Verify email and password'
  ),
  WORKLOAD_NOT_FOUND: (id: string) => createError(
    'WORKLOAD_NOT_FOUND',
    `Workload '${id}' not found`,
    404,
    { workload_id: id },
    'Verify workload_id exists in your client'
  ),
  MAX_WORKLOADS_EXCEEDED: (limit: number, current: number) => createError(
    'MAX_WORKLOADS_EXCEEDED',
    `Maximum workloads reached for your plan (${limit})`,
    422,
    { limit, current },
    'Upgrade plan or delete unused workloads'
  ),
};

// middleware/errorHandler.ts

app.setErrorHandler((error, request, reply) => {
  const requestId = request.id || generateRequestId();

  if (error instanceof ApiError) {
    return reply.status(error.status).send({
      error: {
        code: error.code,
        message: error.message,
        status: error.status,
        timestamp: new Date().toISOString(),
        request_id: requestId,
        details: error.details,
        remediation: error.remediation
      }
    });
  }

  // Unexpected error
  app.log.error(error);
  return reply.status(500).send({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred',
      status: 500,
      timestamp: new Date().toISOString(),
      request_id: requestId
    }
  });
});

// Usage in route handler

app.get('/api/workloads/:id', async (request, reply) => {
  const workload = await db.workloads.findOne({
    id: request.params.id,
    client_id: request.user.tenant_id
  });

  if (!workload) {
    throw ERROR_CODES.WORKLOAD_NOT_FOUND(request.params.id);
  }

  return workload;
});
```

### React/Frontend Error Handling

```typescript
// hooks/useApi.ts

interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    status: number;
    remediation?: string;
  };
}

const useApi = <T,>(endpoint: string) => {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiErrorResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const request = async (options?: RequestInit) => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(endpoint, options);
      const body = await response.json();

      if (!response.ok) {
        setError(body as ApiErrorResponse);
        return;
      }

      setData(body as T);
    } catch (err) {
      setError({
        error: {
          code: 'NETWORK_ERROR',
          message: 'Network error occurred',
          status: 0
        }
      });
    } finally {
      setLoading(false);
    }
  };

  return { data, error, loading, request };
};

// Component using error handling

function WorkloadForm() {
  const { error, request } = useApi('/api/workloads');

  const handleSubmit = async (formData: any) => {
    await request({
      method: 'POST',
      body: JSON.stringify(formData)
    });

    if (error) {
      // Display user-friendly error message
      switch (error.error.code) {
        case 'MAX_WORKLOADS_EXCEEDED':
          return <Alert>Upgrade your plan to add more workloads</Alert>;
        case 'INVALID_FIELD_FORMAT':
          return <Alert>Please check your form inputs</Alert>;
        default:
          return <Alert>{error.error.message}</Alert>;
      }
    }
  };

  return <form onSubmit={handleSubmit}>...</form>;
}
```

---

## Error Monitoring & Alerting

### Sentry Integration

```typescript
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1.0,
  beforeSend(event, hint) {
    // Don't send 4xx client errors to Sentry (expected errors)
    if (hint.originalException instanceof ApiError) {
      if (hint.originalException.status < 500) {
        return null; // Don't send
      }
    }
    return event;
  }
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof ApiError && error.status >= 500) {
    Sentry.captureException(error, { tags: { code: error.code } });
  }
  // ... handle error
});
```

### Error Dashboard Metrics

Track error codes by frequency:

```
Top Errors (last 24h):
1. INVALID_CREDENTIALS: 523 (42%)
2. WORKLOAD_NOT_FOUND: 234 (19%)
3. INVALID_FIELD_FORMAT: 189 (15%)
4. QUOTA_EXCEEDED: 156 (12%)
5. INSUFFICIENT_PERMISSIONS: 89 (7%)
6. KUBERNETES_CLUSTER_UNAVAILABLE: 34 (3%)
7. DATABASE_CONNECTION_FAILED: 12 (1%)
```

---

## Testing Error Scenarios

```typescript
describe('Error Handling', () => {
  it('should return 404 for non-existent workload', async () => {
    const res = await supertest(app)
      .get('/api/workloads/non-existent-id')
      .set('Authorization', `Bearer ${validToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('WORKLOAD_NOT_FOUND');
    expect(res.body.error.remediation).toBeDefined();
  });

  it('should return 400 for invalid email', async () => {
    const res = await supertest(app)
      .post('/api/clients')
      .set('Authorization', `Bearer ${validToken}`)
      .send({
        company_name: 'Test',
        company_email: 'invalid-email'
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_EMAIL');
  });

  it('should return 422 when quota exceeded', async () => {
    // Create 10 workloads (plan max)
    for (let i = 0; i < 10; i++) {
      await createWorkload();
    }

    // Try to create 11th
    const res = await supertest(app)
      .post('/api/workloads')
      .set('Authorization', `Bearer ${validToken}`)
      .send(validWorkloadData);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MAX_WORKLOADS_EXCEEDED');
  });
});
```

---

## Checklist for Implementation

- [ ] Define all error codes in constants file
- [ ] Implement error response middleware
- [ ] Add request ID generation for tracing
- [ ] Add Sentry/error tracking integration
- [ ] Create error documentation for API clients
- [ ] Add error handling tests for all major scenarios
- [ ] Set up error monitoring dashboard
- [ ] Document error codes in OpenAPI spec
- [ ] Create troubleshooting guide for common errors
- [ ] Set up alerts for 5xx errors

---

## References

- REST API Error Handling Best Practices: https://www.rfc-editor.org/rfc/rfc7231
- Problem Details for HTTP APIs: https://tools.ietf.org/html/rfc7807
- HTTP Status Codes: https://httpwg.org/specs/rfc7231.html#status.codes
