/**
 * Full mail-server health drill-down modal.
 *
 * Opened from MailHealthBanner via "View full details". Shows every
 * probe (cluster-internal: pod / jmap / rocksdb / cert / tcp +
 * external deliverability: forward DNS / reverse DNS / DNSBL / cert
 * SAN match / SMTP banner) with severity icons and — critically —
 * remediation text on failures.
 *
 * Layout:
 *   - Cluster section (5 existing probes, terse rows reusing the
 *     same shape as the banner for visual continuity)
 *   - Deliverability section (new in 2026-05-17): grouped by
 *     sub-probe with expected/actual/remediation cards
 *
 * The deliverability section degrades gracefully: if the backend
 * doesn't emit `components.deliverability` (older build), the section
 * is omitted entirely instead of showing empty rows.
 */

import { useEffect } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  Globe,
  Info,
  Loader2,
  Mail,
  RefreshCw,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useMailHealth, useRefreshMailHealth } from '@/hooks/use-mail-health';
import { timeAgo } from './MailHealthBanner';
import type {
  DeliverabilityProbeSeverity,
  MailHealthBlocklistProbe,
  MailHealthCertComponent,
  MailHealthDeliverabilityComponent,
  MailHealthJmapComponent,
  MailHealthPodComponent,
  MailHealthResponse,
  MailHealthRocksdbComponent,
  MailHealthTcpComponent,
} from '@k8s-hosting/api-contracts';

interface MailHealthDetailsModalProps {
  readonly onClose: () => void;
}

export default function MailHealthDetailsModal({ onClose }: MailHealthDetailsModalProps) {
  const { data, isLoading, isError, error } = useMailHealth();
  const refresh = useRefreshMailHealth();
  const r = data?.data;

  // Escape closes the modal. Window-level listener so keyboard users
  // get an immediate exit even when focus is not yet inside the modal
  // (e.g. opened via mouse click on the banner). Cleanup on unmount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mail-health-details-modal-title"
      data-testid="mail-health-details-modal"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-5xl rounded-xl bg-white dark:bg-gray-800 shadow-xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-3">
          <h3
            id="mail-health-details-modal-title"
            className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100"
          >
            <Shield size={16} /> Mail-server health — full probe details
          </h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
              data-testid="mail-health-details-refresh"
              className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              {refresh.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Re-check
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
              data-testid="mail-health-details-close"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 size={14} className="animate-spin" /> Probing mail-server health…
            </div>
          ) : isError || !r ? (
            <div className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-700 dark:text-red-300">
              <div className="font-medium">Health probe failed</div>
              <div className="text-xs mt-1 opacity-80">
                {error instanceof Error ? error.message : 'Could not reach /admin/mail/health.'}
              </div>
            </div>
          ) : (
            <DetailsContent r={r} />
          )}
        </div>
      </div>
    </div>
  );
}

function DetailsContent({ r }: { readonly r: MailHealthResponse }) {
  // Plain function call: counts is a small object built from 5 integer
  // adds. useMemo overhead would dwarf the computation, and would also
  // mislead future readers into thinking this is expensive.
  const counts = rollupDeliverabilityCounts(r.components.deliverability);
  return (
    <>
      <Headline r={r} counts={counts} />

      <Section title="Cluster" icon={<Server size={14} />}>
        <PodCard data={r.components.pod} />
        <JmapCard data={r.components.jmap} />
        <RocksdbCard data={r.components.rocksdb} />
        <CertCard data={r.components.cert} />
        <TcpCard data={r.components.tcp} />
      </Section>

      {r.components.deliverability && (
        <Section title="Deliverability (external)" icon={<Globe size={14} />}>
          <DeliverabilitySection d={r.components.deliverability} />
        </Section>
      )}

      <div className="text-xs text-gray-500 dark:text-gray-400 pt-2 border-t border-gray-100 dark:border-gray-700">
        Checked {timeAgo(r.checkedAt)} • Backend cache window {r.cachedFor}s • Re-check bypasses cache.
      </div>
    </>
  );
}

