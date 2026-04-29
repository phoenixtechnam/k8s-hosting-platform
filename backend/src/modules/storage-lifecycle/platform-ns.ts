/**
 * Platform-tenant-ops namespace — single namespace where short-lived
 * platform-managed Pods that operate on a tenant's behalf live (fsck,
 * snapshot, restore, mail-imapsync). NOT the client namespace.
 *
 * No ResourceQuota — Pods MUST NOT count against any tenant quota.
 * PSA = privileged (needed for hostPath block-device access).
 *
 * Pods scheduled here SHOULD set:
 *   priorityClassName: platform-storage-ops
 *   labels.platform.io/client-id: <clientId>   (so cancel-by-client works)
 *
 * Created by k8s/base/platform-tenant-ops/namespace.yaml.
 */
export const PLATFORM_TENANT_OPS_NS = 'platform-tenant-ops';

/**
 * PriorityClass marker for storage-lifecycle Jobs in PLATFORM_TENANT_OPS_NS.
 * Defined in k8s/base/priority-classes.yaml (priority 1000).
 */
export const STORAGE_OPS_PRIORITY_CLASS = 'platform-storage-ops';
