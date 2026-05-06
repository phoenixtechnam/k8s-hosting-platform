/**
 * Recent-restore-carts list page.
 *
 * /restores — operator surface for tracking + resuming carts.
 * Carts in 'failed' status get a "Resume" link that drops the
 * operator into /restore?cartId=… so they can re-trigger /execute
 * on the failed item without re-creating the cart.
 *
 * Default sort: newest first. Status pill colour-codes draft (gray),
 * executing (blue), done (green), failed (red), paused (amber).
 * Auto-refreshes every 30 s.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Play, AlertCircle, CheckCircle2, Pause, FileText } from 'lucide-react';
import { useRestoreCarts } from '@/hooks/use-restore-carts';
import type { RestoreJobSummary } from '@k8s-hosting/api-contracts';

const STATUS_FILTERS: ReadonlyArray<{ key: string; label: string }> = [
  { key: '', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'executing', label: 'Executing' },
  { key: 'paused', label: 'Paused' },
  { key: 'failed', label: 'Failed' },
  { key: 'done', label: 'Done' },
];

export default function RestoreCartsList() {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [clientFilter, setClientFilter] = useState<string>('');
  const q = useRestoreCarts({ status: statusFilter || undefined, clientId: clientFilter || undefined });
  // API envelope is {data: {data: [...]}} — see CartListResponse in
  // hooks/use-restore-carts.ts.
  const carts = q.data?.data?.data ?? [];

  return (
    <div className="p-4 md:p-6">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Restore carts</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Recent restore activity. Failed carts can be resumed by clicking through to the cart page and pressing Execute again — already-completed items are skipped.
        </p>
      </header>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-md border border-gray-200 bg-white p-1 dark:border-gray-700 dark:bg-gray-800">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setStatusFilter(s.key)}
              className={`rounded px-3 py-1 text-sm font-medium transition ${
                statusFilter === s.key
                  ? 'bg-brand-600 text-white'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value.trim())}
          placeholder="Filter by client id…"
          className="rounded-md border border-gray-300 bg-white px-3 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        />
        {q.isFetching && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
      </div>

      <div className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
        {q.isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : q.isError ? (
          <div className="flex items-center gap-2 p-4 text-sm text-red-700 dark:text-red-300">
            <AlertCircle className="h-4 w-4" />
            <span>{(q.error as Error)?.message ?? 'Failed to load'}</span>
          </div>
        ) : carts.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <FileText className="mx-auto h-10 w-10 text-gray-300 dark:text-gray-600" />
            <p className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">No carts yet</p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Open a bundle's "Restore" action to create one.
            </p>
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50/50 dark:border-gray-700 dark:bg-gray-900/50">
                <th className="px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Cart</th>
                <th className="px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Client</th>
                <th className="px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Status</th>
                <th className="hidden px-4 py-2 font-medium text-gray-500 dark:text-gray-400 lg:table-cell">Description</th>
                <th className="hidden px-4 py-2 font-medium text-gray-500 dark:text-gray-400 sm:table-cell">Started</th>
                <th className="hidden px-4 py-2 font-medium text-gray-500 dark:text-gray-400 sm:table-cell">Finished</th>
                <th className="px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Resume</th>
              </tr>
            </thead>
            <tbody>
              {carts.map((c) => (
                <tr key={c.id} className="border-b border-gray-100 last:border-0 dark:border-gray-700">
                  <td className="px-4 py-2 font-mono text-xs text-gray-900 dark:text-gray-100">{c.id.slice(0, 16)}…</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-600 dark:text-gray-400">{c.clientId.slice(0, 12)}</td>
                  <td className="px-4 py-2">
                    <CartStatusPill status={c.status} />
                  </td>
                  <td className="hidden px-4 py-2 text-gray-700 dark:text-gray-300 lg:table-cell">{c.description ?? '-'}</td>
                  <td className="hidden px-4 py-2 text-xs text-gray-500 dark:text-gray-400 sm:table-cell">
                    {c.startedAt ? new Date(c.startedAt).toLocaleString() : '-'}
                  </td>
                  <td className="hidden px-4 py-2 text-xs text-gray-500 dark:text-gray-400 sm:table-cell">
                    {c.finishedAt ? new Date(c.finishedAt).toLocaleString() : '-'}
                  </td>
                  <td className="px-4 py-2">
                    {(c.status === 'failed' || c.status === 'paused' || c.status === 'draft') ? (
                      <Link
                        to={`/restore?cartId=${encodeURIComponent(c.id)}&clientId=${encodeURIComponent(c.clientId)}`}
                        className="inline-flex items-center gap-1 rounded-md border border-amber-300 px-2 py-1 text-xs font-medium text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-950"
                      >
                        {c.status === 'failed' ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                        {c.status === 'failed' ? 'Resume' : 'Open'}
                      </Link>
                    ) : c.status === 'done' ? (
                      <span className="inline-flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500">
                        <CheckCircle2 className="h-3.5 w-3.5" /> done
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-blue-600">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> running
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function CartStatusPill({ status }: { status: RestoreJobSummary['status'] }) {
  const styles: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
    executing: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
    paused: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
    done: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${styles[status] ?? styles.draft}`}>
      {status}
    </span>
  );
}
