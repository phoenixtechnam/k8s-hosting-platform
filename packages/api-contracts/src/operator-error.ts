import { z } from 'zod';

/**
 * Operator-facing error envelope.
 *
 * Every k8s / Longhorn / cert-manager error that reaches an
 * operator-visible surface (UI, logs, audit) must be translated to
 * this shape at the ApiError boundary. The standard guarantees:
 *
 *   - Always a stable `code` (machine-readable, dashable in audit)
 *   - Always a one-line `title` for table cells / toast headers
 *   - Always a plain-English `detail` for the operator
 *   - Always at least one `remediation` step (what to do next)
 *   - `retryable` flag tells the UI whether to show a Retry button
 *   - Optional `diagnostics` carries the raw upstream error so a
 *     "Show raw error" expander can include it without polluting
 *     the primary message
 *
 * The ErrorPanel React component renders this consistently across
 * Storage Lifecycle, Deployments, Domain SSL, Drain modal, Client
 * provisioning, and File Manager — anywhere an operator sees a
 * failure.
 */
export const operatorErrorSchema = z.object({
  code: z.string(),
  title: z.string(),
  detail: z.string(),
  remediation: z.array(z.string()).min(1),
  retryable: z.boolean().default(false),
  diagnostics: z.record(z.string(), z.unknown()).optional(),
});
export type OperatorError = z.infer<typeof operatorErrorSchema>;

/**
 * Known error codes catalog. Add new codes here, never inline. Keeps
 * the i18n surface bounded and makes the audit log queryable.
 */
export const OPERATOR_ERROR_CODES = {
  // Storage / PVC
  PVC_FAILED_ATTACH_VOLUME: 'PVC_FAILED_ATTACH_VOLUME',
  PVC_REPLICA_SCHEDULING_FAILURE: 'PVC_REPLICA_SCHEDULING_FAILURE',
  PVC_INSUFFICIENT_STORAGE: 'PVC_INSUFFICIENT_STORAGE',
  PVC_BOUND_TO_PRIOR_CLIENT: 'PVC_BOUND_TO_PRIOR_CLIENT',
  PVC_FAULTED: 'PVC_FAULTED',
  PVC_MULTI_ATTACH: 'PVC_MULTI_ATTACH',
  // Provisioning
  PROVISION_NAMESPACE_EXISTS: 'PROVISION_NAMESPACE_EXISTS',
  PROVISION_QUOTA_EXCEEDED: 'PROVISION_QUOTA_EXCEEDED',
  PROVISION_OVER_CAPACITY: 'PROVISION_OVER_CAPACITY',
  // Workloads
  WORKLOAD_IMAGE_PULL: 'WORKLOAD_IMAGE_PULL',
  WORKLOAD_CRASH_LOOP: 'WORKLOAD_CRASH_LOOP',
  WORKLOAD_OOM: 'WORKLOAD_OOM',
  WORKLOAD_UNSCHEDULABLE: 'WORKLOAD_UNSCHEDULABLE',
  // Certificates
  CERT_CHALLENGE_INVALID: 'CERT_CHALLENGE_INVALID',
  CERT_HTTP01_TIMEOUT: 'CERT_HTTP01_TIMEOUT',
  CERT_DNS_PROPAGATION: 'CERT_DNS_PROPAGATION',
  CERT_RATE_LIMITED: 'CERT_RATE_LIMITED',
  // File-manager
  FM_PVC_BUSY: 'FM_PVC_BUSY',
  FM_HEALTH_PROBE_FAIL: 'FM_HEALTH_PROBE_FAIL',
  // Drain
  DRAIN_LAST_REPLICA: 'DRAIN_LAST_REPLICA',
  DRAIN_PIN_CONFLICT: 'DRAIN_PIN_CONFLICT',
  // Generic
  UNKNOWN: 'UNKNOWN',
} as const;
export type OperatorErrorCode = typeof OPERATOR_ERROR_CODES[keyof typeof OPERATOR_ERROR_CODES];
