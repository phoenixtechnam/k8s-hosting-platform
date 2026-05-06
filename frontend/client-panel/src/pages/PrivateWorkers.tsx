import { useMemo, useState, type FormEvent } from 'react';
import {
  AlertCircle,
  BookOpen,
  Cable,
  Loader2,
  Plus,
  Search,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { useClientContext } from '@/hooks/use-client-context';
import { useCanManage } from '@/hooks/use-can-manage';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';
import ReadOnlyNotice from '@/components/ReadOnlyNotice';
import {
  usePrivateWorkers,
  useCreatePrivateWorker,
} from '@/hooks/use-private-workers';
import PrivateWorkerTokenModal from '@/components/private-workers/PrivateWorkerTokenModal';
import PrivateWorkerDetailDrawer from '@/components/private-workers/PrivateWorkerDetailDrawer';
import type {
  PrivateWorkerResponse,
  PrivateWorkerSecretResponse,
  PrivateWorkerStatus,
  CreatePrivateWorkerInput,
} from '@k8s-hosting/api-contracts';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

const STATUS_BADGE: Record<PrivateWorkerStatus, string> = {
  active: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
  pending: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
  revoked: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
  suspended: 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
};

const STATUS_TOOLTIP: Record<PrivateWorkerStatus, string> = {
  pending: 'Created but no agent has connected yet.',
  active: 'Agent connected, ready to forward traffic.',
  revoked: 'Token invalidated; the agent can no longer connect. Rotate to mint a new token.',
  suspended: 'Worker is paused by the platform (account hold or maintenance).',
};

function StatusBadge({ status }: { readonly status: PrivateWorkerStatus }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize',
        STATUS_BADGE[status],
      )}
      title={STATUS_TOOLTIP[status]}
    >
      {status}
    </span>
  );
}

const STATUS_PILL_DOT: Record<PrivateWorkerStatus, string> = {
  active: 'bg-green-500',
  pending: 'bg-gray-400 dark:bg-gray-500',
  revoked: 'bg-red-500',
  suspended: 'bg-amber-500',
};

const STATUS_PILL_TEXT: Record<PrivateWorkerStatus, string> = {
  active: 'text-green-700 dark:text-green-400',
  pending: 'text-gray-600 dark:text-gray-400',
  revoked: 'text-red-700 dark:text-red-400',
  suspended: 'text-amber-700 dark:text-amber-400',
};

const STATUS_PILL_LABEL: Record<PrivateWorkerStatus, string> = {
  active: 'Connected',
  pending: 'Awaiting agent',
  revoked: 'Revoked',
  suspended: 'Suspended',
};

function StatusPill({ status }: { readonly status: PrivateWorkerStatus }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 text-xs font-medium',
        STATUS_PILL_TEXT[status],
      )}
      title={STATUS_TOOLTIP[status]}
    >
      <span
        className={clsx(
          'inline-block h-2 w-2 rounded-full',
          STATUS_PILL_DOT[status],
          status === 'active' && 'animate-pulse',
        )}
      />
      {STATUS_PILL_LABEL[status]}
    </span>
  );
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'Never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'Never';
  const delta = Date.now() - then;
  if (delta < 0) return 'just now';
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

interface CreateModalProps {
  readonly clientId: string;
  readonly onClose: () => void;
  readonly onCreated: (secret: PrivateWorkerSecretResponse) => void;
}

