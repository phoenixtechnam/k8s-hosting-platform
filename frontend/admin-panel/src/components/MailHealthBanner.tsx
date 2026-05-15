import { useState } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useMailHealth, useRefreshMailHealth } from '@/hooks/use-mail-health';
import type {
  MailHealthResponse,
  MailHealthPodComponent,
  MailHealthJmapComponent,
  MailHealthRocksdbComponent,
  MailHealthCertComponent,
  MailHealthTcpComponent,
} from '@k8s-hosting/api-contracts';

/**
 * Live mail-server health banner.
 *
 * Replaces the cosmetic MailServerStatusTile that just echoed
 * system_settings without verifying state. This one actually calls
 * /admin/mail/health (real probes: pod readiness + JMAP HTTP probe;
 * RocksDB/cert/TCP shipping as `not_implemented` until Phase 3b).
 *
 * Visual:
 *   - One-line summary on top: green/red dot + "Mail server: OK" /
 *     "Mail server: DEGRADED — <reason>" + Refresh + drill-down chevron.
 *   - Expanded: per-component table (pod | jmap | rocksdb | cert | tcp)
 *     with status, key facts, and any error message.
 *
 * 2026-05-14 streamline: this banner is the top section of the
 * EmailManagement page. Future phases collapse the other ad-hoc tiles
 * (placement, port-exposure) into drill-downs reachable from this
 * banner.
 */
export default function MailHealthBanner() {
  const { data, isLoading, isError, error } = useMailHealth();
  const refresh = useRefreshMailHealth();
  const [open, setOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 size={14} className="animate-spin" /> Probing mail-server health…
      </div>
    );
  }

  if (isError || !data?.data) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 flex items-start gap-2 text-sm text-red-700 dark:text-red-300">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <div className="flex-1">
          <div className="font-medium">Health probe failed</div>
          <div className="text-xs opacity-80">
            {error instanceof Error ? error.message : 'Could not reach /admin/mail/health.'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="rounded-md border border-red-300 dark:border-red-700 px-2 py-0.5 text-xs disabled:opacity-50"
        >
          <RefreshCw size={11} className={refresh.isPending ? 'animate-spin' : undefined} /> Retry
        </button>
      </div>
    );
  }

  const r = data.data;
  // Avoid nested-<button> DOM (invalid HTML — keyboard nav stops at
  // the inner button, screen readers announce "button button"). The
  // disclosure trigger is a `<button>` covering only the label area;
  // the Re-check button is a sibling, not a child.
  return (
    <div className={`rounded-xl border ${r.healthy ? 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800' : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20'} shadow-sm`}>
      <div className="w-full flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="mail-health-banner-details"
          className="flex items-center gap-3 flex-1 min-w-0 text-left"
          data-testid="mail-health-banner"
        >
          {r.healthy
            ? <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
            : <AlertTriangle size={18} className="text-red-500 shrink-0" />
          }
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {r.healthy ? 'Mail server: OK' : 'Mail server: DEGRADED'}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {summaryLine(r)}
            </div>
          </div>
          {open
            ? <ChevronDown size={14} className="text-gray-400 shrink-0" />
            : <ChevronRight size={14} className="text-gray-400 shrink-0" />}
        </button>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="rounded-md border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 shrink-0"
          data-testid="mail-health-refresh"
          title="Bypass 30s cache and probe again"
        >
          <RefreshCw size={11} className={refresh.isPending ? 'animate-spin inline mr-1' : 'inline mr-1'} />
          Re-check
        </button>
      </div>

      {/* Always render the details panel so the `aria-controls` id on
          the disclosure trigger above resolves to a real element. The
          `hidden` attribute removes it from layout + the accessibility
          tree when closed, which is what WCAG 4.1.2 actually wants
          (orphaned aria-controls is an authoring error). */}
      <div
        id="mail-health-banner-details"
        hidden={!open}
        className="border-t border-gray-100 dark:border-gray-700 px-4 py-3 space-y-2 text-sm"
      >
          <PodRow data={r.components.pod} />
          <JmapRow data={r.components.jmap} />
          <RocksdbRow data={r.components.rocksdb} />
          <CertRow data={r.components.cert} />
          <TcpRow data={r.components.tcp} />
          <div className="pt-2 text-xs text-gray-500 dark:text-gray-400">
            Checked {timeAgo(r.checkedAt)} • Cached for {r.cachedFor}s • Use Re-check to bypass.
          </div>
      </div>
    </div>
  );
}

function summaryLine(r: MailHealthResponse): string {
  if (r.healthy) {
    const node = r.components.pod.node;
    return `Pod ready on ${node ?? 'unknown'} • JMAP responding in ${r.components.jmap.durationMs ?? '?'}ms`;
  }
  const firstFail =
    !r.components.pod.healthy ? r.components.pod.error :
    !r.components.jmap.healthy ? r.components.jmap.error :
    !r.components.rocksdb.healthy ? r.components.rocksdb.error :
    !r.components.cert.healthy ? r.components.cert.error :
    !r.components.tcp.healthy ? r.components.tcp.error :
    'unknown';
  return firstFail ?? 'one or more components unhealthy';
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  return `${Math.round(ms / 60_000)}m ago`;
}

