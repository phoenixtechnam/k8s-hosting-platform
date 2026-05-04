import { useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  Loader2,
  RefreshCw,
  ShieldOff,
  Trash2,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import type {
  PrivateWorkerResponse,
  PrivateWorkerSecretResponse,
  PrivateWorkerStatus,
} from '@k8s-hosting/api-contracts';
import {
  usePrivateWorker,
  usePrivateWorkerAudit,
  useRevokePrivateWorker,
  useRotatePrivateWorker,
  useDeletePrivateWorker,
} from '@/hooks/use-private-workers';
import PrivateWorkerTokenModal from './PrivateWorkerTokenModal';

interface PrivateWorkerDetailDrawerProps {
  readonly clientId: string;
  readonly workerId: string;
  readonly canManage: boolean;
  readonly onClose: () => void;
  readonly onDeleted?: () => void;
}

const STATUS_BADGE: Record<PrivateWorkerStatus, string> = {
  active: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
  pending: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
  revoked: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
  suspended: 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
};

function StatusBadge({ status }: { status: PrivateWorkerStatus }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        STATUS_BADGE[status],
      )}
      data-testid={`pw-status-${status}`}
    >
      {status}
    </span>
  );
}

function CopyInline({ value, testId }: { value: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="ml-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
      title="Copy"
      data-testid={testId}
    >
      {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
    </button>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
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

interface ConfirmModalProps {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly testId?: string;
}

function ConfirmModal({
  title,
  message,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
  testId,
}: ConfirmModalProps) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      data-testid={testId}
    >
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-300">{message}</p>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            data-testid={testId ? `${testId}-confirm` : undefined}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-3 gap-3 text-sm">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <div className="col-span-2 text-gray-900 dark:text-gray-100">{children}</div>
    </div>
  );
}

function AuditTable({
  clientId,
  workerId,
}: {
  readonly clientId: string;
  readonly workerId: string;
}) {
  const { data, isLoading } = usePrivateWorkerAudit(clientId, workerId, 50);
  const items = data?.data?.items ?? [];

  if (isLoading) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="animate-spin text-gray-400" size={20} />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <p className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
        No events recorded yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead>
          <tr className="border-b border-gray-200 dark:border-gray-700 text-left text-gray-500 dark:text-gray-400">
            <th className="px-2 py-1.5">Event</th>
            <th className="px-2 py-1.5">IP</th>
            <th className="px-2 py-1.5">When</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr
              key={e.id}
              className="border-b border-gray-100 dark:border-gray-700/50"
            >
              <td className="px-2 py-1.5">
                <span
                  className={clsx(
                    'inline-block rounded px-1.5 py-0.5 font-medium',
                    e.event === 'auth-fail'
                      ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                      : e.event === 'connect'
                        ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                        : e.event === 'revoke'
                          ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
                  )}
                >
                  {e.event}
                </span>
              </td>
              <td className="px-2 py-1.5 font-mono text-gray-600 dark:text-gray-400">
                {e.ip ?? '—'}
              </td>
              <td
                className="px-2 py-1.5 text-gray-500 dark:text-gray-400"
                title={new Date(e.occurredAt).toLocaleString()}
              >
                {formatRelative(e.occurredAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PrivateWorkerDetailDrawer({
  clientId,
  workerId,
  canManage,
  onClose,
  onDeleted,
}: PrivateWorkerDetailDrawerProps) {
  const { data, isLoading, error } = usePrivateWorker(clientId, workerId);
  const rotate = useRotatePrivateWorker(clientId);
  const revoke = useRevokePrivateWorker(clientId);
  const remove = useDeletePrivateWorker(clientId);

  const [rotateOpen, setRotateOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [rotatedSecret, setRotatedSecret] = useState<PrivateWorkerSecretResponse | null>(null);

  const worker: PrivateWorkerResponse | undefined = data?.data;

  const handleRotate = async (): Promise<void> => {
    try {
      const result = await rotate.mutateAsync(workerId);
      setRotatedSecret(result.data);
      setRotateOpen(false);
    } catch {
      // surfaced via rotate.error
    }
  };

  const handleRevoke = async (): Promise<void> => {
    try {
      await revoke.mutateAsync(workerId);
      setRevokeOpen(false);
    } catch {
      // surfaced via revoke.error
    }
  };

  const handleDelete = async (): Promise<void> => {
    try {
      await remove.mutateAsync(workerId);
      setDeleteOpen(false);
      if (onDeleted) onDeleted();
      onClose();
    } catch {
      // surfaced via remove.error
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className="fixed inset-y-0 right-0 z-50 flex w-full sm:max-w-xl flex-col bg-white dark:bg-gray-900 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Private worker details"
        data-testid="private-worker-drawer"
      >
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {worker?.name ?? 'Private worker'}
            </h2>
            {worker && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 flex items-center">
                <span className="font-mono break-all">{worker.slug}</span>
                <CopyInline value={worker.slug} testId="copy-pw-slug" />
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {isLoading && (
            <div className="flex justify-center py-12">
              <Loader2 className="animate-spin text-brand-500" size={28} />
            </div>
          )}

          {error && !isLoading && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{(error as Error).message}</span>
            </div>
          )}

          {worker && (
            <>
              <section className="space-y-3">
                <DetailRow label="Status">
                  <StatusBadge status={worker.status} />
                </DetailRow>
                <DetailRow label="Exposed port">
                  <span className="font-mono">{worker.exposedPort}</span>
                </DetailRow>
                <DetailRow label="Last seen">
                  <span title={worker.lastSeenAt ?? 'never'}>
                    {formatRelative(worker.lastSeenAt)}
                  </span>
                </DetailRow>
                <DetailRow label="Last source IP">
                  <span className="font-mono">{worker.lastUsedIp ?? '—'}</span>
                </DetailRow>
                <DetailRow label="Bytes in / out">
                  <span className="font-mono">
                    {formatBytes(worker.bytesIn)} / {formatBytes(worker.bytesOut)}
                  </span>
                </DetailRow>
                <DetailRow label="Service name">
                  <span className="inline-flex items-center font-mono text-gray-600 dark:text-gray-400">
                    {worker.serviceName}
                    <CopyInline value={worker.serviceName} />
                  </span>
                </DetailRow>
                <DetailRow label="Tunnel URL">
                  <span className="inline-flex items-center font-mono text-xs text-gray-500 dark:text-gray-400 break-all">
                    {worker.tunnelUrl}
                    <CopyInline value={worker.tunnelUrl} />
                  </span>
                </DetailRow>
                {worker.description && (
                  <DetailRow label="Description">
                    <span>{worker.description}</span>
                  </DetailRow>
                )}
              </section>

              {canManage && (
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    Actions
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setRotateOpen(true)}
                      disabled={worker.status === 'revoked'}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                      data-testid="pw-rotate-btn"
                    >
                      <RefreshCw size={14} /> Rotate token
                    </button>
                    <button
                      type="button"
                      onClick={() => setRevokeOpen(true)}
                      disabled={worker.status === 'revoked'}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 dark:border-red-700 px-3 py-1.5 text-sm font-medium text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
                      data-testid="pw-revoke-btn"
                    >
                      <ShieldOff size={14} /> Revoke
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteOpen(true)}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 dark:border-red-700 px-3 py-1.5 text-sm font-medium text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                      data-testid="pw-delete-btn"
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                  </div>
                  {(rotate.error || revoke.error || remove.error) && (
                    <p className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1">
                      <AlertCircle size={14} />
                      {((rotate.error ?? revoke.error ?? remove.error) as Error).message}
                    </p>
                  )}
                </section>
              )}

              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Recent activity
                </h3>
                <AuditTable clientId={clientId} workerId={workerId} />
              </section>
            </>
          )}
        </div>
      </aside>

      {rotateOpen && (
        <ConfirmModal
          title="Rotate token?"
          message="This rotates the SHARED auth secret used by every private worker on this account. All your other private workers will disconnect until you update each agent's PRIVATE_WORKER_TOKEN environment variable. (v1 limitation — per-worker rotation is on the roadmap.)"
          confirmLabel="Rotate (affects all workers)"
          busy={rotate.isPending}
          onConfirm={handleRotate}
          onCancel={() => setRotateOpen(false)}
          testId="pw-rotate-confirm-modal"
        />
      )}

      {revokeOpen && (
        <ConfirmModal
          title="Revoke worker?"
          message="The worker's token is invalidated immediately. The home agent's connection drops within 30 seconds. The worker is kept for audit; mint a new token by rotating, or delete it permanently."
          confirmLabel="Revoke"
          busy={revoke.isPending}
          onConfirm={handleRevoke}
          onCancel={() => setRevokeOpen(false)}
          testId="pw-revoke-confirm-modal"
        />
      )}

      {deleteOpen && (
        <ConfirmModal
          title="Delete worker?"
          message="The worker, its cluster-side resources, and any ingress routes pointing at it are removed permanently. This cannot be undone."
          confirmLabel="Delete"
          busy={remove.isPending}
          onConfirm={handleDelete}
          onCancel={() => setDeleteOpen(false)}
          testId="pw-delete-confirm-modal"
        />
      )}

      {rotatedSecret && (
        <PrivateWorkerTokenModal
          secret={rotatedSecret}
          onClose={() => setRotatedSecret(null)}
        />
      )}
    </>
  );
}
