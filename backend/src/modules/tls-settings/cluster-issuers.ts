/**
 * List cert-manager ClusterIssuers so the Admin Panel can render a
 * dropdown instead of a free-text input.
 *
 * Runs against the in-cluster k8s API via the same client we use for
 * ingress reconciliation. If the API call fails (RBAC, connectivity,
 * cert-manager not installed) we return an empty list — the UI falls
 * back to a plain text input rather than breaking the page.
 */

import * as k8s from '@kubernetes/client-node';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';

export interface ClusterIssuerInfo {
  readonly name: string;
  readonly ready: boolean;
}

interface ClusterIssuerListItem {
  metadata?: { name?: string };
  status?: {
    conditions?: Array<{ type?: string; status?: string }>;
  };
}

interface ClusterIssuerList {
  items?: ClusterIssuerListItem[];
}

export async function listClusterIssuers(
  kubeconfigPath?: string,
): Promise<ClusterIssuerInfo[]> {
  try {
    const clients = createK8sClients(kubeconfigPath);
    const res = await clients.custom.listClusterCustomObject({
      group: 'cert-manager.io',
      version: 'v1',
      plural: 'clusterissuers',
    }) as unknown as ClusterIssuerList;

    if (!Array.isArray(res.items)) return [];

    return res.items
      .map((item): ClusterIssuerInfo | null => {
        const name = item.metadata?.name;
        if (!name) return null;
        const ready =
          item.status?.conditions?.some(
            (c) => c.type === 'Ready' && c.status === 'True',
          ) ?? false;
        return { name, ready };
      })
      .filter((x): x is ClusterIssuerInfo => x !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    // Swallow and let the UI fall back to free-text — the underlying
    // reason (no cert-manager, no RBAC, etc.) is logged elsewhere.
    if (err instanceof k8s.ApiException) {
      // eslint-disable-next-line no-console
      console.warn('[cluster-issuers] k8s API error:', err.code, err.body);
    } else if (err instanceof Error) {
      // eslint-disable-next-line no-console
      console.warn('[cluster-issuers] error:', err.message);
    }
    return [];
  }
}