function CreateModal({ clientId, onClose, onCreated }: CreateModalProps) {
  const create = useCreatePrivateWorker(clientId);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const input: CreatePrivateWorkerInput = {
      name: name.trim(),
      description: description.trim() ? description.trim() : undefined,
    };
    try {
      const result = await create.mutateAsync(input);
      onCreated(result.data);
    } catch {
      // surfaced via create.error
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pw-create-title"
      data-testid="private-worker-create-modal"
    >
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-md w-full p-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex items-center justify-between">
            <h3
              id="pw-create-title"
              className="text-lg font-semibold text-gray-900 dark:text-gray-100"
            >
              Create private worker
            </h3>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>

          <div>
            <label
              htmlFor="pw-create-name"
              className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1"
            >
              Name <span className="text-red-500">*</span>
            </label>
            <input
              id="pw-create-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. home-gpu, nas-bridge"
              className={INPUT_CLASS}
              required
              minLength={1}
              maxLength={120}
              data-testid="pw-create-name"
            />
          </div>

          <div>
            <label
              htmlFor="pw-create-description"
              className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1"
            >
              Description
            </label>
            <input
              id="pw-create-description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
              placeholder="Optional notes for your team"
              className={INPUT_CLASS}
              data-testid="pw-create-description"
            />
          </div>

          {create.error && (
            <p className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1">
              <AlertCircle size={14} /> {(create.error as Error).message}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={create.isPending || !name.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="pw-create-submit"
            >
              {create.isPending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Plus size={14} />
              )}
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const SEARCH_THRESHOLD = 5;

interface EmptyStateProps {
  readonly canManage: boolean;
  readonly onCreate: () => void;
}

function EmptyState({ canManage, onCreate }: EmptyStateProps) {
  return (
    <div
      className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 p-10 text-center"
      data-testid="private-workers-empty-state"
    >
      <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-brand-50 dark:bg-brand-900/30">
        <Cable size={32} className="text-brand-500 dark:text-brand-400" />
      </div>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        No private workers yet
      </h2>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 max-w-md mx-auto">
        Run a service outside the cluster and route traffic through your
        platform domain — no port forwarding, no public IP needed.
      </p>
      <ul className="mt-5 mx-auto max-w-md space-y-2 text-left text-sm text-gray-600 dark:text-gray-300">
        <li className="flex items-start gap-2">
          <span
            aria-hidden="true"
            className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500"
          />
          <span>Expose a service from your home GPU/NAS</span>
        </li>
        <li className="flex items-start gap-2">
          <span
            aria-hidden="true"
            className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500"
          />
          <span>Run a database on-prem and front it with platform TLS/DNS</span>
        </li>
        <li className="flex items-start gap-2">
          <span
            aria-hidden="true"
            className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500"
          />
          <span>
            Migrate gradually from on-prem to cloud — no public IP needed
          </span>
        </li>
      </ul>
      <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
        {canManage && (
          <button
            type="button"
            onClick={onCreate}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
            data-testid="add-private-worker-button-empty"
          >
            <Plus size={14} /> Create your first private worker
          </button>
        )}
        <a
          href="/docs/private-workers"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          data-testid="pw-read-the-docs"
        >
          <BookOpen size={14} /> Read the docs
        </a>
      </div>
    </div>
  );
}

export default function PrivateWorkers() {
  const { clientId } = useClientContext();
  const canManage = useCanManage();
  const { data, isLoading, error } = usePrivateWorkers(clientId ?? undefined);

  const [createOpen, setCreateOpen] = useState(false);
  const [secret, setSecret] = useState<PrivateWorkerSecretResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const workers: readonly PrivateWorkerResponse[] = data?.data?.items ?? [];

  // Filter before sortable hook so user-controlled sort still works.
  const filtered = useMemo<readonly PrivateWorkerResponse[]>(() => {
    const term = search.trim().toLowerCase();
    if (!term) return workers;
    return workers.filter((w) => {
      const haystack = `${w.name} ${w.slug} ${w.description ?? ''}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [workers, search]);

  const {
    sortedData: rawSorted,
    sortKey,
    sortDirection,
    onSort,
  } = useSortable<PrivateWorkerResponse>(filtered, 'lastSeenAt', 'desc');

  // Override useSortable for `lastSeenAt` so null timestamps land at the
  // bottom regardless of direction (most-recently-active first feels
  // wrong if "never connected" workers are jammed at the top of a desc
  // sort).
  const sortedData = useMemo<readonly PrivateWorkerResponse[]>(() => {
    if (sortKey !== 'lastSeenAt') return rawSorted;
    const copy = [...filtered];
    copy.sort((a, b) => {
      const at = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : null;
      const bt = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : null;
      if (at === null && bt === null) return 0;
      if (at === null) return 1;
      if (bt === null) return -1;
      return sortDirection === 'asc' ? at - bt : bt - at;
    });
    return copy;
  }, [rawSorted, filtered, sortKey, sortDirection]);

  const showSearch = workers.length > SEARCH_THRESHOLD;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Cable size={28} className="text-gray-700 dark:text-gray-300" />
          <h1
            className="text-2xl font-bold text-gray-900 dark:text-gray-100"
            data-testid="private-workers-heading"
          >
            Private Workers
          </h1>
        </div>
        {canManage && workers.length > 0 && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
            data-testid="add-private-worker-button"
          >
            <Plus size={14} /> Create
          </button>
        )}
      </div>

      <p className="text-sm text-gray-500 dark:text-gray-400 max-w-3xl">
        Run a service on a machine outside the cluster — at home, on a NAS,
        on a GPU box — and route traffic to it through your platform-issued
        domains. Every ingress feature you already use (TLS, OIDC, mTLS,
        rate limiting) applies unchanged.
      </p>

      {!canManage && <ReadOnlyNotice />}

      {error && !isLoading && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>{(error as Error).message}</span>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="animate-spin text-brand-500" size={32} />
        </div>
      ) : workers.length === 0 ? (
        <EmptyState canManage={canManage} onCreate={() => setCreateOpen(true)} />
      ) : (
        <>
          {showSearch && (
            <div className="relative max-w-sm">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500"
                aria-hidden="true"
              />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search workers by name, slug, or description"
                className={clsx(INPUT_CLASS, 'pl-9')}
                data-testid="pw-search"
                aria-label="Search private workers"
              />
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700 text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <SortableHeader
                    label="Name"
                    sortKey="name"
                    currentKey={sortKey}
                    direction={sortDirection}
                    onSort={onSort}
                    className="text-left"
                  />
                  <SortableHeader
                    label="Slug"
                    sortKey="slug"
                    currentKey={sortKey}
                    direction={sortDirection}
                    onSort={onSort}
                    className="text-left"
                  />
                  <th className="px-5 py-2.5 text-left text-xs font-semibold text-gray-600 dark:text-gray-400">
                    Connection
                  </th>
                  <SortableHeader
                    label="Status"
                    sortKey="status"
                    currentKey={sortKey}
                    direction={sortDirection}
                    onSort={onSort}
                    className="text-left"
                  />
                  <SortableHeader
                    label="Last seen"
                    sortKey="lastSeenAt"
                    currentKey={sortKey}
                    direction={sortDirection}
                    onSort={onSort}
                    className="text-left"
                  />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-900">
                {sortedData.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400"
                      data-testid="pw-search-empty"
                    >
                      No private workers match
                      {search.trim() ? ` "${search.trim()}"` : ' the filter'}.
                    </td>
                  </tr>
                ) : (
                  sortedData.map((w) => (
                    <tr
                      key={w.id}
                      onClick={() => setSelectedId(w.id)}
                      className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer"
                      data-testid={`pw-row-${w.id}`}
                    >
                      <td className="px-5 py-3 text-gray-900 dark:text-gray-100">
                        {w.name}
                      </td>
                      <td className="px-5 py-3 font-mono text-xs text-gray-600 dark:text-gray-400 break-all">
                        {w.slug}
                      </td>
                      <td className="px-5 py-3">
                        <StatusPill status={w.status} />
                      </td>
                      <td className="px-5 py-3">
                        <StatusBadge status={w.status} />
                      </td>
                      <td
                        className="px-5 py-3 text-gray-500 dark:text-gray-400"
                        title={w.lastSeenAt ?? 'never'}
                      >
                        {formatRelative(w.lastSeenAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {createOpen && clientId && (
        <CreateModal
          clientId={clientId}
          onClose={() => setCreateOpen(false)}
          onCreated={(s) => {
            setCreateOpen(false);
            setSecret(s);
          }}
        />
      )}

      {secret && (
        <PrivateWorkerTokenModal
          secret={secret}
          onClose={() => setSecret(null)}
        />
      )}

      {selectedId && clientId && (
        <PrivateWorkerDetailDrawer
          clientId={clientId}
          workerId={selectedId}
          canManage={canManage}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
