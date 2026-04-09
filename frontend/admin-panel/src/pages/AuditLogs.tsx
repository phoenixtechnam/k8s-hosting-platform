import { useState, useMemo } from 'react';
import { ScrollText, Search, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import { useAuditLogs, type AuditLogEntry, type ListAuditLogsParams } from '@/hooks/use-audit-logs';

/**
 * Phase 7: Audit log viewer page.
 *
 * Reads from the backend `GET /api/v1/admin/audit-logs` endpoint
 * which already supports cursor pagination and filtering by
 * client_id, action_type, resource_type, actor_id, http_method,
 * search (path LIKE), from, to. Restricted to super_admin and
 * admin roles server-side.
 *
 * The page offers:
 *   - Inline filter bar with action / resource / method / search /
 *     date range inputs plus Clear filters
 *   - Cursor-based "Load more" button (no prev, matches the API)
 *   - Per-row expand drawer showing the full changes JSON and
 *     all request metadata
 *   - Color-coded action-type and method badges
 */

const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

const ACTION_COLORS: Record<string, string> = {
  create: 'bg-green-50 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  update: 'bg-blue-50 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  delete: 'bg-red-50 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-gray-50 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  POST: 'bg-green-50 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  PATCH: 'bg-amber-50 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  PUT: 'bg-amber-50 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  DELETE: 'bg-red-50 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

export default function AuditLogs() {
  // Filter state — unapplied inputs are stored here; applied filters
  // trigger the query. Two-state so the user can edit multiple fields
  // before hitting Apply.
  const [filters, setFilters] = useState<ListAuditLogsParams>({ limit: 50 });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  // Accumulated rows across cursor pages
  const [accumulated, setAccumulated] = useState<readonly AuditLogEntry[]>([]);

  const query = useAuditLogs({ ...filters, cursor });
  const data = query.data;

  // When the query returns, merge into accumulated. Using useMemo
  // so we only recompute when data changes.
  const visibleRows = useMemo(() => {
    if (!data) return accumulated;
    if (!cursor) {
      // First page — reset accumulated
      return data.data;
    }
    // Subsequent page — concatenate
    return [...accumulated, ...data.data];
  }, [data, cursor, accumulated]);

  const applyFilters = (next: Partial<ListAuditLogsParams>) => {
    setFilters((prev) => ({ ...prev, ...next }));
    setCursor(undefined);
    setAccumulated([]);
    setExpandedId(null);
  };

  const loadMore = () => {
    if (data?.pagination?.cursor) {
      setAccumulated(visibleRows);
      setCursor(data.pagination.cursor);
    }
  };

  const clearFilters = () => {
    setFilters({ limit: 50 });
    setCursor(undefined);
    setAccumulated([]);
    setExpandedId(null);
  };

  const hasActiveFilters =
    !!filters.action_type
    || !!filters.resource_type
    || !!filters.http_method
    || !!filters.search
    || !!filters.from
    || !!filters.to
    || !!filters.client_id
    || !!filters.actor_id;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <ScrollText size={28} className="text-brand-500" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="audit-logs-heading">
            Audit Logs
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            All mutating requests across the platform. Read-only GET
            requests are not recorded. Retained indefinitely.
          </p>
        </div>
      </div>

      <div
        className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 shadow-sm"
        data-testid="audit-logs-filters"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="filter-action" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Action</label>
            <select
              id="filter-action"
              className={INPUT_CLASS + ' mt-1'}
              value={filters.action_type ?? ''}
              onChange={(e) => applyFilters({ action_type: e.target.value || undefined })}
              data-testid="filter-action-type"
            >
              <option value="">All actions</option>
              <option value="create">Create</option>
              <option value="update">Update</option>
              <option value="delete">Delete</option>
            </select>
          </div>
          <div>
            <label htmlFor="filter-resource" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Resource type</label>
            <input
              id="filter-resource"
              type="text"
              placeholder="e.g. client, user, domain"
              className={INPUT_CLASS + ' mt-1'}
              value={filters.resource_type ?? ''}
              onChange={(e) => applyFilters({ resource_type: e.target.value || undefined })}
              data-testid="filter-resource-type"
            />
          </div>
          <div>
            <label htmlFor="filter-method" className="block text-xs font-medium text-gray-700 dark:text-gray-300">HTTP method</label>
            <select
              id="filter-method"
              className={INPUT_CLASS + ' mt-1'}
              value={filters.http_method ?? ''}
              onChange={(e) => applyFilters({ http_method: e.target.value || undefined })}
              data-testid="filter-http-method"
            >
              <option value="">All methods</option>
              <option value="POST">POST</option>
              <option value="PATCH">PATCH</option>
              <option value="PUT">PUT</option>
              <option value="DELETE">DELETE</option>
            </select>
          </div>
          <div>
            <label htmlFor="filter-search" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Path contains</label>
            <div className="relative mt-1">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                id="filter-search"
                type="text"
                placeholder="/clients/..."
                className={INPUT_CLASS + ' pl-8'}
                value={filters.search ?? ''}
                onChange={(e) => applyFilters({ search: e.target.value || undefined })}
                data-testid="filter-search"
              />
            </div>
          </div>
          <div>
            <label htmlFor="filter-from" className="block text-xs font-medium text-gray-700 dark:text-gray-300">From</label>
            <input
              id="filter-from"
              type="datetime-local"
              className={INPUT_CLASS + ' mt-1'}
              value={filters.from ? toLocalDatetimeInput(filters.from) : ''}
              onChange={(e) => applyFilters({ from: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
              data-testid="filter-from"
            />
          </div>
          <div>
            <label htmlFor="filter-to" className="block text-xs font-medium text-gray-700 dark:text-gray-300">To</label>
            <input
              id="filter-to"
              type="datetime-local"
              className={INPUT_CLASS + ' mt-1'}
              value={filters.to ? toLocalDatetimeInput(filters.to) : ''}
              onChange={(e) => applyFilters({ to: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
              data-testid="filter-to"
            />
          </div>
          <div>
            <label htmlFor="filter-client" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Client ID</label>
            <input
              id="filter-client"
              type="text"
              placeholder="UUID"
              className={INPUT_CLASS + ' mt-1 font-mono'}
              value={filters.client_id ?? ''}
              onChange={(e) => applyFilters({ client_id: e.target.value || undefined })}
              data-testid="filter-client-id"
            />
          </div>
          <div>
            <label htmlFor="filter-actor" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Actor ID</label>
            <input
              id="filter-actor"
              type="text"
              placeholder="UUID"
              className={INPUT_CLASS + ' mt-1 font-mono'}
              value={filters.actor_id ?? ''}
              onChange={(e) => applyFilters({ actor_id: e.target.value || undefined })}
              data-testid="filter-actor-id"
            />
          </div>
        </div>
        {hasActiveFilters && (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              data-testid="clear-filters"
            >
              <X size={12} /> Clear filters
            </button>
          </div>
        )}
      </div>

      {query.isLoading && visibleRows.length === 0 && (
        <div className="flex items-center justify-center py-16" data-testid="audit-logs-loading">
          <Loader2 size={24} className="animate-spin text-brand-500" />
        </div>
      )}

      {query.isError && (
        <div className="rounded-xl border border-red-200 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-5 py-4 text-sm text-red-700 dark:text-red-300" data-testid="audit-logs-error">
          Failed to load audit logs.
          {query.error instanceof Error ? ` ${query.error.message}` : ''}
        </div>
      )}

      {!query.isLoading && !query.isError && visibleRows.length === 0 && (
        <div
          className="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 px-5 py-16 text-center"
          data-testid="audit-logs-empty"
        >
          <ScrollText size={40} className="mx-auto text-gray-300 dark:text-gray-600" />
          <p className="mt-3 text-sm font-medium text-gray-900 dark:text-gray-100">No audit log entries</p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {hasActiveFilters ? 'Try clearing or loosening the filters above.' : 'The audit log is empty.'}
          </p>
        </div>
      )}

      {visibleRows.length > 0 && (
        <div
          className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm"
          data-testid="audit-logs-table"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/50 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  <th className="w-8 px-2" />
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Resource</th>
                  <th className="hidden px-4 py-3 md:table-cell">Method</th>
                  <th className="hidden px-4 py-3 lg:table-cell">Path</th>
                  <th className="hidden px-4 py-3 xl:table-cell">Actor</th>
                  <th className="hidden px-4 py-3 xl:table-cell">IP</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const isExpanded = expandedId === row.id;
                  return (
                    <AuditLogRow
                      key={row.id}
                      row={row}
                      expanded={isExpanded}
                      onToggle={() => setExpandedId(isExpanded ? null : row.id)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-gray-100 dark:border-gray-700 px-5 py-3">
            <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="audit-logs-count">
              {visibleRows.length} shown
              {data?.pagination?.total_count !== undefined
                && ` of ${data.pagination.total_count}`}
            </p>
            {data?.pagination?.has_more && (
              <button
                type="button"
                onClick={loadMore}
                disabled={query.isFetching}
                className="inline-flex items-center gap-1.5 rounded-md bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
                data-testid="audit-logs-load-more"
              >
                {query.isFetching && <Loader2 size={12} className="animate-spin" />}
                Load more
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AuditLogRow({
  row,
  expanded,
  onToggle,
}: {
  readonly row: AuditLogEntry;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const actionColor = ACTION_COLORS[row.actionType] ?? 'bg-gray-50 text-gray-700';
  const methodColor = row.httpMethod
    ? METHOD_COLORS[row.httpMethod] ?? 'bg-gray-50 text-gray-700'
    : 'bg-gray-50 text-gray-700';

  return (
    <>
      <tr
        className="cursor-pointer border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50/50 dark:hover:bg-gray-900/30"
        onClick={onToggle}
        data-testid={`audit-log-row-${row.id}`}
      >
        <td className="px-2 py-3 text-gray-400">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </td>
        <td className="px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-400">
          {new Date(row.createdAt).toLocaleString()}
        </td>
        <td className="px-4 py-3">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${actionColor}`}>
            {row.actionType}
          </span>
        </td>
        <td className="px-4 py-3 text-gray-800 dark:text-gray-200">
          <span className="font-medium">{row.resourceType}</span>
          {row.resourceId && (
            <span className="ml-1 font-mono text-xs text-gray-400 dark:text-gray-500">
              {row.resourceId.slice(0, 8)}
            </span>
          )}
        </td>
        <td className="hidden px-4 py-3 md:table-cell">
          <span className={`rounded-full px-2 py-0.5 text-xs font-mono font-medium ${methodColor}`}>
            {row.httpMethod ?? '—'}
          </span>
          {row.httpStatus !== null && (
            <span className={`ml-2 text-xs font-mono ${row.httpStatus >= 400 ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'}`}>
              {row.httpStatus}
            </span>
          )}
        </td>
        <td className="hidden max-w-xs truncate px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400 lg:table-cell">
          {row.httpPath}
        </td>
        <td className="hidden px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400 xl:table-cell">
          {row.actorId === 'anonymous' ? 'anonymous' : row.actorId.slice(0, 8)}
        </td>
        <td className="hidden px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400 xl:table-cell">
          {row.ipAddress ?? '—'}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50/30 dark:bg-gray-900/30">
          <td colSpan={8} className="px-6 py-4" data-testid={`audit-log-details-${row.id}`}>
            <dl className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
              <Field label="ID" value={row.id} mono />
              <Field label="Actor type" value={row.actorType} />
              <Field label="Actor ID" value={row.actorId} mono />
              <Field label="Client ID" value={row.clientId ?? '—'} mono />
              <Field label="Resource type" value={row.resourceType} />
              <Field label="Resource ID" value={row.resourceId ?? '—'} mono />
              <Field label="HTTP method" value={row.httpMethod ?? '—'} mono />
              <Field label="HTTP path" value={row.httpPath ?? '—'} mono />
              <Field label="HTTP status" value={String(row.httpStatus ?? '—')} mono />
              <Field label="IP address" value={row.ipAddress ?? '—'} mono />
              <Field label="Timestamp" value={new Date(row.createdAt).toISOString()} mono />
            </dl>
            {row.changes && Object.keys(row.changes).length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Changes</p>
                <pre className="mt-1 max-h-60 overflow-auto rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 font-mono text-[11px] text-gray-700 dark:text-gray-300">
{JSON.stringify(row.changes, null, 2)}
                </pre>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function Field({ label, value, mono = false }: { readonly label: string; readonly value: string; readonly mono?: boolean }) {
  return (
    <div>
      <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className={`mt-0.5 text-gray-900 dark:text-gray-100 ${mono ? 'font-mono break-all' : ''}`}>{value}</dd>
    </div>
  );
}

/**
 * Convert an ISO timestamp to the format expected by a
 * `<input type="datetime-local">` control (YYYY-MM-DDTHH:mm).
 */
function toLocalDatetimeInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
