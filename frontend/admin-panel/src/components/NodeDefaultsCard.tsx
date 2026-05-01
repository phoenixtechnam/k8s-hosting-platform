import { useEffect, useState } from 'react';
import { Server } from 'lucide-react';
import { useSystemSettings, useUpdateSystemSettings } from '@/hooks/use-system-settings';

/**
 * Cluster-level node defaults card. Sits at the top of the
 * "Cluster Settings" tab on the Nodes & Storage admin page.
 *
 * Currently exposes a single toggle:
 *   "New SERVER nodes host client workloads by default"
 *
 * Honoured by the cluster-side reconciler (backend/src/modules/nodes/
 * k8s-sync.ts). When a freshly-joined server node arrives without an
 * explicit `platform.phoenix-host.net/host-client-workloads` label,
 * the reconciler stamps the label using this default. Operator-set
 * explicit labels (via bootstrap.sh `--host-client-workloads`) are
 * never overridden.
 */
export default function NodeDefaultsCard() {
  const { data, isLoading, error } = useSystemSettings();
  const update = useUpdateSystemSettings();

  // Local mirror of the toggle so the switch responds instantly while
  // the PATCH round-trips. Re-synced from the server when the query
  // returns fresh data.
  const [pending, setPending] = useState<boolean | null>(null);
  const settings = data?.data;
  const serverValue = settings?.newServerHostsClientWorkloads ?? true;
  const value = pending ?? serverValue;

  useEffect(() => {
    if (settings) setPending(null);
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

      {update.isError && (
        <div className="text-sm text-red-700 dark:text-red-400">
          Failed to update node defaults — please try again.
        </div>
      )}
    </div>
  );
}
