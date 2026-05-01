import { useEffect, useState } from 'react';
import { Server } from 'lucide-react';
import { useSystemSettings, useUpdateSystemSettings } from '@/hooks/use-system-settings';

/**
 * Cluster-level node defaults card. Sits at the top of the
 * "Cluster Settings" tab on the Nodes & Storage admin page.
 *
 * Exposes:
 *   1. Toggle: "New SERVER nodes host client workloads by default"
 *   2. Image cache GC: start-at threshold (imageGcHighThreshold)
 *   3. Image cache GC: stop-at threshold (imageGcLowThreshold)
 *   4. Image min retain (imageGcMinTtlMinutes)
 *
 * The GC thresholds are applied via bootstrap.sh --kubelet-arg flags on new
 * nodes. Existing nodes keep their current values until rebooted (Phase 2
 * reconciler will handle live updates).
 */
export default function NodeDefaultsCard() {
  const { data, isLoading, error } = useSystemSettings();
  const update = useUpdateSystemSettings();

  // Local mirror of the toggle so the switch responds instantly while
  // the PATCH round-trips. Re-synced from the server when the query
  // returns fresh data.
  const [pending, setPending] = useState<boolean | null>(null);

  // Local mirrors for numeric GC fields
  const [gcHigh, setGcHigh] = useState<number | null>(null);
  const [gcLow, setGcLow] = useState<number | null>(null);
  const [gcMinTtl, setGcMinTtl] = useState<number | null>(null);
  const [gcError, setGcError] = useState<string | null>(null);

  const settings = data?.data;
  const serverValue = settings?.newServerHostsClientWorkloads ?? true;
  const value = pending ?? serverValue;

  const highVal = gcHigh ?? settings?.imageGcHighThreshold ?? 70;
  const lowVal = gcLow ?? settings?.imageGcLowThreshold ?? 60;
  const minTtlVal = gcMinTtl ?? settings?.imageGcMinTtlMinutes ?? 60;

  useEffect(() => {
    if (settings) {
      setPending(null);
      setGcHigh(null);
      setGcLow(null);
      setGcMinTtl(null);
    }
  }, [settings]);

  if (isLoading) {
    return (
      <div
        className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm"
        data-testid="node-defaults-card"
      >
        <div className="text-gray-500 dark:text-gray-400">Loading node defaults…</div>
      </div>
    );
  }

  if (error || !settings) {
    return (
      <div
        className="rounded-xl border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-5"
        data-testid="node-defaults-card"
      >
        <div className="text-red-700 dark:text-red-300">Failed to load node defaults.</div>
      </div>
    );
  }

  const onToggle = async (next: boolean): Promise<void> => {
    setPending(next);
    try {
      await update.mutateAsync({ newServerHostsClientWorkloads: next });
    } catch {
      // Roll back the optimistic local state — the query will refetch
      // and confirm the persisted value either way.
      setPending(null);
    }
  };

  const onSaveGcSettings = async (): Promise<void> => {
    setGcError(null);
    if (highVal <= lowVal) {
      setGcError('"Start at" threshold must be greater than "Stop at" threshold.');
      return;
    }
    if (highVal < 50 || highVal > 95 || lowVal < 40 || lowVal > 94 || minTtlVal < 0 || minTtlVal > 1440) {
      setGcError('Values out of valid range.');
      return;
    }
    try {
      await update.mutateAsync({
        imageGcHighThreshold: highVal,
        imageGcLowThreshold: lowVal,
        imageGcMinTtlMinutes: minTtlVal,
      });
    } catch {
      setGcError('Failed to save GC settings — please try again.');
    }
  };

  return (
    <div
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4"
      data-testid="node-defaults-card"
    >
      <div className="flex items-center gap-3">
        <Server size={20} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Node Defaults</h2>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        Defaults applied automatically when a fresh node joins the cluster. Operator-set
        bootstrap flags always win — these only fill in the gap when no explicit choice
        was made on the joining host.
      </p>

      {/* ── Toggle: new server hosts client workloads ── */}
      <div className="flex items-start justify-between gap-4 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex-1">
          <label
            htmlFor="new-server-hosts-clients-toggle"
            className="block text-sm font-medium text-gray-900 dark:text-gray-100"
          >
            New SERVER nodes host client workloads by default
          </label>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            When ON, freshly-joined server nodes are labelled to host tenant pods just
            like a worker. When OFF, the same servers are restricted to platform-only
            workloads (server-only NoSchedule taint applied).
          </p>
        </div>
        <button
          id="new-server-hosts-clients-toggle"
          data-testid="new-server-hosts-clients-toggle"
          type="button"
          role="switch"
          aria-checked={value}
          disabled={update.isPending}
          onClick={() => onToggle(!value)}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${
            value ? 'bg-brand-500' : 'bg-gray-300 dark:bg-gray-600'
          }`}
        >
          <span
            aria-hidden="true"
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
              value ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {/* ── Kubelet image-GC thresholds ── */}
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-4">
        <div>
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Image cache garbage collection
          </h3>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Kubelet starts evicting images when disk usage exceeds the <em>Start at</em> threshold and
            stops when it drops below <em>Stop at</em>. Images newer than <em>Min retain</em> minutes
            are never evicted regardless of disk pressure.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label
              htmlFor="gc-high-threshold"
              className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Start at (% disk used)
            </label>
            <input
              id="gc-high-threshold"
              data-testid="gc-high-threshold"
              type="number"
              min={50}
              max={95}
              value={highVal}
              disabled={update.isPending}
              onChange={e => setGcHigh(Number(e.target.value))}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-60"
            />
          </div>

          <div>
            <label
              htmlFor="gc-low-threshold"
              className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Stop at (% disk used)
            </label>
            <input
              id="gc-low-threshold"
              data-testid="gc-low-threshold"
              type="number"
              min={40}
              max={94}
              value={lowVal}
              disabled={update.isPending}
              onChange={e => setGcLow(Number(e.target.value))}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-60"
            />
          </div>

          <div>
            <label
              htmlFor="gc-min-ttl"
              className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              Min retain (minutes)
            </label>
            <input
              id="gc-min-ttl"
              data-testid="gc-min-ttl"
              type="number"
              min={0}
              max={1440}
              value={minTtlVal}
              disabled={update.isPending}
              onChange={e => setGcMinTtl(Number(e.target.value))}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-60"
            />
          </div>
        </div>

        {gcError && (
          <p className="text-xs text-red-700 dark:text-red-400">{gcError}</p>
        )}

        <div className="flex items-center justify-between gap-4">
          <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded px-3 py-1.5 flex-1">
            Changes apply to nodes added after the next k3s restart. Existing nodes keep
            their current values until rebooted.
          </p>
          <button
            type="button"
            data-testid="save-gc-settings"
            disabled={update.isPending}
            onClick={onSaveGcSettings}
            className="shrink-0 rounded-md bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {update.isError && !gcError && (
        <div className="text-sm text-red-700 dark:text-red-400">
          Failed to update node defaults — please try again.
        </div>
      )}
    </div>
  );
}
