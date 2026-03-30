/**
 * cert-manager integration service.
 *
 * Creates Certificate CRDs and TLS Secrets in client namespaces.
 * Uses DNS-01 when domain has full DNS control + a configured DNS server,
 * otherwise falls back to HTTP-01.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';
import { getClusterIssuerName, isAutoTlsEnabled } from '../tls-settings/service.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CertProvisionInput {
  readonly domainName: string;
  readonly namespace: string;
  readonly dnsMode: string;
  readonly hasDnsServer: boolean;
}

export interface CertProvisionResult {
  readonly secretName: string;
  readonly issuerName: string;
  readonly challengeType: 'dns01' | 'http01';
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CERT_MANAGER_GROUP = 'cert-manager.io';
const CERT_MANAGER_VERSION = 'v1';
const CERT_MANAGER_PLURAL = 'certificates';

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
 * Determine challenge type based on domain configuration.
 * DNS-01 when the domain uses primary/secondary DNS mode and has a real DNS server.
 * HTTP-01 otherwise (CNAME mode, no DNS server).
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

// ─── Certificate CRD Management ─────────────────────────────────────────────

/**
 * Create or update a cert-manager Certificate CRD for a domain.
 */
export async function provisionCertificate(
  db: Database,
  k8s: K8sClients,
  input: CertProvisionInput,
): Promise<CertProvisionResult> {
  const autoTls = await isAutoTlsEnabled(db);
  if (!autoTls) {
    throw new Error('Automatic TLS is disabled');
  }

  const issuerName = await getClusterIssuerName(db);
  const secretName = domainToSecretName(input.domainName);
  const challengeType = determineChallengeType(input.dnsMode, input.hasDnsServer);
  const certName = secretName.replace(/-tls$/, '-cert');

  const certBody = {
    apiVersion: `${CERT_MANAGER_GROUP}/${CERT_MANAGER_VERSION}`,
    kind: 'Certificate',
    metadata: {
      name: certName,
      namespace: input.namespace,
    },
    spec: {
      secretName,
      issuerRef: {
        name: issuerName,
        kind: 'ClusterIssuer',
      },
      dnsNames: [input.domainName],
      duration: '2160h', // 90 days
      renewBefore: '360h', // 15 days before expiry
    },
  };

  try {
    await k8s.custom.createNamespacedCustomObject({
      group: CERT_MANAGER_GROUP,
      version: CERT_MANAGER_VERSION,
      namespace: input.namespace,
      plural: CERT_MANAGER_PLURAL,
      body: certBody,
    });
  } catch (err: unknown) {
    if (isK8s409(err)) {
      // Already exists — update it
      await k8s.custom.replaceNamespacedCustomObject({
        group: CERT_MANAGER_GROUP,
        version: CERT_MANAGER_VERSION,
        namespace: input.namespace,
        plural: CERT_MANAGER_PLURAL,
        name: certName,
        body: certBody,
      });
    } else {
      throw err;
    }
  }

  return { secretName, issuerName, challengeType };
}

/**
 * Delete a cert-manager Certificate CRD for a domain.
 */
export async function deleteCertificate(
  k8s: K8sClients,
  namespace: string,
  domainName: string,
): Promise<void> {
  const secretName = domainToSecretName(domainName);
  const certName = secretName.replace(/-tls$/, '-cert');

  try {
    await k8s.custom.deleteNamespacedCustomObject({
      group: CERT_MANAGER_GROUP,
      version: CERT_MANAGER_VERSION,
      namespace,
      plural: CERT_MANAGER_PLURAL,
      name: certName,
    });
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
    // Already gone — fine
  }
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
