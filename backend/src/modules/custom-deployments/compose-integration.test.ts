// Integration-shaped test: parser → validator pipeline.
// Confirms that a realistic two-service compose stack parses cleanly,
// the validator (with singleServiceOnly=false) accepts it, and the
// resulting customSpec carries the right depends_on / healthcheck /
// volume wiring the deployer will consume.
//
// Does NOT exercise the k8s deployer — that's covered by the
// existing PR-2 tests plus the planned integration-staging.sh
// E2E harness (PR-5).

import { describe, it, expect } from 'vitest';
import { parseCompose } from './compose-parser.js';
import { validateCustomSpec } from './validator.js';

const COMPOSE = `
services:
  web:
    image: nginx:1.27
    ports:
      - "80"
    depends_on:
      - api
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost"]
      interval: 5s
      timeout: 2s
      retries: 3
    volumes:
      - "html:/usr/share/nginx/html:ro"
  api:
    image: ghcr.io/owner/api:v1.2
    ports:
      - "3000"
    environment:
      DATABASE_URL: postgres://db:5432/app
    depends_on:
      - db
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:3000/healthz"]
  db:
    image: postgres:16
    ports:
      - target: 5432
        protocol: tcp
    environment:
      POSTGRES_PASSWORD: hunter2
    volumes:
      - "data:/var/lib/postgresql/data"
    restart: always
volumes:
  html: {}
  data: {}
`;

describe('compose pipeline — multi-service stack', () => {
  it('parses cleanly', () => {
    const r = parseCompose({ composeYaml: COMPOSE });
    expect(r.spec).not.toBeNull();
    const errors = r.issues.filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
    expect(Object.keys(r.spec!.services)).toEqual(['web', 'api', 'db']);
  });

  it('validates with singleServiceOnly=false', () => {
    const r = parseCompose({ composeYaml: COMPOSE });
    const v = validateCustomSpec(r.spec!, {
      callerRole: 'client_admin',
      warnUnpinnedTags: true,
      singleServiceOnly: false,
      deploymentName: 'webapp',
    });
    expect(v.ok).toBe(true);
  });

  it('preserves depends_on DAG', () => {
    const r = parseCompose({ composeYaml: COMPOSE });
    expect(r.spec!.services.web.dependsOn).toEqual(['api']);
    expect(r.spec!.services.api.dependsOn).toEqual(['db']);
    expect(r.spec!.services.db.dependsOn).toEqual([]);
  });

  it('produces healthCheck of type exec for both CMD and CMD-SHELL forms', () => {
    const r = parseCompose({ composeYaml: COMPOSE });
    expect(r.spec!.services.web.healthCheck?.type).toBe('exec');
    expect(r.spec!.services.api.healthCheck?.type).toBe('exec');
  });

  it('reports a depends_on cycle as an error', () => {
    const cyclic = `
services:
  a:
    image: x:1
    depends_on: [b]
  b:
    image: x:1
    depends_on: [a]
`;
    const r = parseCompose({ composeYaml: cyclic });
    const v = validateCustomSpec(r.spec!, {
      callerRole: 'client_admin',
      warnUnpinnedTags: false,
      singleServiceOnly: false,
    });
    expect(v.ok).toBe(false);
    expect(v.issues.find((i) => i.code === 'DEPENDS_ON_CYCLE')).toBeDefined();
  });

  it('caps ingress-eligible ports across all services at 1 (Phase 1)', () => {
    // The compose parser sets ingressEligible=false by default for
    // every port. A future UI flow will mark one port as eligible
    // post-parse; until then no compose deploy trips the cap.
    const r = parseCompose({ composeYaml: COMPOSE });
    const ingressCount = Object.values(r.spec!.services)
      .flatMap((s) => s.ports.filter((p) => p.ingressEligible))
      .length;
    expect(ingressCount).toBe(0);
  });
});