function PodRow({ data: d }: { readonly data: MailHealthPodComponent }) {
  return (
    <Row label="Pod" healthy={d.healthy} error={d.error}>
      {d.podName ? (
        <>
          <span className="font-mono">{d.podName}</span>
          {d.node ? <> on <span className="font-mono">{d.node}</span></> : null}
          {d.phase ? ` • ${d.phase}` : ''}
          {d.containerReady === true ? ' • ready' : d.containerReady === false ? ' • not ready' : ''}
          {typeof d.restartCount === 'number' && d.restartCount > 0
            ? ` • ${d.restartCount} restart${d.restartCount === 1 ? '' : 's'}`
            : ''}
          {d.initContainerStatus ? <> • {d.initContainerStatus}</> : null}
        </>
      ) : '—'}
    </Row>
  );
}

function JmapRow({ data: d }: { readonly data: MailHealthJmapComponent }) {
  return (
    <Row label="JMAP" healthy={d.healthy} error={d.error}>
      {d.durationMs !== null ? `${d.durationMs}ms` : '—'}
      {d.serverName ? ` • ${d.serverName}` : ''}
      {d.serverVersion ? ` ${d.serverVersion}` : ''}
    </Row>
  );
}

function RocksdbRow({ data: d }: { readonly data: MailHealthRocksdbComponent }) {
  if (d.status === 'not_implemented') {
    return (
      <Row label="RocksDB" healthy={null} error={null}>
        <span className="text-gray-400 italic">probe not implemented yet</span>
      </Row>
    );
  }
  const parts: string[] = [];
  if (d.currentFile === true) parts.push('CURRENT ✓');
  else if (d.currentFile === false) parts.push('CURRENT ✗');
  if (d.lockFile === true) parts.push('LOCK ✓');
  else if (d.lockFile === false) parts.push('LOCK ✗');
  return (
    <Row label="RocksDB" healthy={d.healthy} error={d.error}>
      {parts.length > 0 ? parts.join(' • ') : (d.healthy ? 'ok' : 'failing')}
    </Row>
  );
}

function CertRow({ data: d }: { readonly data: MailHealthCertComponent }) {
  if (d.status === 'not_implemented') {
    return (
      <Row label="TLS certs" healthy={null} error={null}>
        <span className="text-gray-400 italic">no mail hostname configured</span>
      </Row>
    );
  }
  const minDays = d.ports.reduce<number | null>((acc, p) => {
    if (p.daysUntilExpiry === null) return acc;
    if (acc === null) return p.daysUntilExpiry;
    return Math.min(acc, p.daysUntilExpiry);
  }, null);
  return (
    <Row label="TLS certs" healthy={d.healthy} error={d.error}>
      {d.ports.length > 0
        ? <>
          {d.ports.map((p) => p.port).join(', ')}
          {minDays !== null && <> • expires in {minDays}d</>}
          {d.ports[0]?.issuer && <> • {d.ports[0].issuer}</>}
        </>
        : (d.healthy ? 'ok' : 'failing')}
    </Row>
  );
}

function TcpRow({ data: d }: { readonly data: MailHealthTcpComponent }) {
  if (d.status === 'not_implemented') {
    return (
      <Row label="TCP reach" healthy={null} error={null}>
        <span className="text-gray-400 italic">probe not implemented yet</span>
      </Row>
    );
  }
  const reachable = d.ports.filter((p) => p.reachable);
  const unreachable = d.ports.filter((p) => !p.reachable);
  const avgLatency = reachable.length > 0
    ? Math.round(
        reachable.reduce((s, p) => s + (p.latencyMs ?? 0), 0) / reachable.length,
      )
    : null;
  return (
    <Row label="TCP reach" healthy={d.healthy} error={d.error}>
      {reachable.length}/{d.ports.length} ports reachable
      {avgLatency !== null && <> • avg {avgLatency}ms</>}
      {unreachable.length > 0 && (
        <> • blocked: {unreachable.map((p) => p.port).join(', ')}</>
      )}
    </Row>
  );
}

function Row({
  label,
  healthy,
  error,
  children,
}: {
  readonly label: string;
  readonly healthy: boolean | null;
  readonly error: string | null;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[5rem_min-content_1fr] items-baseline gap-2">
      <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div>
        {healthy === true ? <CheckCircle2 size={12} className="text-emerald-500" />
          : healthy === false ? <AlertTriangle size={12} className="text-red-500" />
          : <span className="inline-block w-3 h-3 rounded-full bg-gray-300 dark:bg-gray-600" />}
      </div>
      <div className="text-xs text-gray-700 dark:text-gray-300">
        {children}
        {error ? <div className="text-red-600 dark:text-red-400 mt-0.5">{error}</div> : null}
      </div>
    </div>
  );
}
