/**
 * Canonical labels for platform-managed PVCs (and the PVs they bind to).
 *
 * Problem
 * ───────
 * Kubernetes' CSI external-provisioner names every dynamically-provisioned
 * PV `pvc-<pvc.metadata.uid>` — an opaque UUID. `kubectl get pv` and the
 * Longhorn UI show those UUIDs and operators can't tell what's what.
 * Static provisioning would let us choose PV names, but that defeats
 * dynamic provisioning entirely.
 *
 * Solution
 * ────────
 * Stamp every platform-managed PVC with a small, predictable label set.
 * A reconciler (see modules/storage-policy-pvc-pv-mirror) then mirrors
 * the labels onto the bound PV at steady state, so:
 *
 *   kubectl get pv -L platform/role,platform/owner,platform/canonical-name
 *
 * shows meaningful columns next to the UUID. Same labels are queryable in
 * Longhorn's volume detail page and via the Labels filter.
 *
 * Labels
 * ──────
 * - platform/role           required — what kind of PVC this is
 * - platform/owner          required — who owns it (system | client:<id8> | mail)
 * - platform/canonical-name optional — the PVC name for self-describing
 *                           filters; omit for CNPG-instance PVCs that
 *                           inherit one set of labels but have per-instance
 *                           names
 * - platform/managed-by     always 'platform-api' — marker the reconciler
 *                           uses to ignore PVCs we don't manage
 */

export const CANONICAL_LABEL_KEYS = {
  role: 'platform/role',
  owner: 'platform/owner',
  canonicalName: 'platform/canonical-name',
  managedBy: 'platform/managed-by',
} as const;

export const PLATFORM_API_MANAGER = 'platform-api';

export type PvcRole =
  | 'system-db'
  | 'mail-db'
  | 'client-storage'
  | 'mail-blob-store';

export interface CanonicalLabelInput {
  readonly role: PvcRole;
  /** 'system' | 'mail' | `client:${shortId}` */
  readonly owner: string;
  /** Omit for CNPG-instance PVCs (system-db-1/2/3 share one label set). */
  readonly canonicalName?: string;
}

export function buildCanonicalLabels(
  input: CanonicalLabelInput,
): Record<string, string> {
  const out: Record<string, string> = {
    [CANONICAL_LABEL_KEYS.role]: input.role,
    [CANONICAL_LABEL_KEYS.owner]: input.owner,
    [CANONICAL_LABEL_KEYS.managedBy]: PLATFORM_API_MANAGER,
  };
  if (input.canonicalName !== undefined) {
    out[CANONICAL_LABEL_KEYS.canonicalName] = input.canonicalName;
  }
  return out;
}

/**
 * `client:abc12345` — first 8 hex chars of the client UUID. Stable per
 * client; matches the convention `<namespace>-storage` uses for the
 * tenant namespace name (`client-<slug>-<8chars>`).
 */
export function clientOwnerLabel(clientUuid: string): string {
  return `client:${clientUuid.replace(/-/g, '').slice(0, 8)}`;
}

/**
 * Build the canonical label set for a tenant client-storage PVC.
 * Used at PVC creation and at destructive-resize PVC recreate.
 */
export function clientStoragePvcLabels(
  clientUuid: string,
  namespace: string,
): Record<string, string> {
  return buildCanonicalLabels({
    role: 'client-storage',
    owner: clientOwnerLabel(clientUuid),
    canonicalName: `${namespace}-storage`,
  });
}

/**
 * Same as `clientStoragePvcLabels` but derives the owner short-id from
 * the namespace itself. Tenant namespaces follow the canonical form
 * `client-<slug>-<8hex>` (see k8s-provisioner.namespaceFor); the trailing
 * 8 hex chars are the shortened client UUID. Used at call sites that
 * have only the namespace string in scope (applyPVC, applyPVCMib).
 */
export function clientStoragePvcLabelsFromNamespace(
  namespace: string,
): Record<string, string> {
  const match = namespace.match(/-([0-9a-f]{8})$/);
  const shortId = match ? match[1] : 'unknown';
  return buildCanonicalLabels({
    role: 'client-storage',
    owner: `client:${shortId}`,
    canonicalName: `${namespace}-storage`,
  });
}
