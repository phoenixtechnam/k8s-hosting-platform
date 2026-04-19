/**
 * URL health probe for the admin/client panel URLs in System Settings.
 *
 * Answers two operator-facing questions:
 *   - Does DNS resolve the hostname? (Green = resolved, Amber = unresolved,
 *     Red = timeout/error). Uses the process's normal DNS resolver — for a
 *     pod running on a standard cluster with upstream DNS set to a public
 *     resolver (CoreDNS → 1.1.1.1), this effectively simulates what a
 *     public visitor would see.
 *
 *   - Is there a TLS cert ready? (Green = cert-manager Certificate is
 *     Ready, Amber = Pending, Red = Failed, Gray = not yet created). Reads
 *     the Certificate CR's status.conditions[type=Ready] condition.
 *
 * Pure DI-injectable probe below + real k8s/DNS default deps at the bottom.
 * The route wraps this with a 60s in-memory cache keyed by hostname.
 */

import * as k8s from '@kubernetes/client-node';
import * as dnsPromises from 'node:dns/promises';

export type DnsStatus =
  | 'resolved'
  | 'unresolved'
  | 'timeout'
  | 'error'
  | 'not-configured';

export type SslStatus =
  | 'ready'
  | 'pending'
  | 'failed'
  | 'missing'
  | 'unknown'
  | 'not-configured';

export interface DnsProbeResult {
  readonly status: DnsStatus;
  readonly addresses?: ReadonlyArray<string>;
  readonly reason?: string;
}

export interface SslProbeResult {
  readonly status: SslStatus;
  readonly reason?: string | null;
  readonly secretName?: string;
  readonly notAfter?: string | null;
  readonly daysUntilExpiry?: number;
  readonly expiringSoon?: boolean;
}

export interface UrlHealthReport {
  readonly host: string | null;
  readonly dns: DnsProbeResult;
  readonly ssl: SslProbeResult;
  readonly checkedAt: string;
}

export interface CertificateInfo {
  readonly status: SslStatus;
  readonly reason: string | null;
  readonly notAfter: string | null;
  readonly secretName: string;
}

export interface UrlHealthDeps {
  resolveDns(host: string): Promise<{ status: DnsStatus; addresses: string[]; reason?: string }>;
  readCertificate(args: { host: string; secretName: string; namespace: string }): Promise<CertificateInfo | null>;
  now(): Date;
}

export interface ProbeInput {
  readonly host: string | null;
  readonly certSecretName: string;
  readonly certNamespace: string;
}

const EXPIRY_WARN_DAYS = 30;

/** Pure probe. Callers inject mock deps in tests; the default wires DNS + k8s. */
export async function probeUrlHealth(
  input: ProbeInput,
  deps: UrlHealthDeps,
): Promise<UrlHealthReport> {
  const nowIso = deps.now().toISOString();

  if (!input.host) {
    return {
      host: null,
      dns: { status: 'not-configured' },
      ssl: { status: 'not-configured' },
      checkedAt: nowIso,
    };
  }

  const [dnsRaw, certInfo] = await Promise.all([
    deps.resolveDns(input.host).catch((err: unknown) => ({
      status: 'error' as DnsStatus,
      addresses: [] as string[],
      reason: err instanceof Error ? err.message : String(err),
    })),
    deps.readCertificate({
      host: input.host,
      secretName: input.certSecretName,
      namespace: input.certNamespace,
    }).catch((err: unknown) => {
      // Don't surface k8s API errors as fatal — just report "unknown" so
      // the UI shows a neutral badge instead of a red one that would
      // suggest a real cert problem.
      const reason = err instanceof Error ? err.message : String(err);
      return {
        status: 'unknown' as SslStatus,
        reason,
        notAfter: null,
        secretName: input.certSecretName,
      };
    }),
  ]);

  // DNS result shaping — enrich empty addresses with a friendly reason.
  const dns: DnsProbeResult =
    dnsRaw.status === 'unresolved' && !dnsRaw.reason
      ? { ...dnsRaw, reason: 'Hostname not found in public DNS (NXDOMAIN or no records).' }
      : dnsRaw;

  // SSL result shaping — compute expiry window if we got a notAfter.
  const ssl: SslProbeResult = (() => {
    if (!certInfo) {
      return {
        status: 'missing',
        reason: `No Certificate resource found for ${input.host} (Secret: ${input.certSecretName}).`,
        secretName: input.certSecretName,
        notAfter: null,
      };
    }
    const base: SslProbeResult = {
      status: certInfo.status,
      reason: certInfo.reason,
      secretName: certInfo.secretName,
      notAfter: certInfo.notAfter,
    };
    if (certInfo.notAfter) {
      const ms = new Date(certInfo.notAfter).getTime() - deps.now().getTime();
      const days = Math.floor(ms / (24 * 60 * 60 * 1000));
      return {
        ...base,
        daysUntilExpiry: days,
        expiringSoon: days <= EXPIRY_WARN_DAYS,
      };
    }
    return base;
  })();

  return {
    host: input.host,
    dns,
    ssl,
    checkedAt: nowIso,
  };
}

