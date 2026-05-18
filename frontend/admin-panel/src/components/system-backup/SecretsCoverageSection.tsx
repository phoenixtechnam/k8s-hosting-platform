/**
 * Coverage audit panel (DR-bundle roadmap, Phase 0).
 *
 * Rendered inside SecretsBundleTab. Surfaces every Secret in the
 * cluster that ISN'T covered by any backup mechanism (Tier-1
 * bundle list, Tier-2 namespace sweep, or operator allowlist).
 *
 * UX:
 *   - Top banner: green = healthy, red = uncovered > 0
 *   - Summary chips: 5 categories with counts
 *   - Table: every UNCOVERED Secret with "Add to allowlist" CTA
 *   - Modal: prompts for a reason (≥10 chars), creates the
 *     allowlist entry, then re-fetches the audit
 *   - Collapsible: ALLOWLISTED entries for transparency
 */

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, Shield, Plus, Trash2 } from 'lucide-react';
import type { AuditedSecret } from '@k8s-hosting/api-contracts';
import {
  useAddAllowlistEntry,
  useRefreshSecretsAudit,
  useRemoveAllowlistEntry,
  useSecretsAudit,
  useSecretsAuditAllowlist,
} from '@/hooks/use-system-backup';

export default function SecretsCoverageSection() {
  const auditQ = useSecretsAudit();
  const allowlistQ = useSecretsAuditAllowlist();
  const refresh = useRefreshSecretsAudit();
  const removeEntry = useRemoveAllowlistEntry();
  const [modal, setModal] = useState<AuditedSecret | null>(null);

  const audit = auditQ.data;

  return (
    <section className="space-y-4" data-testid="secrets-coverage">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield size={20} className="text-brand-600 dark:text-brand-400" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Coverage Audit</h3>
        </div>
        <button
          type="button"
          onClick={() => void refresh.mutateAsync()}
          disabled={refresh.isPending}
          className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          data-testid="secrets-audit-refresh"
        >
          <RefreshCw size={14} className={refresh.isPending ? 'animate-spin' : ''} />
          Re-audit
        </button>
      </header>

      <p className="text-sm text-gray-600 dark:text-gray-400 max-w-3xl">
        Every Secret in the cluster falls into one of five buckets. <strong>Uncovered</strong> Secrets
        represent silent DR-readiness risk: they exist now but no backup mechanism captures them.
        Resolve each by either extending <code>BUNDLE_SECRET_LIST</code> in the backend (preferred)
        or adding to the allowlist below with a documented reason.
      </p>

      {auditQ.isLoading && <Skeleton />}
      {auditQ.isError && (
        <div className="rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-900 dark:text-red-200">
          Failed to load audit: {auditQ.error instanceof Error ? auditQ.error.message : String(auditQ.error)}
        </div>
      )}

      {audit && (
        <>
          <HealthBanner uncovered={audit.byCategory.uncovered} total={audit.totalSecretsCount} generatedAt={audit.generatedAt} />

          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <CategoryChip label="Tier-1 bundle" count={audit.byCategory.tier1Bundle} tone="good" />
            <CategoryChip label="Tier-2 (tenants)" count={audit.byCategory.tier2TenantSweep} tone="good" />
            <CategoryChip label="Denied (auto-managed)" count={audit.byCategory.denied} tone="neutral" />
            <CategoryChip label="Allowlisted" count={audit.byCategory.allowlisted} tone="info" />
            <CategoryChip label="UNCOVERED" count={audit.byCategory.uncovered} tone={audit.byCategory.uncovered === 0 ? 'good' : 'bad'} />
          </div>

          {audit.uncoveredSecrets.length > 0 && (
            <div className="rounded-lg border border-red-300 dark:border-red-700 bg-white dark:bg-gray-800 overflow-hidden">
              <div className="px-4 py-3 border-b border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-sm font-medium text-red-900 dark:text-red-200">
                Uncovered Secrets ({audit.uncoveredSecrets.length})
              </div>
              <table className="min-w-full text-sm" data-testid="uncovered-table">
                <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400 text-xs uppercase">
                  <tr>
                    <th className="px-4 py-2 text-left">Namespace</th>
                    <th className="px-4 py-2 text-left">Name</th>
                    <th className="px-4 py-2 text-left">Type</th>
                    <th className="px-4 py-2 text-left">Age</th>
                    <th className="px-4 py-2 text-left">Owner</th>
                    <th className="px-4 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {audit.uncoveredSecrets.map((s) => (
                    <tr key={`${s.namespace}/${s.name}`}>
                      <td className="px-4 py-2 font-mono text-xs text-gray-700 dark:text-gray-200">{s.namespace}</td>
                      <td className="px-4 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">{s.name}</td>
                      <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200">{s.type}</td>
                      <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200">{formatAge(s.ageSeconds)}</td>
                      <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-200">{s.ownerKind ? `${s.ownerKind}/${s.ownerName ?? '?'}` : '—'}</td>
                      <td className="px-4 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => setModal(s)}
                          className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline dark:text-brand-400"
                          data-testid={`allowlist-add-${s.namespace}-${s.name}`}
                        >
                          <Plus size={12} />
                          Allowlist…
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <details className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
              Allowlisted entries ({allowlistQ.data?.entries.length ?? 0})
            </summary>
            <div className="px-4 pb-4">
              {(allowlistQ.data?.entries.length ?? 0) === 0 ? (
                <p className="text-sm text-gray-500 py-2">No allowlist entries.</p>
              ) : (
                <table className="min-w-full text-sm" data-testid="allowlist-table">
                  <thead className="bg-gray-50 dark:bg-gray-900/50 text-gray-600 dark:text-gray-400 text-xs uppercase">
                    <tr>
                      <th className="px-3 py-2 text-left">Secret</th>
                      <th className="px-3 py-2 text-left">Reason</th>
                      <th className="px-3 py-2 text-left">Added by</th>
                      <th className="px-3 py-2 text-left">Added at</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {(allowlistQ.data?.entries ?? []).map((e) => (
                      <tr key={`${e.namespace}/${e.name}`}>
                        <td className="px-3 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">{e.namespace}/{e.name}</td>
                        <td className="px-3 py-2 text-xs text-gray-700 dark:text-gray-200">{e.reason}</td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-700 dark:text-gray-200">{e.addedBy}</td>
                        <td className="px-3 py-2 text-xs text-gray-700 dark:text-gray-200">{new Date(e.addedAt).toISOString().slice(0, 19).replace('T', ' ')}</td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => void removeEntry.mutateAsync({ namespace: e.namespace, name: e.name })}
                            className="text-xs text-red-600 hover:underline dark:text-red-400"
                            data-testid={`allowlist-remove-${e.namespace}-${e.name}`}
                          >
                            <Trash2 size={12} className="inline" /> Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </details>
        </>
      )}

      {modal && <AllowlistModal secret={modal} onClose={() => setModal(null)} />}
    </section>
  );
}

function HealthBanner({ uncovered, total, generatedAt }: { uncovered: number; total: number; generatedAt: string }) {
  if (uncovered === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 p-3 text-sm text-emerald-900 dark:text-emerald-200" data-testid="audit-healthy">
        <CheckCircle2 size={16} />
        <strong>All {total} Secrets are covered.</strong>
        <span className="ml-auto text-xs">audited {new Date(generatedAt).toISOString().slice(0, 19).replace('T', ' ')}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-900 dark:text-red-200" data-testid="audit-unhealthy">
      <AlertTriangle size={16} />
      <strong>{uncovered} Secret{uncovered === 1 ? '' : 's'} uncovered</strong>
      <span>— silent DR-readiness risk. Resolve each row below.</span>
      <span className="ml-auto text-xs">audited {new Date(generatedAt).toISOString().slice(0, 19).replace('T', ' ')}</span>
    </div>
  );
}

function CategoryChip({ label, count, tone }: { label: string; count: number; tone: 'good' | 'bad' | 'info' | 'neutral' }) {
  const cls =
    tone === 'good'
      ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-900 dark:text-emerald-200'
      : tone === 'bad'
        ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 text-red-900 dark:text-red-200'
        : tone === 'info'
          ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 text-blue-900 dark:text-blue-200'
          : 'border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-200';
  return (
    <div className={`rounded-md border ${cls} p-3`}>
      <div className="text-xs uppercase">{label}</div>
      <div className="text-2xl font-semibold">{count}</div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2" aria-busy="true">
      <div className="h-12 rounded-md bg-gray-100 dark:bg-gray-800 animate-pulse" />
      <div className="h-32 rounded-md bg-gray-100 dark:bg-gray-800 animate-pulse" />
    </div>
  );
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function AllowlistModal({ secret, onClose }: { secret: AuditedSecret; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const add = useAddAllowlistEntry();
  const valid = reason.trim().length >= 10;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-lg bg-white dark:bg-gray-900 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-5 py-3">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Allowlist {secret.namespace}/{secret.name}</h3>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-700">✕</button>
        </div>
        <div className="px-5 py-4 space-y-3 text-sm">
          <p className="text-gray-700 dark:text-gray-200">
            Allowlist this Secret only when it's genuinely safe to lose at restore-time. Prefer extending
            <code className="mx-1">BUNDLE_SECRET_LIST</code>or the daily CronJob's sweep when the Secret matters
            for DR.
          </p>
          <label className="block">
            <span className="text-xs uppercase text-gray-600 dark:text-gray-400">Reason (≥10 chars)</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="e.g. session cookie — better to rotate on restore than carry old value"
              className="mt-1 w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
              data-testid="allowlist-reason-input"
            />
          </label>
          {add.error && (
            <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 p-2 text-xs text-red-900 dark:text-red-200">
              {add.error instanceof Error ? add.error.message : String(add.error)}
            </div>
          )}
        </div>
        <div className="border-t border-gray-200 dark:border-gray-700 px-5 py-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800">Cancel</button>
          <button
            type="button"
            disabled={!valid || add.isPending}
            onClick={async () => {
              await add.mutateAsync({ namespace: secret.namespace, name: secret.name, reason: reason.trim() });
              onClose();
            }}
            className="rounded-md px-3 py-1.5 text-sm font-medium bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50"
            data-testid="allowlist-submit"
          >
            Add to allowlist
          </button>
        </div>
      </div>
    </div>
  );
}