function Headline({ r, counts }: { readonly r: MailHealthResponse; readonly counts: ReturnType<typeof rollupDeliverabilityCounts> }) {
  const tone = r.healthy ? 'ok' : 'fail';
  const Icon = r.healthy ? CheckCircle2 : AlertTriangle;
  const bg = r.healthy
    ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20'
    : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20';
  const fg = r.healthy ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300';
  return (
    <div className={`rounded-md border ${bg} px-4 py-3 flex items-start gap-3`}>
      <Icon size={18} className={`mt-0.5 shrink-0 ${tone === 'ok' ? 'text-emerald-500' : 'text-red-500'}`} />
      <div className="flex-1 min-w-0">
        <div className={`text-sm font-semibold ${fg}`}>
          {r.healthy ? 'Mail server: OK' : 'Mail server: DEGRADED'}
        </div>
        {counts.total > 0 && (
          <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">
            Deliverability:{' '}
            <span className="text-emerald-600 dark:text-emerald-400">{counts.ok} ok</span>
            {counts.warning > 0 && <> • <span className="text-amber-600 dark:text-amber-400">{counts.warning} warning</span></>}
            {counts.fail > 0 && <> • <span className="text-red-600 dark:text-red-400">{counts.fail} fail</span></>}
            {counts.advisory > 0 && <> • <span className="text-gray-500">{counts.advisory} advisory</span></>}
            {counts.skipped > 0 && <> • <span className="text-gray-400">{counts.skipped} skipped</span></>}
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, icon, children }: { readonly title: string; readonly icon: React.ReactNode; readonly children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {icon} {title}
      </h4>
      <div className="space-y-2">
        {children}
      </div>
    </section>
  );
}

// ── Cluster probe cards ────────────────────────────────────────────────

function PodCard({ data }: { readonly data: MailHealthPodComponent }) {
  return (
    <ProbeCard
      title="Pod readiness"
      severity={severityFromHealthy(data.healthy)}
      assertion="Stalwart pod exists + container is ready"
      actual={
        data.podName
          ? `${data.podName} on ${data.node ?? '?'} • ${data.phase ?? '?'} • ${data.containerReady ? 'ready' : 'not ready'}` +
            (typeof data.restartCount === 'number' && data.restartCount > 0 ? ` • ${data.restartCount} restarts` : '') +
            (data.initContainerStatus ? ` • ${data.initContainerStatus}` : '')
          : 'No Stalwart pod found'
      }
      expected="podName set, phase=Running, containerReady=true"
      error={data.error}
      remediation={
        data.healthy
          ? null
          : `kubectl describe pod -n mail -l app=stalwart-mail to inspect events. ` +
            'If init-container is stuck, check restore-state job and PVC binding. ' +
            'If CrashLoopBackOff, check Stalwart logs for RocksDB lock errors.'
      }
    />
  );
}

function JmapCard({ data }: { readonly data: MailHealthJmapComponent }) {
  return (
    <ProbeCard
      title="JMAP responsiveness"
      severity={severityFromHealthy(data.healthy)}
      assertion="Stalwart JMAP endpoint answers within 5s"
      actual={
        data.durationMs !== null
          ? `${data.durationMs}ms${data.serverName ? ` (${data.serverName}${data.serverVersion ? ` ${data.serverVersion}` : ''})` : ''}`
          : 'no response'
      }
      expected="HTTP 200 with valid JMAP session payload"
      error={data.error}
      remediation={
        data.healthy
          ? null
          : 'Pod may be up but Stalwart is not serving JMAP. Check the JMAP listener config (jmap.k8s-platform.test ' +
            'or per-cluster) and the stalwart-mgmt Service. If JMAP 401s, the platform-api stalwart-admin-creds Secret ' +
            'is out of sync with the principal stored in RocksDB.'
      }
    />
  );
}

function RocksdbCard({ data }: { readonly data: MailHealthRocksdbComponent }) {
  if (data.status === 'not_implemented') {
    return <ProbeCard title="RocksDB datastore" severity="skipped" assertion="RocksDB CURRENT + LOCK files exist in /var/lib/stalwart/data" actual="probe not implemented" expected={null} error={null} remediation={null} />;
  }
  return (
    <ProbeCard
      title="RocksDB datastore"
      severity={severityFromHealthy(data.healthy)}
      assertion="CURRENT + LOCK present in /var/lib/stalwart/data"
      actual={
        `CURRENT ${data.currentFile === true ? '✓' : data.currentFile === false ? '✗' : '?'} • ` +
        `LOCK ${data.lockFile === true ? '✓' : data.lockFile === false ? '✗' : '?'}`
      }
      expected="both present"
      error={data.error}
      remediation={
        data.healthy
          ? null
          : data.currentFile === false
            ? 'CURRENT missing — RocksDB has not been initialised. Check restore-state job logs and the Stalwart ' +
              'container init sequence. If this is a fresh install, the data PVC may have been replaced.'
            : data.lockFile === false
              ? 'LOCK missing — RocksDB is not open. Stalwart may have crashed mid-boot. Check pod logs.'
              : 'Run `kubectl exec -n mail <pod> -c stalwart -- ls -la /var/lib/stalwart/data` and compare with a healthy install.'
      }
    />
  );
}

function CertCard({ data }: { readonly data: MailHealthCertComponent }) {
  if (data.status === 'not_implemented') {
    return <ProbeCard title="TLS certs" severity="skipped" assertion="Each implicit-TLS port serves a valid cert" actual="no mail hostname configured" expected={null} error={null} remediation="Set Webmail Settings → Mail server hostname to enable cert probes." />;
  }
  const minDays = data.ports.reduce<number | null>((acc, p) => {
    if (p.daysUntilExpiry === null) return acc;
    return acc === null ? p.daysUntilExpiry : Math.min(acc, p.daysUntilExpiry);
  }, null);
  return (
    <ProbeCard
      title="TLS certs"
      severity={severityFromHealthy(data.healthy)}
      assertion="Each implicit-TLS mail port serves a valid cert (smtps/imaps)"
      actual={
        data.ports.length > 0
          ? `ports ${data.ports.map((p) => p.port).join(', ')}` +
            (minDays !== null ? ` • min ${minDays}d to expiry` : '') +
            (data.ports[0]?.issuer ? ` • issued by ${data.ports[0].issuer}` : '')
          : 'no ports probed'
      }
      expected=">= 14d until expiry, issuer trusted by major browsers"
      error={data.error}
      remediation={
        data.healthy
          ? null
          : (minDays !== null && minDays < 14
              ? `Cert expires in ${minDays} days. Check cert-manager Certificate resource in namespace mail; ` +
                'verify ClusterIssuer is reachable and not rate-limited.'
              : 'TLS handshake failed on one or more ports. Check Stalwart\'s listener config in JMAP ' +
                'and cert-manager pod logs.')
      }
    />
  );
}

function TcpCard({ data }: { readonly data: MailHealthTcpComponent }) {
  if (data.status === 'not_implemented') {
    return <ProbeCard title="TCP reachability" severity="skipped" assertion="Mail ports accept TCP from inside the cluster" actual="probe not implemented" expected={null} error={null} remediation={null} />;
  }
  const reachable = data.ports.filter((p) => p.reachable);
  const unreachable = data.ports.filter((p) => !p.reachable);
  return (
    <ProbeCard
      title="TCP reachability"
      severity={severityFromHealthy(data.healthy)}
      assertion="Every mail port (25/465/587/143/993/4190) accepts TCP from inside the cluster"
      actual={
        `${reachable.length}/${data.ports.length} reachable` +
        (unreachable.length > 0 ? ` • blocked: ${unreachable.map((p) => p.port).join(', ')}` : '')
      }
      expected="all ports reachable"
      error={data.error}
      remediation={
        data.healthy
          ? null
          : `Ports ${unreachable.map((p) => p.port).join(', ')} not reachable. Most common cause: NetworkPolicy ` +
            'on namespace mail denies ingress from platform; check `kubectl get netpol -n mail`. Second most ' +
            'common: haproxy DaemonSet not running on this node — check `kubectl get ds -n mail haproxy-mail`.'
      }
    />
  );
}

// ── Deliverability section ─────────────────────────────────────────────

function DeliverabilitySection({ d }: { readonly d: MailHealthDeliverabilityComponent }) {
  if (d.status === 'not_implemented') {
    return (
      <div className="rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-700 dark:text-amber-300 flex items-start gap-2">
        <Info size={14} className="mt-0.5 shrink-0" />
        <div className="flex-1">
          <div className="font-medium">Deliverability probes skipped</div>
          <div className="text-xs mt-1">
            {d.forwardDns?.remediation ?? 'Configure mail hostname under Email Management → Webmail Settings and ensure the cluster has server-role nodes labelled with platform.phoenix-host.net/node-role=server.'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
        <Mail size={12} />
        Probing <span className="font-mono">{d.hostname}</span>
        {d.expectedMailIps.length > 0 && (
          <> against {d.expectedMailIps.length} server IP{d.expectedMailIps.length === 1 ? '' : 's'}: <span className="font-mono">{d.expectedMailIps.join(', ')}</span></>
        )}
      </div>

      {d.forwardDns && (
        <ProbeCard
          title="Forward DNS"
          severity={d.forwardDns.severity}
          assertion={d.forwardDns.assertion}
          actual={d.forwardDns.actual}
          expected={d.forwardDns.expected}
          error={null}
          remediation={d.forwardDns.remediation}
        />
      )}

      {d.reverseDns.map((p) => (
        <ProbeCard
          key={`rdns-${p.ip}`}
          title={`Reverse DNS (${p.ip})`}
          severity={p.severity}
          assertion={p.assertion}
          actual={p.actual}
          expected={p.expected}
          error={null}
          remediation={p.remediation}
        />
      ))}

      {d.smtpBanner && (
        <ProbeCard
          title="SMTP banner / EHLO"
          severity={d.smtpBanner.severity}
          assertion={d.smtpBanner.assertion}
          actual={d.smtpBanner.actual}
          expected={d.smtpBanner.expected}
          error={null}
          remediation={d.smtpBanner.remediation}
        />
      )}

      {d.certSanMatch && (
        <ProbeCard
          title="Certificate SAN match"
          severity={d.certSanMatch.severity}
          assertion={d.certSanMatch.assertion}
          actual={d.certSanMatch.actual}
          expected={d.certSanMatch.expected}
          error={null}
          remediation={d.certSanMatch.remediation}
        />
      )}

      {d.blocklists.length > 0 && (
        <div className="rounded-md border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="bg-gray-50 dark:bg-gray-900/50 px-3 py-2 text-xs font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
            <ShieldAlert size={12} />
            Blocklists ({d.blocklists.length} checks across {new Set(d.blocklists.map((b) => b.list)).size} providers × {new Set(d.blocklists.map((b) => b.ip)).size} IPs)
          </div>
          <table className="w-full text-xs">
            <thead className="bg-gray-50 dark:bg-gray-900/30 text-gray-500 dark:text-gray-400">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium">IP</th>
                <th className="text-left px-3 py-1.5 font-medium">List</th>
                <th className="text-left px-3 py-1.5 font-medium">Status</th>
                <th className="text-left px-3 py-1.5 font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {d.blocklists.map((b) => <BlocklistRow key={`${b.ip}-${b.zone}`} probe={b} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BlocklistRow({ probe }: { readonly probe: MailHealthBlocklistProbe }) {
  return (
    <tr className={probe.listed ? 'bg-red-50/50 dark:bg-red-900/10' : undefined}>
      <td className="px-3 py-1.5 font-mono text-gray-700 dark:text-gray-300">{probe.ip}</td>
      <td className="px-3 py-1.5 text-gray-700 dark:text-gray-300">
        {probe.list}
        <div className="font-mono text-[10px] text-gray-400">{probe.zone}</div>
      </td>
      <td className="px-3 py-1.5">
        <SeverityChip severity={probe.severity} compact />
        {probe.reasonTxt && (
          <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-0.5 italic">{probe.reasonTxt}</div>
        )}
      </td>
      <td className="px-3 py-1.5">
        {probe.lookupUrl && (
          <a
            href={probe.lookupUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            Lookup <ExternalLink size={10} />
          </a>
        )}
      </td>
    </tr>
  );
}

// ── Generic probe card ─────────────────────────────────────────────────

function ProbeCard({
  title,
  severity,
  assertion,
  actual,
  expected,
  error,
  remediation,
}: {
  readonly title: string;
  readonly severity: DeliverabilityProbeSeverity;
  readonly assertion: string;
  readonly actual: string | null;
  readonly expected: string | null;
  readonly error: string | null;
  readonly remediation: string | null;
}) {
  const showAdvice = severity !== 'ok' && (remediation || error);
  return (
    <div className={`rounded-md border ${cardBorder(severity)} px-3 py-2.5`}>
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 shrink-0">
          <SeverityIcon severity={severity} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</div>
            <SeverityChip severity={severity} compact />
          </div>
          <div className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">{assertion}</div>
          {(actual || expected) && (
            <div className="grid grid-cols-[5rem_1fr] gap-x-2 gap-y-0.5 mt-1.5 text-xs">
              {expected && (
                <>
                  <div className="text-gray-500 dark:text-gray-400">Expected:</div>
                  <div className="text-gray-700 dark:text-gray-300 break-words">{expected}</div>
                </>
              )}
              {actual && (
                <>
                  <div className="text-gray-500 dark:text-gray-400">Actual:</div>
                  <div className="text-gray-700 dark:text-gray-300 break-words">{actual}</div>
                </>
              )}
            </div>
          )}
          {showAdvice && (
            <div className={`mt-2 rounded ${adviceBg(severity)} px-2.5 py-1.5 text-xs flex items-start gap-2`}>
              <ChevronRight size={12} className="mt-0.5 shrink-0" />
              <div className="flex-1">
                {error && <div className="font-medium mb-0.5">{error}</div>}
                {remediation}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Severity helpers ───────────────────────────────────────────────────

function SeverityIcon({ severity }: { readonly severity: DeliverabilityProbeSeverity }) {
  switch (severity) {
    case 'ok':       return <CheckCircle2 size={14} className="text-emerald-500" />;
    case 'warning':  return <AlertTriangle size={14} className="text-amber-500" />;
    case 'fail':     return <AlertTriangle size={14} className="text-red-500" />;
    case 'advisory': return <Info size={14} className="text-gray-400" />;
    case 'skipped':  return <ShieldCheck size={14} className="text-gray-300" />;
  }
}

function SeverityChip({ severity, compact = false }: { readonly severity: DeliverabilityProbeSeverity; readonly compact?: boolean }) {
  const styles: Record<DeliverabilityProbeSeverity, string> = {
    ok: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
    warning: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    fail: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    advisory: 'bg-gray-100 text-gray-600 dark:bg-gray-900/30 dark:text-gray-400',
    skipped: 'bg-gray-50 text-gray-500 dark:bg-gray-900/20 dark:text-gray-500',
  };
  return (
    <span className={`inline-block rounded ${styles[severity]} ${compact ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-xs'} font-medium uppercase tracking-wider`}>
      {severity}
    </span>
  );
}

/**
 * Cluster probes are binary (healthy: boolean) — there is no warning /
 * advisory / skipped on the existing 5 component shapes. Deliverability
 * sub-probes carry their own severity directly and DO NOT go through
 * this helper.
 */
function severityFromHealthy(h: boolean): DeliverabilityProbeSeverity {
  return h ? 'ok' : 'fail';
}

// Record-style lookup tables enforce exhaustive coverage at compile
// time. Adding a new severity to the api-contracts enum triggers a TS
// error here until the table is extended — preferable to a `default`
// arm that silently styles new severities as gray.
const CARD_BORDERS: Record<DeliverabilityProbeSeverity, string> = {
  fail:     'border-red-200 dark:border-red-800 bg-red-50/30 dark:bg-red-900/10',
  warning:  'border-amber-200 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-900/10',
  ok:       'border-gray-200 dark:border-gray-700',
  advisory: 'border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/20',
  skipped:  'border-dashed border-gray-200 dark:border-gray-700',
};

const ADVICE_BG: Record<DeliverabilityProbeSeverity, string> = {
  fail:     'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200',
  warning:  'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
  ok:       'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  advisory: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  skipped:  'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

function cardBorder(s: DeliverabilityProbeSeverity): string {
  return CARD_BORDERS[s];
}

function adviceBg(s: DeliverabilityProbeSeverity): string {
  return ADVICE_BG[s];
}

function rollupDeliverabilityCounts(d: MailHealthDeliverabilityComponent | undefined) {
  if (!d) return { ok: 0, warning: 0, fail: 0, advisory: 0, skipped: 0, total: 0 };
  return { ...d.summary, total: d.summary.ok + d.summary.warning + d.summary.fail + d.summary.advisory + d.summary.skipped };
}

