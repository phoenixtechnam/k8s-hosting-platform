import { useState, useEffect, useRef } from 'react';
import { Scale, Loader2, AlertCircle, CheckCircle, ShieldAlert, Info, Save } from 'lucide-react';
import clsx from 'clsx';
import { useLoadBalancer, useUpdateLoadBalancer, type LoadBalancerProvider } from '@/hooks/use-load-balancer';
import { useClusterHealth } from '@/hooks/use-cluster-health';

export default function LoadBalancerSettings() {
  const { data, isLoading, error } = useLoadBalancer();
  const update = useUpdateLoadBalancer();
  const status = data?.data;

  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<LoadBalancerProvider>('null');

  // Seed local state ONCE when the query first resolves. Watching the
  // resolved fields in deps would clobber unsaved edits whenever a
  // background refetch finishes.
  const seeded = useRef(false);
  useEffect(() => {
    if (!status || seeded.current) return;
    setEnabled(status.enabled);
    setProvider(status.provider);
    seeded.current = true;
  }, [status]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={24} className="animate-spin text-brand-500" />
      </div>
    );
  }

  if (error || !status) {
    return (
      <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200">
        <AlertCircle size={16} className="mr-1 inline" /> Failed to load Load Balancer settings.
      </div>
    );
  }

  const gateMet = status.haGate.met;
  const hasChanges = enabled !== status.enabled || provider !== status.provider;
  const updErr = update.error as { message?: string } | null;

  const save = async () => {
    try {
      await update.mutateAsync({ enabled, provider });
    } catch {
      // Error is surfaced via update.error below; swallow so the
      // onClick handler doesn't emit an unhandled promise rejection.
    }
  };

  return (
    <div className="space-y-6" data-testid="load-balancer-settings-page">
      <div className="flex items-center gap-3">
        <Scale size={28} className="text-brand-500" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Load Balancer</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Vendor-neutral by default (DNS-RR across servers). Enable a provider-managed LB only in a full 3+ server HA state.
          </p>
        </div>
      </div>

      {/* HA gate badge */}
      <div className={clsx(
        'rounded-xl border p-4 text-sm',
        gateMet
          ? 'border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-900/30'
          : 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/30',
      )}>
        <div className="flex items-start gap-2">
          {gateMet
            ? <CheckCircle size={18} className="mt-0.5 shrink-0 text-green-600 dark:text-green-400" />
            : <ShieldAlert size={18} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />}
          <div>
            <div className={clsx(
              'font-medium',
              gateMet ? 'text-green-900 dark:text-green-200' : 'text-amber-900 dark:text-amber-200',
            )}>
              HA gate: {status.haGate.current} / {status.haGate.required} live server nodes
            </div>
            <p className={clsx(
              'mt-0.5 text-xs',
              gateMet ? 'text-green-800 dark:text-green-300' : 'text-amber-800 dark:text-amber-300',
            )}>
              {gateMet
                ? 'Cluster is in HA state — LB activation is allowed.'
                : `Need ${status.haGate.required - status.haGate.current} more server(s) before enabling.`}
            </p>
          </div>
        </div>
      </div>

      {/* Toggle + provider */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">Configuration</h2>

        <div className="space-y-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={!gateMet}
              className="mt-0.5"
              data-testid="lb-enabled-checkbox"
            />
            <div>
              <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Enable Load Balancer</div>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                When off, traffic uses direct DNS to server nodes (ADR-031's default).
                {!gateMet && ' Locked until the HA gate is met.'}
              </p>
            </div>
          </label>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Provider</label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as LoadBalancerProvider)}
              className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              data-testid="lb-provider-select"
            >
              <option value="null">Null — no external LB (DNS-RR only)</option>
              <option value="hetzner">Hetzner Cloud (not yet implemented)</option>
              <option value="aws">AWS ELBv2 (not yet implemented)</option>
              <option value="metallb">MetalLB (not yet implemented)</option>
            </select>
            {provider !== 'null' && (
              <p className="mt-1 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                <Info size={12} /> This provider is stubbed. Enabling it will surface unhealthy status until a real implementation lands.
              </p>
            )}
          </div>
        </div>

        {updErr && (
          <p className="mt-3 text-xs text-red-600 dark:text-red-400">
            <AlertCircle size={12} className="mr-1 inline" />
            {updErr.message}
          </p>
        )}
        {update.isSuccess && !hasChanges && (
          <p className="mt-3 text-xs text-green-600 dark:text-green-400">
            <CheckCircle size={12} className="mr-1 inline" />
            Saved.
          </p>
        )}

        <div className="mt-5 flex items-center justify-end">
          <button
            type="button"
            onClick={save}
            disabled={!hasChanges || update.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            data-testid="lb-save-button"
          >
            {update.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save
          </button>
        </div>
      </div>

      {/* Live status message */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <h2 className="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">Status</h2>
        <p className="text-sm text-gray-700 dark:text-gray-300">{status.message}</p>
      </div>

      <ClusterHealthCard />
    </div>
  );
}

function ClusterHealthCard() {
  const { data, isLoading } = useClusterHealth();
  const components = data?.data.components ?? [];

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100">Cluster infrastructure health</h2>
      <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
        Live Deployment/DaemonSet readiness for the components that underpin the platform — cert-manager, ingress-nginx,
        Flux, Longhorn, CloudNative-PG. Refreshes every 30 seconds.
      </p>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : components.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">No components tracked.</p>
      ) : (
        <ul className="divide-y divide-gray-100 text-sm dark:divide-gray-700">
          {components.map((c) => (
            <li key={`${c.namespace}/${c.name}`} className="flex items-center justify-between py-2">
              <div>
                <div className="font-medium text-gray-900 dark:text-gray-100">{c.name}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {c.namespace} · {c.kind}{c.message ? ` · ${c.message}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
                  {c.ready}/{c.desired}
                </span>
                {c.healthy ? (
                  <CheckCircle size={16} className="text-green-600 dark:text-green-400" />
                ) : (
                  <AlertCircle size={16} className="text-amber-600 dark:text-amber-400" />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
