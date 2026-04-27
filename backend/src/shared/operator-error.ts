import { OPERATOR_ERROR_CODES, type OperatorError } from '@k8s-hosting/api-contracts';

/**
 * Translate a raw error message (k8s API, Longhorn, cert-manager,
 * pod events) into the OperatorError envelope.
 *
 * Pattern matching is intentionally conservative — we only translate
 * cases we KNOW how to advise on. Anything else falls through to a
 * generic UNKNOWN-coded entry that includes the raw text in
 * diagnostics, so the operator can still see the upstream message
 * via the "Show raw error" expander.
 *
 * Used by the deployments status-reconciler, the file-manager
 * lifecycle, the drain endpoint, and the certificate state poller.
 */
export function translateOperatorError(
  raw: string,
  context: { kind?: 'pvc' | 'workload' | 'cert' | 'fm' | 'drain' | 'provision'; resource?: string } = {},
): OperatorError {
  const text = raw ?? '';

  // ─── PVC / volume ─────────────────────────────────────────────
  if (text.includes('Multi-Attach error')) {
    return {
      code: OPERATOR_ERROR_CODES.PVC_MULTI_ATTACH,
      title: 'PVC busy on another pod',
      detail: 'The persistent volume is currently mounted by another pod and Kubernetes refuses to attach it twice (RWO).',
      remediation: [
        'If this is the file-manager waiting on a workload, scale the workload down first.',
        'Run kubectl get pods -A -o wide and find every pod still mounting the PVC.',
        'After all consumers are stopped, retry — Kubernetes attaches automatically.',
      ],
      retryable: true,
      diagnostics: { raw },
    };
  }
  if (text.includes('insufficient storage') || text.includes('precheck new replica failed')) {
    return {
      code: OPERATOR_ERROR_CODES.PVC_REPLICA_SCHEDULING_FAILURE,
      title: 'Longhorn cannot schedule a replica',
      detail: 'No cluster node has enough free disk to host this volume\'s replica. The PVC is bound but the volume cannot become healthy.',
      remediation: [
        'Open Nodes & Storage → Cluster Nodes — check storageReserved on each Longhorn node.',
        'Lower storageReserved on a server with capacity, OR resize the underlying disk, OR reduce the volume\'s size.',
        'Apply HA to Local frees ~30 GB per server (CNPG/stalwart drop from 3 → 1 replicas).',
      ],
      retryable: true,
      diagnostics: { raw },
    };
  }
  if (text.includes('not ready for workloads') || (text.includes('faulted') && context.kind === 'pvc')) {
    return {
      code: OPERATOR_ERROR_CODES.PVC_FAULTED,
      title: 'PVC volume is faulted',
      detail: 'Longhorn marked this volume faulted — replica scheduling failed earlier and no healthy replica exists.',
      remediation: [
        'Open the Longhorn UI (Nodes & Storage → Storage → Open Longhorn) and inspect the volume\'s replicas.',
        'If the original replica node is recoverable, bring it back online and Longhorn will rebuild.',
        'Otherwise: delete the PVC + restore from the most recent snapshot/backup.',
      ],
      retryable: false,
      diagnostics: { raw },
    };
  }
  if (text.includes('FailedAttachVolume') || text.includes('AttachVolume.Attach failed')) {
    return {
      code: OPERATOR_ERROR_CODES.PVC_FAILED_ATTACH_VOLUME,
      title: 'Pod cannot attach its persistent volume',
      detail: 'Kubernetes cannot attach the PVC to this pod. Common causes: faulted Longhorn volume, multi-attach contention, or CSI driver not yet registered on the target node.',
      remediation: [
        'Open the Storage Lifecycle card and verify the PVC\'s Replica nodes column shows a healthy replica.',
        'If you just rejoined a worker node, give Longhorn 1-2 min to register the CSI driver.',
        'Otherwise check kubectl describe pod for the most recent FailedAttachVolume reason.',
      ],
      retryable: true,
      diagnostics: { raw },
    };
  }

  // ─── Workload ──────────────────────────────────────────────────
  if (text.match(/(ImagePull|ErrImagePull|manifest unknown|denied)/i)) {
    return {
      code: OPERATOR_ERROR_CODES.WORKLOAD_IMAGE_PULL,
      title: 'Image pull failed',
      detail: 'The cluster could not pull this workload\'s container image. The image is missing, the tag is wrong, or the registry needs auth.',
      remediation: [
        'Verify the image path + tag in the Catalog.',
        'For private registries, ensure the tenant namespace has an imagePullSecret of type kubernetes.io/dockerconfigjson.',
        'Run crictl pull <image> on a worker node to reproduce the exact registry error.',
      ],
      retryable: true,
      diagnostics: { raw },
    };
  }
  if (text.includes('CrashLoopBackOff')) {
    return {
      code: OPERATOR_ERROR_CODES.WORKLOAD_CRASH_LOOP,
      title: 'Workload is crashing repeatedly',
      detail: 'The container starts and exits non-zero in a loop. Most often a config bug, missing env var, or unreachable dependency.',
      remediation: [
        'Open the workload\'s pod logs (kubectl logs deploy/<name> -n <client-ns>).',
        'Check connection strings to databases — the most common crash cause for CMS/PHP apps.',
        'If memory-related (exit 137), bump memory limit on the deployment.',
      ],
      retryable: false,
      diagnostics: { raw },
    };
  }
  if (text.includes('OOMKilled') || text.includes('exit code 137')) {
    return {
      code: OPERATOR_ERROR_CODES.WORKLOAD_OOM,
      title: 'Workload ran out of memory',
      detail: 'The container exceeded its memory limit and Kubernetes killed it.',
      remediation: [
        'Raise the deployment\'s memory limit (Edit deployment → Memory request).',
        'Investigate whether the app is leaking memory or processing larger payloads than expected.',
      ],
      retryable: false,
      diagnostics: { raw },
    };
  }
  if (text.includes('Insufficient cpu') || text.includes('Insufficient memory')) {
    return {
      code: OPERATOR_ERROR_CODES.WORKLOAD_UNSCHEDULABLE,
      title: 'No node has enough CPU/memory for this pod',
      detail: 'The Kubernetes scheduler could not find a node with sufficient resources to place the pod.',
      remediation: [
        'Add a worker node, OR free CPU/memory on existing workers (admin Cluster Nodes).',
        'Reduce the deployment\'s requests if they are over-spec\'d.',
      ],
      retryable: true,
      diagnostics: { raw },
    };
  }

  // ─── Provisioning ──────────────────────────────────────────────
  if (text.includes('exceeded quota')) {
    return {
      code: OPERATOR_ERROR_CODES.PROVISION_QUOTA_EXCEEDED,
      title: 'ResourceQuota exceeded',
      detail: 'The platform or tenant ResourceQuota is full — Kubernetes refused to create the resource.',
      remediation: [
        'Open the namespace\'s ResourceQuota and check used vs. hard.',
        'Either: raise the quota (admin) OR reduce the request.',
        'For platform namespace, ensure staging quota patch (k8s/overlays/staging/resource-quotas-patch.yaml) is current.',
      ],
      retryable: true,
      diagnostics: { raw },
    };
  }

  // ─── Cert-manager ─────────────────────────────────────────────
  if (text.includes('acme:') && text.includes('rateLimited')) {
    return {
      code: OPERATOR_ERROR_CODES.CERT_RATE_LIMITED,
      title: 'Let\'s Encrypt rate-limited this domain',
      detail: 'Too many cert issuance attempts in the past 7 days. LE returns 429 until the rolling window clears.',
      remediation: [
        'Wait until the LE rate-limit window expires (usually within 7 days).',
        'Use the LE staging issuer for testing — it has separate (much higher) limits.',
      ],
      retryable: false,
      diagnostics: { raw },
    };
  }
  if ((text.includes('challenge') && text.includes('invalid')) || text.includes('Invalid response')) {
    return {
      code: OPERATOR_ERROR_CODES.CERT_HTTP01_TIMEOUT,
      title: 'HTTP-01 challenge failed',
      detail: 'Let\'s Encrypt could not reach the challenge URL. Either DNS does not resolve here yet, OR ingress-nginx → solver-pod is blocked.',
      remediation: [
        'Verify the domain\'s DNS A record points to the platform\'s public IPs.',
        'Check tenant NetworkPolicy allow-platform-api / default-deny-ingress includes ipBlock 10.42.0.0/16.',
        'Hit /api/v1/clients/<id>/domains/<id>/verify to re-trigger after DNS settles.',
      ],
      retryable: true,
      diagnostics: { raw },
    };
  }

  // ─── File-manager ─────────────────────────────────────────────
  if (text.includes('Pod is being created') && context.kind === 'fm') {
    return {
      code: OPERATOR_ERROR_CODES.FM_PVC_BUSY,
      title: 'File manager waiting on PVC',
      detail: 'The file-manager pod is scheduled but cannot start because the tenant PVC is held by another pod.',
      remediation: [
        'Scale the tenant\'s workload(s) to 0 temporarily (Deployments tab → Stop).',
        'Wait ~30 s for the PVC to detach, then retry.',
      ],
      retryable: true,
      diagnostics: { raw },
    };
  }

  // ─── Drain ────────────────────────────────────────────────────
  if (text.includes('NODE_DRAIN_BLOCKED_LAST_REPLICA')) {
    return {
      code: OPERATOR_ERROR_CODES.DRAIN_LAST_REPLICA,
      title: 'Drain blocked — last replica',
      detail: 'This node holds the last running replica for one or more Longhorn volumes. Draining without override would risk data loss.',
      remediation: [
        'Wait for Longhorn to rebuild a replica on another node, OR',
        'Tick "Force last replica" in the drain dialog if you accept the data risk.',
      ],
      retryable: true,
      diagnostics: { raw },
    };
  }

  // ─── Fallback ─────────────────────────────────────────────────
  return {
    code: OPERATOR_ERROR_CODES.UNKNOWN,
    title: 'Operation failed',
    detail: text.slice(0, 240) || 'No further detail provided by the upstream system.',
    remediation: [
      'Click "Show raw error" below to see the upstream message.',
      'If reproducible, capture the request_id from the response header and check platform-api logs.',
    ],
    retryable: true,
    diagnostics: { raw },
  };
}
