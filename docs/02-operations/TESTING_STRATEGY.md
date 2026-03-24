# Testing Strategy & Quality Assurance

**Status:** Pre-Phase 1 Planning  
**Last Updated:** March 3, 2026  
**Owner:** QA & Engineering Team

## Overview

Comprehensive testing ensures:
- **Reliability** - Code works as designed
- **Regression Prevention** - Fixes stay fixed
- **Performance** - Fast API responses, good UX
- **Security** - Vulnerabilities detected early
- **Confidence** - Safe deployments

---

## Test Pyramid

```
                △
               /\
              /  \     End-to-End (5%)
             /    \    - Full user workflows
            /      \   - Real browser/API
           /________\
           /\        \
          /  \        \    Integration (15%)
         /    \        \   - Service integration
        /      \        \  - Database tests
       /________\________\
       /\                 \
      /  \                 \    Unit (80%)
     /    \                 \   - Individual functions
    /      \                 \  - Fast & isolated
   /________\________\________\
```

---

## Test Coverage Targets

### Code Coverage

| Component | Target | Minimum |
| --- | --- | --- |
| **Backend API** | 85% | 75% |
| **Frontend UI** | 75% | 60% |
| **Utilities** | 90% | 85% |
| **Database** | 80% | 70% |
| **Overall** | 82% | 75% |

### Coverage Tools

```bash
# Backend (Node.js/Jest)
npm run test:coverage
# Output: Coverage threshold at 75% (fail if below)

# Frontend (React/Vitest)
npm run test:coverage:ui
# Output: HTML report in coverage/index.html

# Combined report
npm run test:all:coverage
```

---

## Unit Testing

### Backend Unit Tests (Jest)

```typescript
// services/__tests__/workload.service.test.ts

describe('WorkloadService', () => {
  describe('createWorkload', () => {
    it('should create workload with valid input', async () => {
      const input = {
        name: 'my-app',
        containerImageId: 'php-8.1',
        clientId: 'client-123'
      };

      const workload = await workloadService.create(input);

      expect(workload).toEqual(expect.objectContaining({
        name: 'my-app',
        status: 'pending'
      }));
      expect(workload.id).toBeDefined();
    });

    it('should reject duplicate workload name', async () => {
      await workloadService.create({
        name: 'my-app',
        containerImageId: 'php-8.1',
        clientId: 'client-123'
      });

      await expect(
        workloadService.create({
          name: 'my-app',
          containerImageId: 'nodejs-18',
          clientId: 'client-123'
        })
      ).rejects.toThrow('Workload already exists');
    });

    it('should enforce quota limits', async () => {
      // Create 10 workloads (plan max for starter)
      for (let i = 0; i < 10; i++) {
        await workloadService.create({
          name: `app-${i}`,
          containerImageId: 'php-8.1',
          clientId: 'client-123'
        });
      }

      // 11th should fail
      await expect(
        workloadService.create({
          name: 'app-11',
          containerImageId: 'php-8.1',
          clientId: 'client-123'
        })
      ).rejects.toThrow('MAX_WORKLOADS_EXCEEDED');
    });

    it('should validate container image exists', async () => {
      await expect(
        workloadService.create({
          name: 'my-app',
          containerImageId: 'invalid-image',
          clientId: 'client-123'
        })
      ).rejects.toThrow('Container image not found');
    });
  });

  describe('deleteWorkload', () => {
    it('should prevent deletion of running workload', async () => {
      const workload = await workloadService.create({...});
      
      await expect(
        workloadService.delete(workload.id, 'client-123')
      ).rejects.toThrow('Cannot delete running workload');
    });

    it('should allow deletion of stopped workload', async () => {
      const workload = await workloadService.create({...});
      await workloadService.stop(workload.id);

      await workloadService.delete(workload.id, 'client-123');
      
      const deleted = await workloadService.get(workload.id, 'client-123');
      expect(deleted).toBeUndefined();
    });
  });
});
```

### Frontend Unit Tests (Vitest)

