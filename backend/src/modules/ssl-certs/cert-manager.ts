/**
 * cert-manager + TLS Secret helpers for CUSTOM UPLOADED certs.
 *
 * Phase 2c: automatic Certificate CR provisioning was moved to
 * `backend/src/modules/certificates/`. This file now handles only:
 *   - The naming helper `domainToSecretName` (shared with k8s-manifests
 *     generator and tests)
 *   - Manual TLS Secret upload path (`syncCertToK8sSecret`,
 *     `deleteK8sSecret`) for when an admin uploads their own cert + key
 *     via the ssl-certs module.
 *
 * `determineChallengeType` is kept for backwards compat with existing
 * tests but is no longer called by application code — the certificates
 * module has its own selector logic. New code should NOT use it.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function isK8s404(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return true;
  if ((err as { statusCode?: number }).statusCode === 404) return true;
  return false;
}

function isK8s409(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 409')) return true;
  if ((err as { statusCode?: number }).statusCode === 409) return true;
  return false;
}

/**
 * Generate a stable, DNS-safe secret name from a domain.
 * e.g., "example.com" -> "example-com-tls"
 *
 * Still used by:
 *   - k8s-manifests/generator.ts (for workload TLS secret resolution)
 *   - ssl-certs/service.ts (custom cert upload)
 *   - existing tests
 *
 * New code in the certificates module has its own naming via
 * `certificateNameFor` / `tlsSecretNameFor` that supports wildcards.
 */
export function domainToSecretName(domainName: string): string {
  return domainName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) + '-tls';
}

/**
 * Legacy challenge-type hint. DEPRECATED in Phase 2c — use
 * `certificates/issuer-selector.ts selectIssuerForDomain` instead,
 * which takes the full DNS provider state into account.
 *
 * Kept for backwards compat with the cert-manager.test.ts test file.
 */
export function determineChallengeType(
  dnsMode: string,
  hasDnsServer: boolean,
): 'dns01' | 'http01' {
  if (hasDnsServer && (dnsMode === 'primary' || dnsMode === 'secondary')) {
    return 'dns01';
  }
  return 'http01';
}

// ─── TLS Secret Management (for custom uploaded certs) ──────────────────────

/**
 * Create or update a Kubernetes TLS Secret from an uploaded certificate.
 * This bypasses cert-manager — the admin provides their own cert + key.
 */
export async function syncCertToK8sSecret(
  k8s: K8sClients,
  namespace: string,
  domainName: string,
  certPem: string,
  keyPem: string,
): Promise<string> {
  const secretName = domainToSecretName(domainName);

  const secretBody = {
    metadata: {
      name: secretName,
      namespace,
      labels: {
        'platform': 'k8s-hosting',
        'cert-source': 'custom-upload',
      },
    },
    type: 'kubernetes.io/tls',
    data: {
      'tls.crt': Buffer.from(certPem).toString('base64'),
      'tls.key': Buffer.from(keyPem).toString('base64'),
    },
  };

  try {
    await k8s.core.createNamespacedSecret({ namespace, body: secretBody });
  } catch (err: unknown) {
    if (isK8s409(err)) {
      await k8s.core.replaceNamespacedSecret({
        name: secretName,
        namespace,
        body: secretBody,
      });
    } else {
      throw err;
    }
  }

  return secretName;
}

/**
 * Delete a TLS Secret.
 */
export async function deleteK8sSecret(
  k8s: K8sClients,
  namespace: string,
  domainName: string,
): Promise<void> {
  const secretName = domainToSecretName(domainName);

  try {
    await k8s.core.deleteNamespacedSecret({ name: secretName, namespace });
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
  }
}
