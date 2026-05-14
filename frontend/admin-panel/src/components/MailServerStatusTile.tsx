/**
 * MailServerStatusTile — at-a-glance summary of the mail-server runtime.
 *
 * Single tile rendered at the top of EmailManagement.tsx so an operator
 * lands on a one-screen answer to "is mail healthy right now?":
 *
 *   • Where the pod runs + pod ready/total
 *   • Port-exposure mode + haproxy DS health (mirrors MailPortExposureCard's
 *     decision tree so the indicator semantics match across the page)
 *   • PVC storage usage vs capacity (color-coded against thresholds)
 *   • SSL/TLS cell is a clickable pill — opens MailSslStatusModal
 *     where the on-demand 6-handshake probe runs. The probe is
 *     gated behind operator click because it's ~1s and noisy to
 *     fire on every page mount.
 *
 * Failure modes:
 *   Any underlying query may fail (RBAC mismatch, k8s API hiccup, etc.).
 *   The tile renders each cell independently — a single bad query
 *   doesn't blank the whole tile, only its own cell.
 */

import { useState } from 'react';
import { Server, Network, HardDrive, ShieldCheck, AlertTriangle } from 'lucide-react';
import { useMailPlacement } from '@/hooks/use-mail-placement';
import { useMailPortExposure } from '@/hooks/use-mail-port-exposure';
import { useMailPvcStorage } from '@/hooks/use-mail-storage';
import MailSslStatusModal from './MailSslStatusModal';

export default function MailServerStatusTile() {
  const placement = useMailPlacement();
  const portExposure = useMailPortExposure();
  const storage = useMailPvcStorage();
  const [sslModalOpen, setSslModalOpen] = useState(false);

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5">
      <div className="flex items-center gap-2 mb-4">
        <Server size={18} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          Mail Server Status
        </h2>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <PodCell placement={placement} />
        <PortExposureCell portExposure={portExposure} />
        <StorageCell storage={storage} />
        <SslCell onOpen={() => setSslModalOpen(true)} />
      </div>

      {sslModalOpen ? (
        <MailSslStatusModal onClose={() => setSslModalOpen(false)} />
      ) : null}
    </div>
  );
}

// ── Cells ────────────────────────────────────────────────────────────────────

function PodCell({ placement }: { placement: ReturnType<typeof useMailPlacement> }) {
  const data = placement.data?.data;
  if (placement.isLoading) {
    return <CellSkeleton icon={Server} label="Pod" />;
  }
  if (placement.isError || !data) {
    return <CellError icon={Server} label="Pod" message="Could not read placement" />;
  }
  const active = data.activeNode ?? data.primaryNode;
  const isPaired = Boolean(data.secondaryNode);
  const drState = data.drState;
  const drColor =
    drState === 'healthy' ? 'text-green-600 dark:text-green-400'
    : drState === 'failed-over' ? 'text-amber-600 dark:text-amber-400'
    : 'text-red-600 dark:text-red-400';

  return (
    <Cell icon={Server} label="Pod">
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {active ?? '(unscheduled)'}
      </div>
      <div className="mt-0.5 text-xs flex items-center gap-1.5">
        <span className={drColor}>● {drState}</span>
        {isPaired ? (
          <span className="text-gray-500 dark:text-gray-400">
            → {data.secondaryNode}{data.tertiaryNode ? ` → ${data.tertiaryNode}` : ''}
          </span>
        ) : (
          <span className="text-gray-400 dark:text-gray-500">no failover</span>
        )}
      </div>
    </Cell>
  );
}

