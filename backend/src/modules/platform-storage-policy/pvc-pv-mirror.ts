/**
 * PVC → PV canonical-label mirror.
 *
 * Layer B of the canonical-PVC-naming compensation (see
 * backend/src/lib/canonical-labels.ts for the rationale).
 *
 * Why this is necessary
 * ─────────────────────
 * Kubernetes does NOT propagate PVC labels to the bound PV. CSI's
 * external-provisioner sets a few well-known annotations on the PV
 * but not arbitrary labels. So even though we stamp the canonical
 * `platform/role`, `platform/owner`, `platform/canonical-name`, and
 * `platform/managed-by` labels on every platform-managed PVC at
 * creation time (Layer A), `kubectl get pv` and the Longhorn UI
 * still see the PV without those labels — and the PV name itself is
 * an opaque `pvc-<uuid>`.
 *
 * What this function does
 * ───────────────────────
 * Once per tick (folded into the existing 5-min storage-policy
 * advisor), list every PVC cluster-wide with our manager marker
 * (`platform/managed-by=platform-api`), and for each bound PVC
 * patch the matching canonical labels onto its bound PV.
 *
 * Properties:
 *   - Idempotent — labels already in sync are skipped without a patch.
 *   - Strategic-merge patch — only the canonical keys are touched;
 *     other labels on the PV (Longhorn-managed, kubernetes.io/*) are
 *     preserved.
 *   - Per-PV errors are caught and logged; one bad PV doesn't stop
 *     the others.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import {
  CANONICAL_LABEL_KEYS,
  PLATFORM_API_MANAGER,
} from '../../lib/canonical-labels.js';

/** Labels the mirror manages. Anything else on the PV is left alone. */
const MIRRORED_KEYS: ReadonlyArray<string> = [
  CANONICAL_LABEL_KEYS.role,
  CANONICAL_LABEL_KEYS.owner,
  CANONICAL_LABEL_KEYS.canonicalName,
  CANONICAL_LABEL_KEYS.managedBy,
];

export interface PvcPvMirrorResult {
  /** Number of PVs patched in this tick. */
  readonly patched: number;
  /** Number of PVCs scanned. */
  readonly scanned: number;
  /** Per-PV errors. Empty when everything went through. */
  readonly errors: ReadonlyArray<string>;
}

interface PvcMetadataLabels {
  readonly metadata?: { readonly labels?: Record<string, string>; readonly name?: string };
  readonly spec?: { readonly volumeName?: string };
}

interface PvcList {
  readonly items?: ReadonlyArray<PvcMetadataLabels>;
}

interface PvObject {
  readonly metadata?: { readonly labels?: Record<string, string> };
}

/**
 * Compute the desired-label set for a PVC. Returns only the keys the
 * mirror manages and where the PVC has a non-empty value.
 */
export function desiredMirrorLabels(
  pvcLabels: Record<string, string> | undefined,
): Record<string, string> {
  const desired: Record<string, string> = {};
  if (!pvcLabels) return desired;
  for (const key of MIRRORED_KEYS) {
    const v = pvcLabels[key];
    if (typeof v === 'string' && v.length > 0) desired[key] = v;
  }
  return desired;
}

/**
 * Diff `desired` against the PV's current labels for the mirrored
 * keys only. Returns a partial label map of keys that need patching,
 * or null when nothing needs to change.
 */
export function computeMirrorDrift(
  desired: Record<string, string>,
  pvLabels: Record<string, string> | undefined,
): Record<string, string> | null {
  const cur = pvLabels ?? {};
  const drift: Record<string, string> = {};
  for (const [k, v] of Object.entries(desired)) {
    if (cur[k] !== v) drift[k] = v;
  }
  return Object.keys(drift).length > 0 ? drift : null;
}

/**
 * One reconcile pass. Lists all PVCs marked `managed-by=platform-api`
 * and mirrors their canonical labels onto the bound PVs.
 *
 * Errors during list (e.g. RBAC denial) are thrown — the caller's
 * try/catch should log and continue. Errors on individual PV reads
 * or patches are accumulated in `errors` so a single bad PV doesn't
 * mask a successful sweep across the rest.
 */
export async function mirrorPvcLabelsToPvs(
  k8s: K8sClients,
): Promise<PvcPvMirrorResult> {
  const labelSelector = `${CANONICAL_LABEL_KEYS.managedBy}=${PLATFORM_API_MANAGER}`;
  const pvcList = (await k8s.core.listPersistentVolumeClaimForAllNamespaces({
    labelSelector,
  })) as unknown as PvcList;

  const items = pvcList.items ?? [];
  const errors: string[] = [];
  let patched = 0;

  for (const pvc of items) {
    const pvName = pvc.spec?.volumeName;
    if (!pvName) continue; // not bound yet — skip silently

    const desired = desiredMirrorLabels(pvc.metadata?.labels);
    if (Object.keys(desired).length === 0) continue; // marker present but no label set; nothing to mirror

    try {
      const pv = (await k8s.core.readPersistentVolume({
        name: pvName,
      })) as unknown as PvObject;
      const drift = computeMirrorDrift(desired, pv.metadata?.labels);
      if (!drift) continue;

      await k8s.core.patchPersistentVolume({
        name: pvName,
        body: { metadata: { labels: drift } },
      });
      patched++;
    } catch (err: unknown) {
      const status = (err as { statusCode?: number; code?: number }).statusCode
        ?? (err as { code?: number }).code;
      if (status === 404) continue; // PV vanished between list + read — fine
      errors.push(`${pvName}: ${(err as Error).message}`);
    }
  }

  return { patched, scanned: items.length, errors };
}
