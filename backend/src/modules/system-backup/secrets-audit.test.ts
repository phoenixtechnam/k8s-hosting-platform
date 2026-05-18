/**
 * Pure-function tests for the classifier. No K8s IO; the orchestration
 * (`runSecretsAudit`, `upsertAllowlistEntry`, etc.) is covered by the
 * integration harness scripts/integration-secrets-bundle.sh.
 */

import { describe, it, expect } from 'vitest';
import type { AllowlistEntry } from '@k8s-hosting/api-contracts';
import { classify } from './secrets-audit.js';
import { BUNDLE_SECRET_LIST } from './secrets-bundle.js';

const emptyAllowlist = new Map<string, AllowlistEntry>();
const bundleKeys = new Set(BUNDLE_SECRET_LIST.map((s) => `${s.namespace}/${s.name}`));

describe('classify', () => {
  describe('Rule 1 — denied (auto-managed)', () => {
    it('denies ServiceAccount tokens by type', () => {
      const r = classify({
        namespace: 'platform', name: 'default-token-abc',
        type: 'kubernetes.io/service-account-token',
        owner: null, bundleKeys, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('denied');
      expect(r.reason).toMatch(/ServiceAccount token/);
    });

    it('denies docker pull secrets by type', () => {
      const r = classify({
        namespace: 'platform', name: 'regcred',
        type: 'kubernetes.io/dockerconfigjson',
        owner: null, bundleKeys, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('denied');
    });

    it('denies Helm release state by name prefix', () => {
      const r = classify({
        namespace: 'kube-system', name: 'sh.helm.release.v1.cnpg.v3',
        type: 'helm.sh/release.v1',
        owner: null, bundleKeys, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('denied');
      expect(r.reason).toMatch(/Helm/);
    });

    it('denies cert-manager-issued TLS by ownerReference', () => {
      const r = classify({
        namespace: 'platform', name: 'admin-panel-tls',
        type: 'kubernetes.io/tls',
        owner: { kind: 'Certificate', apiVersion: 'cert-manager.io/v1' },
        bundleKeys, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('denied');
      expect(r.reason).toMatch(/cert-manager/);
    });

    it('denies SealedSecret unsealed copies', () => {
      const r = classify({
        namespace: 'platform', name: 'my-secret',
        type: 'Opaque',
        owner: { kind: 'SealedSecret', apiVersion: 'bitnami.com/v1alpha1' },
        bundleKeys, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('denied');
    });

    it('denies CNPG-managed cluster credentials', () => {
      const r = classify({
        namespace: 'platform', name: 'system-db-superuser',
        type: 'kubernetes.io/basic-auth',
        owner: { kind: 'Cluster', apiVersion: 'postgresql.cnpg.io/v1' },
        bundleKeys, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('denied');
    });

    it('does NOT deny a TLS secret that happens to lack a Certificate owner', () => {
      // Manually-created TLS secret without an owner should NOT be auto-denied
      // — it's a real DR risk that needs an explicit allowlist decision.
      const r = classify({
        namespace: 'platform', name: 'legacy-tls',
        type: 'kubernetes.io/tls',
        owner: null, bundleKeys, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('uncovered');
    });
  });

  describe('Rule 2 — tier-1 bundle', () => {
    it('classifies known BUNDLE_SECRET_LIST entries', () => {
      const r = classify({
        namespace: 'platform', name: 'platform-jwt-secret',
        type: 'Opaque',
        owner: null, bundleKeys, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('tier-1-bundle');
    });

    it('every BUNDLE_SECRET_LIST entry resolves to tier-1-bundle', () => {
      for (const entry of BUNDLE_SECRET_LIST) {
        const r = classify({
          namespace: entry.namespace, name: entry.name,
          type: 'Opaque',
          owner: null, bundleKeys, allowlistMap: emptyAllowlist,
        });
        expect(r.category).toBe('tier-1-bundle');
      }
    });
  });

  describe('Rule 3 — tier-2 tenant sweep', () => {
    it('classifies client-* namespace secrets', () => {
      const r = classify({
        namespace: 'client-acme-corp', name: 'wordpress-db-password',
        type: 'Opaque',
        owner: null, bundleKeys, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('tier-2-tenant-sweep');
    });

    it('does NOT match `client` (without dash) as a tenant namespace', () => {
      const r = classify({
        namespace: 'client', name: 'foo',
        type: 'Opaque',
        owner: null, bundleKeys, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('uncovered');
    });

    it('does NOT match `clients-*` (the misspelled prefix)', () => {
      const r = classify({
        namespace: 'clients-acme', name: 'foo',
        type: 'Opaque',
        owner: null, bundleKeys, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('uncovered');
    });
  });

  describe('Rule 4 — allowlisted', () => {
    it('classifies an allowlist match', () => {
      const allowlistMap = new Map<string, AllowlistEntry>([
        ['kube-system/local-path-provisioner-service-token', {
          namespace: 'kube-system',
          name: 'local-path-provisioner-service-token',
          reason: 'lifecycle-managed by k3s provisioner; recreated on bootstrap',
          addedBy: 'admin@example.com',
          addedAt: '2026-05-18T10:00:00Z',
        }],
      ]);
      const r = classify({
        namespace: 'kube-system', name: 'local-path-provisioner-service-token',
        type: 'Opaque',
        owner: null, bundleKeys, allowlistMap,
      });
      expect(r.category).toBe('allowlisted');
      expect(r.reason).toMatch(/lifecycle-managed/);
    });
  });

  describe('Rule 5 — uncovered (the silent-DR-risk case)', () => {
    it('flags a manually-created platform secret with no match', () => {
      const r = classify({
        namespace: 'platform', name: 'some-new-feature-creds',
        type: 'Opaque',
        owner: null, bundleKeys, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('uncovered');
      expect(r.reason).toMatch(/extend bundle or add to allowlist/);
    });

    it('flags a Secret in a non-tenant namespace even when owner kind is Pod', () => {
      const r = classify({
        namespace: 'monitoring', name: 'grafana-api-key',
        type: 'Opaque',
        owner: { kind: 'Pod', apiVersion: 'v1' },
        bundleKeys, allowlistMap: emptyAllowlist,
      });
      expect(r.category).toBe('uncovered');
    });
  });

  describe('priority — denied beats allowlisted beats bundle', () => {
    it('denied wins over allowlisted (SA token always denied even if allowlisted)', () => {
      const allowlistMap = new Map<string, AllowlistEntry>([
        ['kube-system/default-token', {
          namespace: 'kube-system', name: 'default-token',
          reason: 'forgot why', addedBy: 'op', addedAt: '2026-05-18T10:00:00Z',
        }],
      ]);
      const r = classify({
        namespace: 'kube-system', name: 'default-token',
        type: 'kubernetes.io/service-account-token',
        owner: null, bundleKeys, allowlistMap,
      });
      expect(r.category).toBe('denied');
    });
  });
});
