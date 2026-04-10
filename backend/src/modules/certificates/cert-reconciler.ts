/**
 * Certificate status reconciler.
 *
 * Runs every 60 seconds (registered from app.ts alongside the deployment
 * status reconciler). For each domain with `sslAutoRenew = 1` it:
 *
 *   1. Reads the TLS Secret created by cert-manager (wildcard first, then
 *      per-hostname) in the client's kubernetesNamespace.
 *   2. Parses the X.509 certificate from the Secret to extract issuer,
 *      subject, and expiry.
 *   3. Upserts a row into `ssl_certificates` so the admin/client panels
 *      can display real certificate status without live K8s queries on
 *      every page load.
 *
 * Design notes:
 *   - The reconciler never overwrites `certificate` / `privateKeyEncrypted`
 *     for rows that already exist — those fields are only meaningful for
 *     manually uploaded certs (via ssl-certs/service.ts). For cert-manager
 *     managed rows the actual PEM lives in the K8s Secret; the DB row
 *     stores a sentinel placeholder.
 *   - If no TLS Secret exists yet (cert still pending), the reconciler
 *     skips the domain — the UI falls back to "Pending" from the
 *     enrichment logic.
 */

import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { domains, sslCertificates, clients } from '../../db/schema.js';
import { tlsSecretNameFor } from './service.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// ─── K8s error helpers ──────────────────────────────────────────────────────

function k8sStatusCode(err: unknown): number | undefined {
  const e = err as { statusCode?: number; response?: { statusCode?: number } };
  if (typeof e?.statusCode === 'number') return e.statusCode;
  if (typeof e?.response?.statusCode === 'number') return e.response.statusCode;
  if (err instanceof Error) {
    const m = err.message.match(/HTTP-Code:\s*(\d{3})/);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}

function isK8s404(err: unknown): boolean {
  return k8sStatusCode(err) === 404;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface CertReconcileResult {
  readonly checked: number;
  readonly synced: number;
  readonly errors: readonly string[];
}

export async function reconcileCertificateStatuses(
  db: Database,
  k8s: K8sClients,
): Promise<CertReconcileResult> {
  // Get all domains with auto-TLS enabled, joined with their client's namespace
  const domainsWithClients = await db
    .select({
      domainId: domains.id,
      domainName: domains.domainName,
      clientId: domains.clientId,
      namespace: clients.kubernetesNamespace,
    })
    .from(domains)
    .innerJoin(clients, eq(domains.clientId, clients.id))
    .where(eq(domains.sslAutoRenew, 1));

  let checked = 0;
  let synced = 0;
  const errors: string[] = [];

  for (const d of domainsWithClients) {
    if (!d.namespace) continue;
    checked++;

    try {
      // Try to read the TLS secret for this domain.
      // Wildcard first (covers apex + all immediate subdomains), then
      // per-hostname as fallback (HTTP-01 mode).
      const wildcardSecretName = tlsSecretNameFor(d.domainName, true);
      const perHostSecretName = tlsSecretNameFor(d.domainName, false);

      let secretData: Record<string, string> | undefined;
      let isWildcard = false;

      for (const [name, wc] of [[wildcardSecretName, true], [perHostSecretName, false]] as const) {
        try {
          const result = await k8s.core.readNamespacedSecret({
            name,
            namespace: d.namespace,
          });
          if (result?.data?.['tls.crt']) {
            secretData = result.data;
            isWildcard = wc;
            break;
          }
        } catch (err: unknown) {
          if (!isK8s404(err)) throw err;
          // 404 = secret doesn't exist yet, try next variant
        }
      }

      if (!secretData?.['tls.crt']) {
        // No TLS secret found — cert is still pending or not provisioned.
        // Don't write anything to DB — the badge will show "Pending" from
        // the enrichment logic.
        continue;
      }

      // Decode the base64 PEM cert and extract metadata via Node's
      // built-in X509Certificate API.
      const pemB64 = secretData['tls.crt'];
      const pem = Buffer.from(pemB64, 'base64').toString('utf8');

      let issuer = 'Unknown';
      let subject = d.domainName;
      let expiresAt: Date | null = null;

      try {
        const x509 = new crypto.X509Certificate(pem);
        issuer =
          x509.issuer
            .split('\n')
            .find((l) => l.startsWith('O='))
            ?.replace('O=', '') ?? x509.issuer;
        subject =
          x509.subject
            .split('\n')
            .find((l) => l.startsWith('CN='))
            ?.replace('CN=', '') ?? d.domainName;
        expiresAt = new Date(x509.validTo);
      } catch {
        // PEM parsing failed — still write the row with defaults
      }

      // Upsert into ssl_certificates
      const [existing] = await db
        .select({ id: sslCertificates.id })
        .from(sslCertificates)
        .where(eq(sslCertificates.domainId, d.domainId));

      const now = new Date();

      if (existing) {
        await db
          .update(sslCertificates)
          .set({
            issuer,
            subject: isWildcard ? `*.${d.domainName}` : subject,
            expiresAt,
            updatedAt: now,
            // Don't overwrite certificate/privateKeyEncrypted — those are
            // only for manually uploaded certs
          })
          .where(eq(sslCertificates.id, existing.id));
      } else {
        await db.insert(sslCertificates).values({
          id: crypto.randomUUID(),
          domainId: d.domainId,
          clientId: d.clientId,
          // Store a placeholder — the actual cert is in the K8s Secret
          certificate: '# Managed by cert-manager',
          privateKeyEncrypted: '# Managed by cert-manager',
          issuer,
          subject: isWildcard ? `*.${d.domainName}` : subject,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        });
      }
      synced++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${d.domainName}: ${msg}`);
    }
  }

  return { checked, synced, errors };
}