```typescript
// components/__tests__/WorkloadCard.test.tsx

import { render, screen } from '@testing-library/react';
import { WorkloadCard } from '../WorkloadCard';

describe('WorkloadCard', () => {
  it('should render workload name', () => {
    const workload = {
      id: 'workload-1',
      name: 'My App',
      status: 'running'
    };

    render(<WorkloadCard workload={workload} />);
    expect(screen.getByText('My App')).toBeInTheDocument();
  });

  it('should show status badge', () => {
    const workload = {
      id: 'workload-1',
      name: 'My App',
      status: 'running'
    };

    render(<WorkloadCard workload={workload} />);
    expect(screen.getByText('running')).toHaveClass('badge-success');
  });

  it('should disable delete button when running', () => {
    const workload = {
      id: 'workload-1',
      name: 'My App',
      status: 'running'
    };

    render(<WorkloadCard workload={workload} />);
    expect(screen.getByRole('button', { name: /delete/i })).toBeDisabled();
  });

  it('should enable delete button when stopped', () => {
    const workload = {
      id: 'workload-1',
      name: 'My App',
      status: 'stopped'
    };

    render(<WorkloadCard workload={workload} />);
    expect(screen.getByRole('button', { name: /delete/i })).not.toBeDisabled();
  });
});
```

---

## Integration Testing

### API Integration Tests

```typescript
// api/__tests__/workloads.integration.test.ts

import supertest from 'supertest';
import { app } from '../../app';

const request = supertest(app);

describe('Workloads API', () => {
  let validToken: string;
  let clientId: string;

  beforeAll(async () => {
    // Setup: Create test client and auth
    const res = await request
      .post('/auth/login')
      .send({
        email: 'test@example.com',
        password: 'password123'
      });
    validToken = res.body.token;
  });

  describe('POST /api/workloads', () => {
    it('should create workload with valid input', async () => {
      const res = await request
        .post('/api/workloads')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          name: 'my-app',
          containerImageId: 'php-8.1'
        });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body.name).toBe('my-app');
    });

    it('should return 400 for invalid input', async () => {
      const res = await request
        .post('/api/workloads')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          containerImageId: 'php-8.1'
          // Missing name
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('MISSING_REQUIRED_FIELD');
    });

    it('should return 401 without token', async () => {
      const res = await request
        .post('/api/workloads')
        .send({ name: 'my-app', containerImageId: 'php-8.1' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('MISSING_BEARER_TOKEN');
    });
  });

  describe('GET /api/workloads', () => {
    it('should list paginated workloads', async () => {
      // Create multiple workloads
      for (let i = 0; i < 25; i++) {
        await request
          .post('/api/workloads')
          .set('Authorization', `Bearer ${validToken}`)
          .send({ name: `app-${i}`, containerImageId: 'php-8.1' });
      }

      // Fetch first page
      const res = await request
        .get('/api/workloads?limit=20')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(20);
      expect(res.body.pagination.has_more).toBe(true);
      expect(res.body.pagination.cursor).toBeDefined();

      // Fetch second page
      const res2 = await request
        .get(`/api/workloads?limit=20&cursor=${res.body.pagination.cursor}`)
        .set('Authorization', `Bearer ${validToken}`);

      expect(res2.status).toBe(200);
      expect(res2.body.data).toHaveLength(5);
      expect(res2.body.pagination.has_more).toBe(false);
    });
  });
});
```

### Database Integration Tests

```typescript
// database/__tests__/clients.test.ts

describe('Clients Database', () => {
  let db: Database;

  beforeAll(async () => {
    db = await setupTestDatabase();
  });

  afterEach(async () => {
    await db.clients.deleteMany({});
  });

  it('should create and retrieve client', async () => {
    const client = await db.clients.create({
      companyName: 'Test Corp',
      companyEmail: 'admin@testcorp.local',
      planId: 'starter',
      regionId: 'us-east-1'
    });

    const retrieved = await db.clients.findById(client.id);
    expect(retrieved).toEqual(client);
  });

  it('should enforce unique constraint on namespace', async () => {
    await db.clients.create({
      companyName: 'Test Corp 1',
      companyEmail: 'admin@testcorp1.local',
      planId: 'starter',
      regionId: 'us-east-1',
      namespace: 'testcorp'
    });

    await expect(
      db.clients.create({
        companyName: 'Test Corp 2',
        companyEmail: 'admin@testcorp2.local',
        planId: 'starter',
        regionId: 'us-east-1',
        namespace: 'testcorp'  // Duplicate namespace
      })
    ).rejects.toThrow('ER_DUP_ENTRY');
  });

  it('should handle concurrent updates', async () => {
    const client = await db.clients.create({...});

    const updates = await Promise.all([
      db.clients.update(client.id, { companyName: 'Name 1' }),
      db.clients.update(client.id, { companyName: 'Name 2' })
    ]);

    // Last update wins
    const final = await db.clients.findById(client.id);
    expect(final.companyName).toBe('Name 2');
  });
});
```

