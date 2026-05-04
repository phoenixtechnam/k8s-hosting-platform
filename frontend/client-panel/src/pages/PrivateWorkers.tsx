import { useState, type FormEvent } from 'react';
import {
  AlertCircle,
  Cable,
  Loader2,
  Plus,
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

function StatusBadge({ status }: { readonly status: PrivateWorkerStatus }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize',
        STATUS_BADGE[status],
      )}
    >
      {status}
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
  const [exposedPort, setExposedPort] = useState<number | ''>(8080);
  const [description, setDescription] = useState('');

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (typeof exposedPort !== 'number') return;
    const input: CreatePrivateWorkerInput = {
      name: name.trim(),
      exposed_port: exposedPort,
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
              htmlFor="pw-create-port"
              className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1"
            >
              Exposed port <span className="text-red-500">*</span>
            </label>
            <input
              id="pw-create-port"
              type="number"
              value={exposedPort}
              onChange={(e) => {
                const v = e.target.value;
                setExposedPort(v === '' ? '' : Number(v));
              }}
              min={1}
              max={65535}
              placeholder="8080"
              className={INPUT_CLASS}
              required
              data-testid="pw-create-port"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              The TCP port your home service listens on; ingress routes target
              this.
            </p>
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
              disabled={create.isPending || !name.trim() || typeof exposedPort !== 'number'}
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

export default function PrivateWorkers() {
  const { clientId } = useClientContext();
  const canManage = useCanManage();
  const { data, isLoading, error } = usePrivateWorkers(clientId ?? undefined);

  const [createOpen, setCreateOpen] = useState(false);
  const [secret, setSecret] = useState<PrivateWorkerSecretResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const workers: readonly PrivateWorkerResponse[] = data?.data?.items ?? [];
  const { sortedData, sortKey, sortDirection, onSort } = useSortable<PrivateWorkerResponse>(
    workers,
    'name',
  );

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
        <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 p-10 text-center">
          <Cable
            size={40}
            className="mx-auto mb-3 text-gray-400 dark:text-gray-500"
          />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            No private workers yet
          </h2>
          <p
            className="mt-1 text-sm text-gray-500 dark:text-gray-400 max-w-md mx-auto"
            data-testid="private-workers-empty-state"
          >
            Run a service at home and route traffic through your platform
            domain. The agent runs as a single Docker container with one
            environment variable — no port-forwarding, no public IP needed.
          </p>
          {canManage && (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
              data-testid="add-private-worker-button-empty"
            >
              <Plus size={14} /> Create private worker
            </button>
          )}
        </div>
      ) : (
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
                <SortableHeader
                  label="Status"
                  sortKey="status"
                  currentKey={sortKey}
                  direction={sortDirection}
                  onSort={onSort}
                  className="text-left"
                />
                <SortableHeader
                  label="Port"
                  sortKey="exposedPort"
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
              {sortedData.map((w) => (
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
                    <StatusBadge status={w.status} />
                  </td>
                  <td className="px-5 py-3 font-mono text-gray-600 dark:text-gray-400">
                    {w.exposedPort}
                  </td>
                  <td
                    className="px-5 py-3 text-gray-500 dark:text-gray-400"
                    title={w.lastSeenAt ?? 'never'}
                  >
                    {formatRelative(w.lastSeenAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
