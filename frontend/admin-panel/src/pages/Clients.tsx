import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Loader2, Ban, PlayCircle, Trash2 } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import PaginationBar from '@/components/ui/PaginationBar';
import BulkActionBar, { SelectCheckbox } from '@/components/ui/BulkActionBar';
import BulkResultModal, { type BulkResult } from '@/components/BulkResultModal';
import CreateClientModal from '@/components/CreateClientModal';
import { useClients } from '@/hooks/use-clients';
import { useCursorPagination } from '@/hooks/use-cursor-pagination';
import { useSelection } from '@/hooks/use-selection';
import { useBulkSuspendClients, useBulkReactivateClients, useBulkDeleteClients } from '@/hooks/use-bulk-clients';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';
import { useAllClientMetrics, type ResourceMetrics } from '@/hooks/use-resource-metrics';

export default function Clients() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'suspend' | 'reactivate' | 'delete' | null>(null);

  const navigate = useNavigate();
  const pagination = useCursorPagination({ defaultLimit: 20 });

  useEffect(() => {
    pagination.resetPagination();
  }, [debouncedSearch]);

  const { data, isLoading, error } = useClients({
    search: debouncedSearch || undefined,
    limit: pagination.limit,
    cursor: pagination.cursor,
  });

  const clients = data?.data ?? [];
  const totalCount = data?.pagination?.total_count ?? 0;
  const hasMore = data?.pagination?.has_more ?? false;
  const nextCursor = data?.pagination?.cursor ?? null;
  const { sortedData: sortedClients, sortKey, sortDirection, onSort } = useSortable(clients, 'companyName');

  const clientIds = clients.map((c) => c.id);
  const { data: metricsData, isLoading: metricsLoading } = useAllClientMetrics(clientIds);
  const metricsMap: Record<string, ResourceMetrics | null> = metricsData?.data ?? {};

  const selection = useSelection<{ id: string }>(pagination.cursor);
  const bulkSuspend = useBulkSuspendClients();
  const bulkReactivate = useBulkReactivateClients();
  const bulkDelete = useBulkDeleteClients();

  const handleSearchChange = (value: string) => {
    setSearch(value);
    const key = '__searchTimeout';
    const w = window as unknown as Record<string, ReturnType<typeof setTimeout>>;
    clearTimeout(w[key]);
    w[key] = setTimeout(() => setDebouncedSearch(value), 300);
  };

  const [bulkResult, setBulkResult] = useState<{ action: 'suspend' | 'reactivate' | 'delete'; result: BulkResult } | null>(null);

  const handleBulkAction = async () => {
    if (!confirmAction) return;
    const ids = [...selection.selectedIds];
    try {
      let res;
      if (confirmAction === 'suspend') res = await bulkSuspend.mutateAsync(ids);
      else if (confirmAction === 'reactivate') res = await bulkReactivate.mutateAsync(ids);
      else res = await bulkDelete.mutateAsync(ids);
      selection.deselectAll();
      // Surface aggregate result so per-client failures are visible.
      setBulkResult({ action: confirmAction, result: res.data });
    } finally {
      setConfirmAction(null);
    }
  };

  const isBulkPending = bulkSuspend.isPending || bulkReactivate.isPending || bulkDelete.isPending;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Clients</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-600"
        >
          <Plus size={16} />
          Add Client
        </button>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            placeholder="Search by name..."
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-9 pr-4 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            data-testid="client-search"
          />
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        {isLoading && (
          <div className="flex items-center justify-center py-10">
            <Loader2 size={24} className="animate-spin text-gray-400" />
          </div>
        )}

        {error && (
          <div className="px-5 py-10 text-center text-sm text-red-500 dark:text-red-400">
            {error instanceof Error ? error.message : 'Failed to load clients'}
          </div>
        )}

        {!isLoading && !error && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="clients-table">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <th className="w-10 px-3 py-3">
                      <SelectCheckbox
                        checked={selection.isAllSelected(clients)}
                        indeterminate={selection.isIndeterminate(clients)}
                        onChange={() => selection.isAllSelected(clients) ? selection.deselectAll() : selection.selectAll(clients)}
                      />
                    </th>
                    <SortableHeader label="Client" sortKey="companyName" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <SortableHeader label="Status" sortKey="status" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                    <th className="hidden md:table-cell px-3 py-3 text-xs">CPU</th>
                    <th className="hidden md:table-cell px-3 py-3 text-xs">Memory</th>
                    <th className="hidden md:table-cell px-3 py-3 text-xs">Storage</th>
                    <SortableHeader label="Created" sortKey="createdAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="hidden lg:table-cell" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {sortedClients.map((client) => (
                    <tr
                      key={client.id}
                      className={`transition-colors cursor-pointer ${
                        selection.isSelected(client.id)
                          ? 'bg-brand-50 dark:bg-brand-900/20'
                          : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
                      }`}
                      onClick={() => navigate(`/clients/${client.id}`)}
                    >
                      <td className="w-10 px-3 py-3.5" onClick={(e) => e.stopPropagation()}>
                        <SelectCheckbox
                          checked={selection.isSelected(client.id)}
                          onChange={() => selection.toggle(client.id)}
                        />
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="font-medium text-gray-900 dark:text-gray-100">
                          {client.companyName}
                        </span>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {client.companyEmail}
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <StatusBadge status={client.status} />
                          {client.storageLifecycleState && client.storageLifecycleState !== 'idle' && (
                            <StatusBadge status={client.storageLifecycleState} />
                          )}
                        </div>
                      </td>
                      <MetricsCell
                        metrics={metricsMap[client.id]}
                        loading={metricsLoading}
                        resource="cpu"
                      />
                      <MetricsCell
                        metrics={metricsMap[client.id]}
                        loading={metricsLoading}
                        resource="memory"
                      />
                      <MetricsCell
                        metrics={metricsMap[client.id]}
                        loading={metricsLoading}
                        resource="storage"
                      />
                      <td className="hidden px-5 py-3.5 text-sm text-gray-500 dark:text-gray-400 lg:table-cell">
                        {client.createdAt ? new Date(client.createdAt).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  ))}
                  {clients.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                        {debouncedSearch
                          ? 'No clients found matching your search.'
                          : 'No clients yet. Click "Add Client" to create one.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <PaginationBar
              totalCount={totalCount}
              pageSize={pagination.limit}
              pageIndex={pagination.pageIndex}
              hasPrevPage={pagination.hasPrevPage}
              hasNextPage={hasMore}
              onNext={() => nextCursor && pagination.goNext(nextCursor)}
              onPrev={pagination.goPrev}
              onPageSizeChange={pagination.setPageSize}
            />
          </>
        )}
      </div>

      <BulkActionBar selectedCount={selection.selectedCount} onDeselectAll={selection.deselectAll}>
        <button
          onClick={() => setConfirmAction('suspend')}
          className="inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600 transition-colors"
        >
          <Ban size={14} />
          Suspend
        </button>
        <button
          onClick={() => setConfirmAction('reactivate')}
          className="inline-flex items-center gap-1.5 rounded-md bg-green-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-600 transition-colors"
        >
          <PlayCircle size={14} />
          Reactivate
        </button>
        <button
          onClick={() => setConfirmAction('delete')}
          className="inline-flex items-center gap-1.5 rounded-md bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 transition-colors"
        >
          <Trash2 size={14} />
          Delete
        </button>
      </BulkActionBar>

      {/* Confirmation dialog */}
      {confirmAction && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50" onClick={() => setConfirmAction(null)}>
          <div className="w-full max-w-sm rounded-xl bg-white dark:bg-gray-800 p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {confirmAction === 'delete' ? 'Delete' : confirmAction === 'suspend' ? 'Suspend' : 'Reactivate'} {selection.selectedCount} client{selection.selectedCount !== 1 ? 's' : ''}?
            </h3>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              {confirmAction === 'delete'
                ? 'This will permanently delete the selected clients and their data. This action cannot be undone.'
                : confirmAction === 'suspend'
                  ? 'Suspended clients will lose access to their hosting services.'
                  : 'Reactivated clients will regain access to their hosting services.'}
            </p>
            <div className="mt-4 flex justify-end gap-3">
              <button
                onClick={() => setConfirmAction(null)}
                className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkAction}
                disabled={isBulkPending}
                className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ${
                  confirmAction === 'delete'
                    ? 'bg-red-500 hover:bg-red-600'
                    : confirmAction === 'suspend'
                      ? 'bg-amber-500 hover:bg-amber-600'
                      : 'bg-green-500 hover:bg-green-600'
                }`}
              >
                {isBulkPending && <Loader2 size={14} className="animate-spin" />}
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      <CreateClientModal open={showCreate} onClose={() => setShowCreate(false)} />

      <BulkResultModal
        result={bulkResult?.result ?? null}
        action={bulkResult?.action ?? 'suspend'}
        onClose={() => setBulkResult(null)}
      />
    </div>
  );
}

// ─── Metrics Cell Helpers ────────────────────────────────────────────────────

function formatMetricsCpu(value: number): string {
  if (value >= 10) return value.toFixed(0);
  if (value >= 1) return value.toFixed(1);
  return value.toFixed(2);
}

function formatMetricsBytes(valueGi: number): string {
  if (valueGi <= 0) return '0Mi';
  if (valueGi < 1) {
    const mi = valueGi * 1024;
    if (mi >= 100) return `${mi.toFixed(0)}Mi`;
    if (mi >= 10) return `${mi.toFixed(1)}Mi`;
    return `${mi.toFixed(2)}Mi`;
  }
  if (valueGi >= 10) return `${valueGi.toFixed(0)}Gi`;
  return `${valueGi.toFixed(1)}Gi`;
}

function MetricsCell({
  metrics,
  loading,
  resource,
}: {
  readonly metrics: ResourceMetrics | null | undefined;
  readonly loading: boolean;
  readonly resource: 'cpu' | 'memory' | 'storage';
}) {
  if (loading) {
    return (
      <td className="hidden px-3 py-3.5 md:table-cell">
        <Loader2 size={12} className="animate-spin text-gray-400" />
      </td>
    );
  }

  if (!metrics) {
    return (
      <td className="hidden px-3 py-3.5 text-xs font-mono text-gray-400 dark:text-gray-500 md:table-cell">
        —
      </td>
    );
  }

  const resourceData = metrics[resource];
  const inUse = resourceData.inUse;
  const available = resourceData.available;
  const ratio = available > 0 ? inUse / available : 0;

  let dotColor: string;
  if (ratio >= 0.8) {
    dotColor = 'bg-red-500';
  } else if (ratio >= 0.5) {
    dotColor = 'bg-amber-500';
  } else {
    dotColor = 'bg-green-500';
  }

  const formatter = resource === 'cpu' ? formatMetricsCpu : formatMetricsBytes;
  const display = `${formatter(inUse)}/${formatter(available)}`;

  return (
    <td className="hidden px-3 py-3.5 md:table-cell">
      <span className="inline-flex items-center gap-1.5 text-xs font-mono text-gray-600 dark:text-gray-400">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`} />
        {display}
      </span>
    </td>
  );
}