---

## End-to-End (E2E) Testing

### Cypress E2E Tests

```typescript
// cypress/e2e/workload-management.cy.ts

describe('Workload Management', () => {
  beforeEach(() => {
    // Login before each test
    cy.visit('/');
    cy.get('[data-testid=login-email]').type('admin@example.com');
    cy.get('[data-testid=login-password]').type('password123');
    cy.get('[data-testid=login-button]').click();
    cy.url().should('include', '/dashboard');
  });

  it('should create, start, and delete a workload', () => {
    // Navigate to workloads
    cy.get('[data-testid=sidebar-workloads]').click();
    cy.get('[data-testid=workload-list]').should('exist');

    // Create new workload
    cy.get('[data-testid=btn-create-workload]').click();
    cy.get('[data-testid=input-workload-name]').type('test-app');
    cy.get('[data-testid=select-container-image]').select('php-8.1');
    cy.get('[data-testid=btn-create]').click();

    // Verify workload created
    cy.get('[data-testid=alert-success]')
      .should('contain', 'Workload created successfully');
    cy.get('[data-testid=workload-card-test-app]').should('exist');

    // Start workload
    cy.get('[data-testid=workload-card-test-app]')
      .find('[data-testid=btn-start]')
      .click();
    cy.get('[data-testid=modal-confirm]').click();

    // Verify status changed to running
    cy.get('[data-testid=workload-card-test-app]')
      .find('[data-testid=status-badge]')
      .should('contain', 'running');

    // Stop and delete
    cy.get('[data-testid=workload-card-test-app]')
      .find('[data-testid=btn-stop]')
      .click();
    cy.get('[data-testid=modal-confirm]').click();

    cy.get('[data-testid=workload-card-test-app]')
      .find('[data-testid=btn-delete]')
      .click();
    cy.get('[data-testid=modal-confirm]').click();

    cy.get('[data-testid=workload-card-test-app]').should('not.exist');
  });

  it('should handle authentication errors', () => {
    cy.visit('/');
    cy.get('[data-testid=login-email]').type('invalid@example.com');
    cy.get('[data-testid=login-password]').type('wrongpassword');
    cy.get('[data-testid=login-button]').click();

    cy.get('[data-testid=alert-error]')
      .should('contain', 'Invalid email or password');
  });
});
```

---

## Performance Testing

### Load Testing (k6)

```javascript
// tests/load/workloads.js

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 20 },   // Ramp up to 20 users
    { duration: '1m30s', target: 100 }, // Ramp up to 100 users
    { duration: '1m', target: 100 },    // Hold at 100 users
    { duration: '30s', target: 0 },     // Ramp down to 0
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1500'],
    http_req_failed: ['rate<0.1'],
  },
};

export default function () {
  // List workloads
  const res = http.get('http://localhost:3000/api/workloads', {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
    },
  });

  check(res, {
    'status 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
    'has pagination': (r) => r.json().pagination !== undefined,
  });

  sleep(1);

  // Create workload
  const createRes = http.post(
    'http://localhost:3000/api/workloads',
    {
      name: `workload-${Date.now()}`,
      containerImageId: 'php-8.1',
    },
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );

  check(createRes, {
    'create status 201': (r) => r.status === 201,
    'workload created': (r) => r.json().id !== undefined,
  });
}
```

### Run Performance Tests

```bash
# Install k6
brew install k6

# Run load test
k6 run tests/load/workloads.js

# Output:
# http_req_duration: avg=245ms, p(95)=450ms, p(99)=890ms
# http_req_failed: 0%
```

---