function PortExposureCell({ portExposure }: { portExposure: ReturnType<typeof useMailPortExposure> }) {
  const data = portExposure.data?.data;
  if (portExposure.isLoading) {
    return <CellSkeleton icon={Network} label="Port exposure" />;
  }
  if (portExposure.isError || !data) {
    return <CellError icon={Network} label="Port exposure" message="Could not read port config" />;
  }

  const ds = data.daemonSetStatus;
  let modeText: string;
  let dotColor: string;
  let detail: string;
  if (data.mode === 'thisNodeOnly') {
    modeText = 'This node only';
    dotColor = 'bg-green-500';
    detail = 'hostPort on Stalwart pod';
  } else if (!ds) {
    modeText = 'All server nodes';
    dotColor = 'bg-amber-500';
    detail = 'haproxy DS not yet visible';
  } else if (ds.desired === 0) {
    modeText = 'All server nodes';
    dotColor = 'bg-red-500';
    detail = 'haproxy: no nodes match nodeSelector';
  } else if (ds.ready === ds.desired) {
    modeText = 'All server nodes';
    dotColor = 'bg-green-500';
    detail = `haproxy: ${ds.ready}/${ds.desired} pods ready`;
  } else if (ds.ready === 0) {
    modeText = 'All server nodes';
    dotColor = 'bg-red-500';
    detail = `haproxy: 0/${ds.desired} pods ready`;
  } else {
    modeText = 'All server nodes';
    dotColor = 'bg-amber-500';
    detail = `haproxy: ${ds.ready}/${ds.desired} pods rolling`;
  }

  return (
    <Cell icon={Network} label="Port exposure">
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{modeText}</div>
      <div className="mt-0.5 text-xs flex items-center gap-1.5">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotColor}`} />
        <span className="text-gray-500 dark:text-gray-400">{detail}</span>
      </div>
    </Cell>
  );
}

function StorageCell({ storage }: { storage: ReturnType<typeof useMailPvcStorage> }) {
  const data = storage.data?.data;
  if (storage.isLoading) {
    return <CellSkeleton icon={HardDrive} label="Storage" />;
  }
  if (storage.isError || !data) {
    return <CellError icon={HardDrive} label="Storage" message="Could not read PVC" />;
  }

  const used = data.usedBytes ?? 0;
  const cap = data.capacityBytes;
  const pct = cap > 0 ? Math.round((used / cap) * 100) : 0;
  const dotColor =
    pct < 70 ? 'bg-green-500'
    : pct < 90 ? 'bg-amber-500'
    : 'bg-red-500';

  return (
    <Cell icon={HardDrive} label="Storage">
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
        {formatBytes(used)} <span className="text-xs text-gray-500">of {formatBytes(cap)}</span>
      </div>
      <div className="mt-0.5 text-xs flex items-center gap-1.5">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotColor}`} />
        <span className="text-gray-500 dark:text-gray-400">{pct}% used · class {data.storageClass}</span>
      </div>
    </Cell>
  );
}

function SslCell({ onOpen }: { readonly onOpen: () => void }) {
  // The probe is on-demand (~1s, 6 parallel TCP+TLS handshakes) — we
  // don't auto-fire it on page mount. Click the cell to open the
  // detail modal which is where the probe actually runs.
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="mail-status-tile-ssl-open"
      className="text-left rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors cursor-pointer"
    >
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1.5">
        <ShieldCheck size={12} />
        <span>TLS / SSL</span>
      </div>
      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
        Click to check
      </div>
      <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
        Per-listener TLS handshake probe
      </div>
    </button>
  );
}

// ── Generic cell scaffolding ─────────────────────────────────────────────────

function Cell({
  icon: Icon,
  label,
  children,
}: {
  readonly icon: typeof Server;
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1.5">
        <Icon size={12} />
        <span>{label}</span>
      </div>
      {children}
    </div>
  );
}

function CellSkeleton({ icon: Icon, label }: { readonly icon: typeof Server; readonly label: string }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3 animate-pulse">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1.5">
        <Icon size={12} />
        <span>{label}</span>
      </div>
      <div className="h-4 w-24 bg-gray-200 dark:bg-gray-700 rounded" />
      <div className="mt-1 h-3 w-32 bg-gray-200 dark:bg-gray-700 rounded" />
    </div>
  );
}

function CellError({
  icon: Icon,
  label,
  message,
}: {
  readonly icon: typeof Server;
  readonly label: string;
  readonly message: string;
}) {
  return (
    <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-red-600 dark:text-red-400 mb-1.5">
        <Icon size={12} />
        <span>{label}</span>
      </div>
      <div className="flex items-start gap-1.5 text-xs text-red-700 dark:text-red-300">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
        <span>{message}</span>
      </div>
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