// ─── Default deps (real DNS + real k8s) ──────────────────────────────────

export interface DefaultDepsOptions {
  readonly kubeconfigPath?: string;
  readonly dnsTimeoutMs?: number;
}

export function createDefaultUrlHealthDeps(opts: DefaultDepsOptions = {}): UrlHealthDeps {
  const dnsTimeout = opts.dnsTimeoutMs ?? 3_000;
  const kc = new k8s.KubeConfig();
  if (opts.kubeconfigPath) kc.loadFromFile(opts.kubeconfigPath);
  else {
    try {
      kc.loadFromCluster();
    } catch {
      // outside a cluster (e.g., unit tests) — k8s calls will fail but
      // DNS still works
    }
  }
  const custom = kc.makeApiClient(k8s.CustomObjectsApi);

  return {
    resolveDns: async (host: string) => {
      // Resolve A + AAAA in parallel, consolidate.
      const runWithTimeout = <T>(p: Promise<T>): Promise<T> =>
        Promise.race([
          p,
          new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`DNS lookup timed out after ${dnsTimeout}ms`)), dnsTimeout),
          ),
        ]);
      try {
        const [v4, v6] = await Promise.allSettled([
          runWithTimeout(dnsPromises.resolve4(host)),
          runWithTimeout(dnsPromises.resolve6(host)),
        ]);
        const addresses: string[] = [];
        if (v4.status === 'fulfilled') addresses.push(...v4.value);
        if (v6.status === 'fulfilled') addresses.push(...v6.value);
        if (addresses.length > 0) return { status: 'resolved', addresses };
        // Both failed — categorize by reason
        const errMsg =
          (v4.status === 'rejected' ? String(v4.reason?.message ?? v4.reason) : '') ||
          (v6.status === 'rejected' ? String(v6.reason?.message ?? v6.reason) : '');
        if (/timed out/i.test(errMsg)) return { status: 'timeout', addresses: [], reason: errMsg };
        if (/ENOTFOUND|NXDOMAIN|ENODATA/i.test(errMsg)) return { status: 'unresolved', addresses: [] };
        return { status: 'error', addresses: [], reason: errMsg };
      } catch (err: unknown) {
        return {
          status: 'error',
          addresses: [],
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },

    readCertificate: async ({ host, secretName, namespace }) => {
      // Find the Certificate whose spec.secretName matches ours. cert-manager
      // creates one when an Ingress has cert-manager.io/cluster-issuer +
      // spec.tls. Name usually == secretName but we match on the spec field
      // to be robust.
      let certs: { items?: unknown[] };
      try {
        certs = (await custom.listNamespacedCustomObject({
          group: 'cert-manager.io',
          version: 'v1',
          namespace,
          plural: 'certificates',
        })) as { items?: unknown[] };
      } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return null;
        throw err;
      }

      const items = (certs.items ?? []) as Array<{
        metadata?: { name?: string };
        spec?: { secretName?: string; dnsNames?: string[] };
        status?: { conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>; notAfter?: string };
      }>;

      const cert = items.find(
        (c) =>
          c.spec?.secretName === secretName ||
          (Array.isArray(c.spec?.dnsNames) && c.spec.dnsNames.includes(host)),
      );
      if (!cert) return null;

      const readyCondition = cert.status?.conditions?.find((c) => c.type === 'Ready');
      let status: SslStatus = 'unknown';
      if (readyCondition?.status === 'True') status = 'ready';
      else if (readyCondition?.status === 'False') {
        // cert-manager distinguishes "failed" vs "pending" via reason — if
        // the reason is "Issuing" we're mid-flight; otherwise something's
        // actually wrong.
        status = readyCondition.reason === 'Issuing' ? 'pending' : 'failed';
      } else {
        status = 'pending';
      }

      return {
        status,
        reason: readyCondition?.message ?? readyCondition?.reason ?? null,
        notAfter: cert.status?.notAfter ?? null,
        secretName: cert.spec?.secretName ?? secretName,
      };
    },

    now: () => new Date(),
  };
}
