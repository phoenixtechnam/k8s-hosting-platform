import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://admin.k8s-platform.test:2010';

// Custom metrics
const errorRate = new Rate('errors');
const loginDuration = new Trend('login_duration');

export const options = {
  stages: [
    { duration: '10s', target: 5 },   // Ramp up to 5 users
    { duration: '30s', target: 10 },   // Stay at 10 users
    { duration: '10s', target: 0 },    // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],  // 95% of requests under 500ms
    errors: ['rate<0.01'],              // Error rate under 1%
  },
};

let authToken = '';

export function setup() {
  const loginRes = http.post(`${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: 'admin@k8s-platform.test', password: 'admin' }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  const body = JSON.parse(loginRes.body);
  loginDuration.add(loginRes.timings.duration);
  return { token: body.data.token };
}

export default function(data) {
  const headers = {
    'Authorization': `Bearer ${data.token}`,
    'Content-Type': 'application/json',
  };

  // Test mix of endpoints
  const endpoints = [
    { name: 'status', path: '/api/v1/admin/status', cached: true },
    { name: 'dashboard', path: '/api/v1/admin/dashboard', cached: true },
    { name: 'clients', path: '/api/v1/clients?limit=20' },
    { name: 'plans', path: '/api/v1/plans', cached: true },
    { name: 'regions', path: '/api/v1/regions', cached: true },
    { name: 'container-images', path: '/api/v1/container-images', cached: true },
    { name: 'audit-logs', path: '/api/v1/admin/audit-logs?limit=10' },
    { name: 'admin-domains', path: '/api/v1/admin/domains?limit=20' },
  ];

  const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];

  const res = http.get(`${BASE_URL}${endpoint.path}`, { headers, tags: { name: endpoint.name } });

  const success = check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });

  errorRate.add(!success);
  sleep(0.5);
}