## Security Testing

### OWASP Top 10 Tests

```typescript
describe('Security Tests', () => {
  describe('SQL Injection Prevention', () => {
    it('should handle malicious SQL in input', async () => {
      const res = await request
        .get('/api/workloads?filter[name]="; DROP TABLE workloads; --')
        .set('Authorization', `Bearer ${validToken}`);

      expect(res.status).toBe(200); // Should not execute SQL
      expect(res.body.data).toBeDefined();
    });
  });

  describe('Cross-Site Scripting (XSS) Prevention', () => {
    it('should escape HTML in responses', async () => {
      const res = await request
        .post('/api/workloads')
        .set('Authorization', `Bearer ${validToken}`)
        .send({
          name: '<script>alert("xss")</script>',
          containerImageId: 'php-8.1'
        });

      // Verify script tags are escaped
      expect(res.body.name).not.toContain('<script>');
      expect(res.body.name).toContain('&lt;script&gt;');
    });
  });

  describe('CSRF Protection', () => {
    it('should reject requests without CSRF token', async () => {
      const res = await request
        .post('/api/workloads')
        .send({ name: 'test', containerImageId: 'php-8.1' });

      expect(res.status).toBe(401); // No auth header
    });
  });

  describe('Rate Limiting', () => {
    it('should rate limit excessive requests', async () => {
      for (let i = 0; i < 150; i++) {
        const res = await request
          .get('/api/workloads')
          .set('Authorization', `Bearer ${validToken}`);

        if (i < 100) {
          expect([200, 204]).toContain(res.status);
        } else {
          expect(res.status).toBe(429); // Too many requests
        }
      }
    });
  });
});
```

---

## Accessibility Testing

### axe-core Accessibility Tests

```typescript
// axe-a11y.test.ts

import { render } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

describe('Accessibility', () => {
  it('should have no accessibility violations in dashboard', async () => {
    const { container } = render(<Dashboard />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it('should have proper ARIA labels', () => {
    const { getByRole } = render(<WorkloadForm />);
    expect(getByRole('button', { name: /create/i })).toBeInTheDocument();
    expect(getByRole('textbox', { name: /name/i })).toBeInTheDocument();
  });

  it('should support keyboard navigation', async () => {
    const { getByRole } = render(<WorkloadCard workload={workload} />);
    
    // Tab to delete button
    getByRole('button', { name: /delete/i }).focus();
    expect(getByRole('button', { name: /delete/i })).toHaveFocus();

    // Enter to confirm
    fireEvent.keyDown(getByRole('button', { name: /delete/i }), { key: 'Enter' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
```

---

## Continuous Integration

### GitHub Actions Test Pipeline

```yaml
# .github/workflows/test.yml

name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      mysql:
        image: mysql:8.0
        env:
          MYSQL_ROOT_PASSWORD: password
        options: >-
          --health-cmd="mysqladmin ping"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=3

    steps:
      - uses: actions/checkout@v3

      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          cache: 'npm'

      # Unit tests
      - name: Run unit tests
        run: npm run test:unit -- --coverage

      # Integration tests
      - name: Run integration tests
        run: npm run test:integration

      # Upload coverage
      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info

      # Fail if coverage below threshold
      - name: Check coverage threshold
        run: npm run test:coverage:check
```

---

## Test Checklist

- [ ] Unit tests for all services (80%+ coverage)
- [ ] Integration tests for all API endpoints
- [ ] E2E tests for critical user workflows
- [ ] Performance tests (p95 < 500ms for list endpoints)
- [ ] Security tests (OWASP Top 10)
- [ ] Accessibility tests (WCAG 2.1 AA)
- [ ] Load tests with 100+ concurrent users
- [ ] Database migration tests
- [ ] Error scenario tests
- [ ] Authentication/authorization tests
- [ ] Rate limiting tests
- [ ] CORS configuration tests

---

## References

- Jest Documentation: https://jestjs.io/
- Vitest: https://vitest.dev/
- Cypress: https://www.cypress.io/
- k6 Load Testing: https://k6.io/
- axe Accessibility: https://www.deque.com/axe/
- OWASP Testing Guide: https://owasp.org/www-project-web-security-testing-guide/
