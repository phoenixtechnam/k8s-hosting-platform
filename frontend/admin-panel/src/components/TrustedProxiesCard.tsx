/**
 * Trusted upstream-proxy CIDRs card — lives in the new
 * "Trusted Proxies" tab of /nodes-and-storage.
 *
 * Three row types, distinguished by `source`:
 *   - system    — RFC1918 + IPv6 ULA baseline. Shown for visibility,
 *                 always non-deletable. Read-only from the static
 *                 nginx template.
 *   - bootstrap — k3s pod/svc CIDR auto-detected at cluster bootstrap.
 *                 Auto-managed by the reconciler; UI delete disabled.
 *   - operator  — added by super_admin via this UI. Full CRUD.
 *
 * Rollout status: "panelPodsRolled / panelPodsTotal" shows how many
 * admin-panel + tenant-panel pods picked up the latest ConfigMap
 * content hash. Useful so the operator can see when the rolling
 * restart finishes after add/delete.
 */
import { useState } from 'react';
import { Shield, Plus, Trash2, RefreshCw, AlertCircle } from 'lucide-react';
import type { TrustedProxySource } from '@k8s-hosting/api-contracts';
import {
  useCreateTrustedProxy,
  useDeleteTrustedProxy,
  useTrustedProxies,
} from '@/hooks/use-trusted-proxies';

export default function TrustedProxiesCard() {
  const { data, isLoading, error, refetch, isFetching } = useTrustedProxies();
  const createMutation = useCreateTrustedProxy();
  const deleteMutation = useDeleteTrustedProxy();
  const [showAdd, setShowAdd] = useState(false);
  const [cidr, setCidr] = useState('');
  const [description, setDescription] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const onAdd = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFormError(null);
    if (!cidr.trim() || !description.trim()) {
      setFormError('CIDR and description are required.');
      return;
    }
    try {
      await createMutation.mutateAsync({
        cidr: cidr.trim(),
        description: description.trim(),
      });
      setCidr('');
      setDescription('');
      setShowAdd(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  const onDelete = async (id: string, cidrLabel: string): Promise<void> => {
    if (!confirm(`Remove trusted proxy ${cidrLabel}?\n\nThis will trigger a rolling restart of admin-panel and tenant-panel pods.`)) {
      return;
    }
    try {
      await deleteMutation.mutateAsync(id);
    } catch (err) {
      alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div
      className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 space-y-4"
      data-testid="trusted-proxies-card"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Shield className="text-brand-500 mt-0.5" size={20} />
          <div>
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              Trusted upstream proxies
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 max-w-2xl">
              CIDRs whose <code>X-Forwarded-For</code> header is honored
              by the cluster's nginx layer (admin / tenant panels) and
              Traefik (entry-point trustedIPs). Add the IP ranges of any
              CDN, L7 load balancer, or floating-IP gateway sitting in
              front of the cluster — otherwise the real client IP is
              hidden behind the upstream's pod IP, breaking CrowdSec L4
              enforcement, audit logs, and rate limiting.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-200"
          title="Refresh"
        >
          <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Rollout status pill */}
      {data && (
        <div className="text-xs text-gray-600 dark:text-gray-400 flex items-center gap-3 flex-wrap">
          <span>
            <strong>Panel pods rolled:</strong> {data.panelPodsRolled} / {data.panelPodsTotal}
            {data.panelPodsTotal > 0 && data.panelPodsRolled < data.panelPodsTotal && (
              <span className="ml-1 text-amber-600 dark:text-amber-400">
                (rolling…)
              </span>
            )}
          </span>
          {data.lastReconcileError && (
            <span className="text-red-600 dark:text-red-400 inline-flex items-center gap-1">
              <AlertCircle size={12} /> Reconcile error: {data.lastReconcileError}
            </span>
          )}
        </div>
      )}

      {isLoading && (
        <div className="text-xs text-gray-500 dark:text-gray-400">Loading…</div>
      )}
      {error && (
        <div className="text-xs text-red-600 dark:text-red-400">
          Load failed: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {/* Table */}
      {data && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs" data-testid="trusted-proxies-table">
            <thead>
              <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                <th className="py-2 pr-3">CIDR</th>
                <th className="py-2 pr-3">Description</th>
                <th className="py-2 pr-3">Source</th>
                <th className="py-2 pr-3">Added by</th>
                <th className="py-2 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {data.ranges.map((r) => (
                <tr
                  key={r.id ?? `${r.source}-${r.cidr}`}
                  className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                >
                  <td className="py-2 pr-3 font-mono text-gray-900 dark:text-gray-100">
                    {r.cidr}
                  </td>
                  <td className="py-2 pr-3 text-gray-700 dark:text-gray-300">
                    {r.description}
                  </td>
                  <td className="py-2 pr-3">
                    <SourceBadge source={r.source} />
                  </td>
                  <td className="py-2 pr-3 text-gray-500 dark:text-gray-400">
                    {r.createdByEmail ?? <span className="opacity-60">—</span>}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    {r.source === 'operator' && r.id ? (
                      <button
                        type="button"
                        onClick={() => onDelete(r.id!, r.cidr)}
                        disabled={deleteMutation.isPending}
                        className="inline-flex items-center gap-1 rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 px-2 py-1 text-[11px] text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/50 disabled:opacity-50"
                        data-testid={`delete-trusted-proxy-${r.id}`}
                      >
                        <Trash2 size={12} /> Delete
                      </button>
                    ) : (
                      <span className="text-[11px] text-gray-400 dark:text-gray-500 italic">
                        auto-managed
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {data.ranges.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-gray-500 dark:text-gray-400">
                    No trusted proxies configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Add form */}
      {!showAdd && (
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
          data-testid="add-trusted-proxy-button"
        >
          <Plus size={14} /> Add trusted proxy
        </button>
      )}
      {showAdd && (
        <form
          onSubmit={onAdd}
          className="rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3 space-y-3"
          data-testid="add-trusted-proxy-form"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1">
                CIDR
              </label>
              <input
                type="text"
                value={cidr}
                onChange={(e) => setCidr(e.target.value)}
                placeholder="e.g. 173.245.48.0/20"
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs font-mono"
                data-testid="add-trusted-proxy-cidr"
              />
              <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">
                IPv4/v6 address or CIDR. <code>/0</code> is rejected.
              </p>
            </div>
            <div>
              <label className="block text-[11px] font-medium text-gray-700 dark:text-gray-300 mb-1">
                Description
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Cloudflare edge"
                maxLength={200}
                className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1 text-xs"
                data-testid="add-trusted-proxy-description"
              />
            </div>
          </div>
          {formError && (
            <div className="text-[11px] text-red-700 dark:text-red-400">
              {formError}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              data-testid="add-trusted-proxy-submit"
            >
              {createMutation.isPending ? 'Adding…' : 'Add'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowAdd(false);
                setFormError(null);
                setCidr('');
                setDescription('');
              }}
              className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function SourceBadge({ source }: { source: TrustedProxySource }) {
  const map: Record<TrustedProxySource, { label: string; cls: string }> = {
    system: {
      label: 'system',
      cls: 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
    },
    bootstrap: {
      label: 'bootstrap',
      cls: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
    },
    operator: {
      label: 'operator',
      cls: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300',
    },
  };
  const { label, cls } = map[source];
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {label}
    </span>
  );
}
