import { eq } from 'drizzle-orm';
import { domains } from '../../db/schema.js';
import { verifyDomain, getPlatformConfig } from './verification.js';
import { reconcileIngress } from './k8s-ingress.js';
import { getClientById } from '../clients/service.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

interface BulkResult {
  readonly succeeded: string[];
  readonly failed: ReadonlyArray<{ readonly id: string; readonly error: string }>;
}

export async function bulkVerifyDomains(
  db: Database,
  domainIds: readonly string[],
): Promise<BulkResult> {
  const succeeded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  const platformConfig = getPlatformConfig();

  for (const id of domainIds) {
    try {
      const [domain] = await db.select()
        .from(domains)
        .where(eq(domains.id, id));

      if (!domain) {
        failed.push({ id, error: `Domain '${id}' not found` });
        continue;
      }

      const dnsMode = domain.dnsMode as 'primary' | 'cname' | 'secondary';
      const result = await verifyDomain(domain.domainName, dnsMode, platformConfig, db);

      const now = new Date();
      const updateValues: Record<string, unknown> = { lastVerifiedAt: now };
      if (result.verified && !domain.verifiedAt) {
        updateValues.verifiedAt = now;
      }
      await db.update(domains).set(updateValues).where(eq(domains.id, id));

      succeeded.push(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      failed.push({ id, error: message });
    }
  }

  return { succeeded, failed };
}

export async function bulkDeleteDomains(
  db: Database,
  domainIds: readonly string[],
  k8s?: K8sClients,
): Promise<BulkResult> {
  const succeeded: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of domainIds) {
    try {
      const [domain] = await db.select()
        .from(domains)
        .where(eq(domains.id, id));

      if (!domain) {
        failed.push({ id, error: `Domain '${id}' not found` });
        continue;
      }

      await db.delete(domains).where(eq(domains.id, id));

      // Best-effort Ingress reconciliation
      if (k8s) {
        try {
          const client = await getClientById(db, domain.clientId);
          if (client.kubernetesNamespace) {
            await reconcileIngress(db, k8s, domain.clientId, client.kubernetesNamespace);
          }
        } catch {
          // Non-blocking
        }
      }

      succeeded.push(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      failed.push({ id, error: message });
    }
  }

  return { succeeded, failed };
}
