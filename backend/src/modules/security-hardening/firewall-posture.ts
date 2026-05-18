/**
 * Composes the FirewallPosture from probe-reported public ports +
 * counts of the existing ClusterTrustedRange / ClusterPendingPeer CRs.
 *
 * Counts are split into v4/v6 buckets by inspecting the
 * `status.family` field the firewall-reconciler writes on each CR.
 */

import type { CustomObjectsApi } from '@kubernetes/client-node';
import {
  type FirewallPosture,
  type PublicPortsPerNode,
  type DeniedCountWindow,
  type FirewallMode,
} from '@k8s-hosting/api-contracts';

const CRD_GROUP = 'networking.platform.phoenix-host.net';
const CRD_VERSION = 'v1alpha1';
const CTR_PLURAL = 'clustertrustedranges';
const CPP_PLURAL = 'clusterpendingpeers';

interface CrShape {
  readonly status?: { readonly family?: 'v4' | 'v6' };
}

interface CrList {
  readonly items?: ReadonlyArray<CrShape>;
}

export interface FirewallPostureInputs {
  /** From the probe — per-node public TCP/UDP ports inferred from
   *  /etc/hosting-platform/firewall.conf. */
  readonly publicPortsPerNode: ReadonlyArray<PublicPortsPerNode>;
}

/** Default denied-count window we report when no probe ran yet OR
 *  when the operator hasn't enabled conntrack scraping. */
export const DEFAULT_DENIED_WINDOW: DeniedCountWindow = {
  available: false,
  denies: null,
  windowSeconds: 60,
  reason: 'no probe report yet',
};

export async function buildFirewallPosture(
  custom: CustomObjectsApi,
  inputs: FirewallPostureInputs,
  mode: FirewallMode = 'set',
  deniedWindow: DeniedCountWindow = DEFAULT_DENIED_WINDOW,
): Promise<FirewallPosture> {
  const [ctr, cpp] = await Promise.all([
    custom
      .listClusterCustomObject({ group: CRD_GROUP, version: CRD_VERSION, plural: CTR_PLURAL })
      .then((res) => res as CrList)
      .catch(() => ({ items: [] }) as CrList),
    custom
      .listClusterCustomObject({ group: CRD_GROUP, version: CRD_VERSION, plural: CPP_PLURAL })
      .then((res) => res as CrList)
      .catch(() => ({ items: [] }) as CrList),
  ]);

  const ctrItems = ctr.items ?? [];
  const cppItems = cpp.items ?? [];

  return {
    mode,
    clusterPeersV4Count: cppItems.filter((c) => c.status?.family === 'v4').length,
    clusterPeersV6Count: cppItems.filter((c) => c.status?.family === 'v6').length,
    trustedRangesV4Count: ctrItems.filter((c) => c.status?.family === 'v4').length,
    trustedRangesV6Count: ctrItems.filter((c) => c.status?.family === 'v6').length,
    publicPortsPerNode: [...inputs.publicPortsPerNode],
    deniedCountWindow: deniedWindow,
    topDeniedSources: [],
  };
}
