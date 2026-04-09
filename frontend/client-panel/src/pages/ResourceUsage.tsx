import { Cpu, MemoryStick, HardDrive, Gauge, Mail, Loader2, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { useClientContext } from '@/hooks/use-client-context';
import { useResourceMetrics, useRefreshMetrics } from '@/hooks/use-resource-metrics';
import { useMailboxUsage } from '@/hooks/use-email';
import { useSubscription } from '@/hooks/use-subscription';

/**
 * Round-4 Phase C: dedicated Resource Usage dashboard.
 *
 * Gap scan HIGH-5: the backend exposes
 * `GET /api/v1/clients/:id/resource-metrics` and
 * `GET /api/v1/clients/:id/resource-availability` but the client
 * panel only consumed them inside:
 *   1. The header ResourceUsagePanel pill (quick summary)
 *   2. The ResourceMetricsModal (popup, no permalink)
 *   3. The ResourceRequirementCheck component (deployment gate)
 *
 * This new page gives clients a permalink dashboard view of their
 * plan limits vs actual usage across CPU, memory, storage, and
 * mail accounts. Plan limits come from the subscription endpoint
 * added alongside this phase; metrics come from the existing
 * useResourceMetrics hook.
 */
export default function ResourceUsage() {
  const { clientId } = useClientContext();
  const { data: metricsData, isLoading: metricsLoading } = useResourceMetrics();
  const refresh = useRefreshMetrics();
  const { data: mailboxUsageData } = useMailboxUsage(clientId ?? undefined);
  const { data: subscriptionData } = useSubscription(clientId ?? undefined);

  const metrics = metricsData?.data;
  const mailboxUsage = mailboxUsageData?.data;
  const subscription = subscriptionData?.data;
  const plan = subscription?.plan;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Gauge size={28} className="text-gray-700 dark:text-gray-300" />
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="resource-usage-heading">
              Resource Usage
            </h1>
            {plan && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Limits from your <span className="font-semibold">{plan.name}</span> plan
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          data-testid="refresh-button"
        >
          <RefreshCw size={14} className={refresh.isPending ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {metricsLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="animate-spin text-brand-500" />
        </div>
      )}

      {!metricsLoading && !metrics && (
        <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 px-5 py-12 text-center text-sm text-gray-500 dark:text-gray-400">
          No metrics data available. Metrics are collected every 60 seconds — try
          refreshing in a moment.
        </div>
      )}

      {metrics && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ResourceCard
            icon={<Cpu size={18} className="text-blue-500 dark:text-blue-400" />}
            label="CPU"
            inUse={metrics.cpu.inUse}
            reserved={metrics.cpu.reserved}
            available={metrics.cpu.available}
            unit="cores"
            formatValue={formatCpu}
            testId="cpu-card"
          />
          <ResourceCard
            icon={<MemoryStick size={18} className="text-purple-500 dark:text-purple-400" />}
            label="Memory"
            inUse={metrics.memory.inUse}
            reserved={metrics.memory.reserved}
            available={metrics.memory.available}
            unit="GB"
            formatValue={formatBytes}
            testId="memory-card"
          />
          <ResourceCard
            icon={<HardDrive size={18} className="text-emerald-500 dark:text-emerald-400" />}
            label="Storage"
            inUse={metrics.storage.inUse}
            reserved={metrics.storage.reserved}
            available={metrics.storage.available}
            unit="GB"
            formatValue={formatBytes}
            testId="storage-card"
          />
          {mailboxUsage && (
            <div
              className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm"
              data-testid="mailbox-card"
            >
              <div className="mb-3 flex items-center gap-2">
                <Mail size={18} className="text-rose-500 dark:text-rose-400" />
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  Mail Accounts
                </h2>
              </div>
              <MailProgressBar
                current={mailboxUsage.current}
                limit={mailboxUsage.limit}
                source={mailboxUsage.source}
              />
            </div>
          )}
        </div>
      )}

      {metrics && (
        <p className="text-xs text-gray-400 dark:text-gray-500 text-right">
          Last updated: {new Date(metrics.lastUpdatedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}

function ResourceCard({
  icon,
  label,
  inUse,
  reserved,
  available,
  unit,
  formatValue,
  testId,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly inUse: number;
  readonly reserved: number;
  readonly available: number;
  readonly unit: string;
  readonly formatValue: (v: number) => string;
  readonly testId: string;
}) {
  // Progress metric: in-use divided by plan limit (available).
  const pct = available > 0 ? Math.min(100, (inUse / available) * 100) : 0;
  const reservedPct = available > 0 ? Math.min(100, (reserved / available) * 100) : 0;
  const atWarning = pct >= 80;
  const atCritical = pct >= 100;
  const barColor = atCritical
    ? 'bg-red-500 dark:bg-red-400'
    : atWarning
      ? 'bg-amber-500 dark:bg-amber-400'
      : 'bg-brand-500 dark:bg-brand-400';

  return (
    <div
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm"
      data-testid={testId}
    >
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{label}</h2>
      </div>

      <div className="mb-3 flex items-baseline gap-2">
        <span className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {formatValue(inUse)}
        </span>
        <span className="text-sm text-gray-500 dark:text-gray-400">
          / {formatValue(available)} {unit}
        </span>
        <span className="ml-auto text-sm font-medium text-gray-600 dark:text-gray-300">
          {pct.toFixed(0)}%
        </span>
      </div>

      {/* Stacked bar: reserved (lighter), in-use (solid) */}
      <div className="relative h-3 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        {/* Reserved track */}
        <div
          className="absolute inset-y-0 left-0 bg-gray-300 dark:bg-gray-600"
          style={{ width: `${reservedPct}%` }}
        />
        {/* In-use bar on top */}
        <div
          className={clsx('absolute inset-y-0 left-0 transition-all', barColor)}
          style={{ width: `${pct}%` }}
        />
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-gray-500 dark:text-gray-400">In use</dt>
          <dd className="font-medium text-gray-900 dark:text-gray-100">{formatValue(inUse)}</dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Reserved</dt>
          <dd className="font-medium text-gray-900 dark:text-gray-100">{formatValue(reserved)}</dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Available</dt>
          <dd className="font-medium text-gray-900 dark:text-gray-100">{formatValue(available)}</dd>
        </div>
      </dl>

      {atCritical && (
        <p className="mt-3 rounded-md bg-red-50 dark:bg-red-900/20 px-3 py-1.5 text-xs text-red-600 dark:text-red-400">
          Plan limit reached. Upgrade or free up resources.
        </p>
      )}
      {atWarning && !atCritical && (
        <p className="mt-3 rounded-md bg-amber-50 dark:bg-amber-900/20 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400">
          Approaching plan limit.
        </p>
      )}
    </div>
  );
}

function MailProgressBar({
  current,
  limit,
  source,
}: {
  readonly current: number;
  readonly limit: number;
  readonly source: 'plan' | 'client_override';
}) {
  const pct = limit > 0 ? Math.min(100, (current / limit) * 100) : 0;
  const atCritical = pct >= 100;
  const atWarning = pct >= 80;
  const barColor = atCritical
    ? 'bg-red-500'
    : atWarning
      ? 'bg-amber-500'
      : 'bg-rose-500';

  return (
    <>
      <div className="mb-3 flex items-baseline gap-2">
        <span className="text-2xl font-bold text-gray-900 dark:text-gray-100">{current}</span>
        <span className="text-sm text-gray-500 dark:text-gray-400">/ {limit} mailboxes</span>
        <span className="ml-auto text-sm font-medium text-gray-600 dark:text-gray-300">
          {pct.toFixed(0)}%
        </span>
      </div>
      <div className="h-3 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <div
          className={clsx('h-3 rounded-full transition-all', barColor)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
        {source === 'client_override' ? 'Limit set by per-client override' : 'Limit from hosting plan'}
      </p>
    </>
  );
}

function formatCpu(value: number): string {
  if (value >= 10) return value.toFixed(0);
  if (value >= 1) return value.toFixed(1);
  return value.toFixed(2);
}

function formatBytes(valueGi: number): string {
  if (valueGi <= 0) return '0';
  if (valueGi < 1) {
    const mi = valueGi * 1024;
    if (mi >= 100) return `${mi.toFixed(0)} Mi`;
    return `${mi.toFixed(1)} Mi`;
  }
  if (valueGi >= 10) return valueGi.toFixed(0);
  return valueGi.toFixed(1);
}
