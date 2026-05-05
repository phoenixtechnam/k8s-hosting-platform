/**
 * Plesk-style restore cart UI (ADR-034).
 *
 * Layout: two-column.
 *   Left  — bundle picker tabs (config-tables, deployments, domains,
 *           mailboxes, files). Operator clicks "Add" on each row
 *           they want restored.
 *   Right — cart panel. Shows queued items in order, with status,
 *           progress message, and an Execute button. Sequential
 *           per-item; failures pause the cart at the failed item
 *           and the operator can re-execute to retry.
 *
 * Routing: /restore?bundleId=...&clientId=...
 *   bundleId is mandatory — the picker reads from one bundle.
 *   clientId is mandatory — the cart binds to one client (the cart
 *           CRUD route enforces bundle.clientId === cart.clientId).
 *
 * The cart id lives in URL query state too, so reload-after-execute
 * keeps showing the same cart.
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2, Plus, Trash2, Play, AlertCircle, CheckCircle2, FileText, Mail, Globe, Box, Database, RotateCcw } from 'lucide-react';
import {
  useBrowseConfigTables,
  useBrowseDeployments,
  useBrowseDomains,
  useBrowseMailboxes,
  useBrowseFiles,
  useRestoreCart,
  useCreateRestoreCart,
  useAddRestoreItem,
  useRemoveRestoreItem,
  useExecuteRestoreCart,
  useRollbackRestoreCart,
  type RestoreItemInfo,
} from '@/hooks/use-restore-carts';

type Tab = 'config-tables' | 'deployments' | 'domains' | 'mailboxes' | 'files';

export default function RestoreCartPage() {
  const [params, setParams] = useSearchParams();
  const bundleId = params.get('bundleId');
  const clientId = params.get('clientId');
  const cartId = params.get('cartId');
  const [tab, setTab] = useState<Tab>('config-tables');

  const cartQ = useRestoreCart(cartId);
  const createCart = useCreateRestoreCart();
  const addItem = useAddRestoreItem(cartId ?? '');
  const removeItem = useRemoveRestoreItem(cartId ?? '');
  const execCart = useExecuteRestoreCart(cartId ?? '');
  const rollbackCart = useRollbackRestoreCart(cartId ?? '');
  const [rollbackConfirm, setRollbackConfirm] = useState(false);

  // Auto-create the cart on first add if the operator hasn't done so.
  useEffect(() => {
    if (!cartId && clientId) {
      createCart.mutate(
        { clientId, description: `Restore from bundle ${bundleId ?? ''}` },
        {
          onSuccess: (resp) => {
            const next = new URLSearchParams(params);
            next.set('cartId', resp.data.id);
            setParams(next, { replace: true });
          },
        },
      );
    }
  }, [clientId, cartId]);

  if (!bundleId || !clientId) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-700 dark:bg-red-950 dark:text-red-200">
          Missing <code>bundleId</code> or <code>clientId</code> query parameter. Open this page from the bundle list's "Restore" action.
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">Restore</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Browse the bundle and add items to the cart. Items execute sequentially; failures pause the cart so you can retry.
        </p>
        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Bundle: <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-gray-800">{bundleId}</code> · Client: <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-gray-800">{clientId}</code>
          {cartId && <> · Cart: <code className="rounded bg-gray-100 px-1 py-0.5 dark:bg-gray-800">{cartId}</code></>}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_22rem]">
        {/* Left: bundle picker */}
        <section className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <nav className="flex flex-wrap gap-1 border-b border-gray-200 p-2 dark:border-gray-700">
            <TabButton active={tab === 'config-tables'} onClick={() => setTab('config-tables')} icon={<Database className="h-4 w-4" />}>Tables</TabButton>
            <TabButton active={tab === 'deployments'} onClick={() => setTab('deployments')} icon={<Box className="h-4 w-4" />}>Deployments</TabButton>
            <TabButton active={tab === 'domains'} onClick={() => setTab('domains')} icon={<Globe className="h-4 w-4" />}>Domains</TabButton>
            <TabButton active={tab === 'mailboxes'} onClick={() => setTab('mailboxes')} icon={<Mail className="h-4 w-4" />}>Mailboxes</TabButton>
            <TabButton active={tab === 'files'} onClick={() => setTab('files')} icon={<FileText className="h-4 w-4" />}>Files</TabButton>
          </nav>
          <div className="p-4">
            {tab === 'config-tables' && <ConfigTablesPicker bundleId={bundleId} cartReady={!!cartId} addItem={addItem} />}
            {tab === 'deployments' && <DeploymentsPicker bundleId={bundleId} cartReady={!!cartId} addItem={addItem} />}
            {tab === 'domains' && <DomainsPicker bundleId={bundleId} cartReady={!!cartId} addItem={addItem} />}
            {tab === 'mailboxes' && <MailboxesPicker bundleId={bundleId} cartReady={!!cartId} addItem={addItem} />}
            {tab === 'files' && <FilesPicker bundleId={bundleId} cartReady={!!cartId} addItem={addItem} />}
          </div>
        </section>

        {/* Right: cart panel */}
        <aside className="rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div className="border-b border-gray-200 p-3 dark:border-gray-700">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Cart</h2>
              {cartQ.data?.data && <CartStatusBadge status={cartQ.data.data.status} />}
            </div>
            {cartQ.data?.data?.lastError && (
              <div className="mt-2 flex gap-1 text-xs text-red-600 dark:text-red-400">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{cartQ.data.data.lastError}</span>
              </div>
            )}
          </div>
          <CartItemsList
            items={cartQ.data?.data?.items ?? []}
            onRemove={(itemId) => removeItem.mutate(itemId)}
            disabled={cartQ.data?.data?.status === 'executing'}
          />
          <div className="border-t border-gray-200 p-3 dark:border-gray-700">
            <button
              type="button"
              onClick={() => cartId && execCart.mutate()}
              disabled={!cartId || !cartQ.data?.data?.items?.length || cartQ.data.data.status === 'executing' || execCart.isPending}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {execCart.isPending || cartQ.data?.data?.status === 'executing' ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Executing…
                </>
              ) : (
                <>
                  <Play className="h-4 w-4" /> Execute cart
                </>
              )}
            </button>
            {cartQ.data?.data?.preRestoreSnapshotId && (
              <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs dark:border-amber-700 dark:bg-amber-950">
                <p className="font-medium text-amber-900 dark:text-amber-100">Safety net</p>
                <p className="mt-0.5 text-amber-800 dark:text-amber-200">
                  Snapshot: <code className="rounded bg-amber-100 px-1 dark:bg-amber-900">{cartQ.data.data.preRestoreSnapshotId.slice(0, 12)}…</code>
                </p>
                {cartQ.data.data.status !== 'executing' && !rollbackConfirm && (
                  <button
                    type="button"
                    onClick={() => setRollbackConfirm(true)}
                    className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-amber-400 bg-white px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-600 dark:bg-amber-900 dark:text-amber-100 dark:hover:bg-amber-800"
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Roll back to snapshot
                  </button>
                )}
                {rollbackConfirm && (
                  <div className="mt-2 space-y-2">
                    <p className="text-amber-900 dark:text-amber-100">
                      This quiesces all workloads, replaces tenant PVC contents from the snapshot, and unquiesces. The change is hard to reverse.
                    </p>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => { rollbackCart.mutate(undefined, { onSuccess: () => setRollbackConfirm(false) }); }}
                        disabled={rollbackCart.isPending}
                        className="flex-1 rounded-md bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        {rollbackCart.isPending ? 'Dispatching…' : 'Confirm rollback'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRollbackConfirm(false)}
                        className="flex-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {rollbackCart.data?.data?.operationId && (
                  <p className="mt-2 text-amber-800 dark:text-amber-200">
                    Rollback dispatched. Operation <code className="rounded bg-amber-100 px-1 dark:bg-amber-900">{rollbackCart.data.data.operationId.slice(0, 12)}…</code> is running. See Storage Lifecycle for progress.
                  </p>
                )}
                {rollbackCart.error && (
                  <p className="mt-2 text-red-700 dark:text-red-300">{(rollbackCart.error as Error).message}</p>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ── Cart panel components ───────────────────────────────────────────

function CartStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
    executing: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
    paused: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
    done: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  };
  return <span className={`rounded-full px-2 py-0.5 text-xs ${styles[status] ?? styles.draft}`}>{status}</span>;
}

function CartItemsList({
  items,
  onRemove,
  disabled,
}: {
  items: readonly RestoreItemInfo[];
  onRemove: (itemId: string) => void;
  disabled: boolean;
}) {
  if (items.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-gray-500 dark:text-gray-400">Cart is empty. Pick items from the left.</p>;
  }
  return (
    <ul className="divide-y divide-gray-100 dark:divide-gray-700">
      {items.map((it) => (
        <li key={it.id} className="flex items-start justify-between gap-2 p-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
              <span className="rounded bg-gray-100 px-1 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300">{it.seq}</span>
              <span>{it.label ?? itemTypeLabel(it.type)}</span>
              <ItemStatusIcon status={it.status} />
            </div>
            <div className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">{it.type}</div>
            {it.progressMessage && (
              <div className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">{it.progressMessage}</div>
            )}
            {it.lastError && (
              <div className="mt-0.5 truncate text-xs text-red-600 dark:text-red-400">{it.lastError}</div>
            )}
          </div>
          <button
            type="button"
            onClick={() => onRemove(it.id)}
            disabled={disabled || it.status === 'applying' || it.status === 'done'}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-gray-700"
            title={it.status === 'done' ? 'Cannot remove a completed item' : 'Remove item'}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function ItemStatusIcon({ status }: { status: string }) {
  if (status === 'done') return <CheckCircle2 className="h-4 w-4 text-green-600" />;
  if (status === 'applying') return <Loader2 className="h-4 w-4 animate-spin text-blue-600" />;
  if (status === 'failed') return <AlertCircle className="h-4 w-4 text-red-600" />;
  return null;
}

function itemTypeLabel(type: string): string {
  switch (type) {
    case 'config-tables': return 'Config tables';
    case 'deployments-by-id': return 'Deployment(s)';
    case 'domains-by-id': return 'Domain(s)';
    case 'mailboxes-by-address': return 'Mailbox(es)';
    case 'files-paths': return 'File(s)';
    default: return type;
  }
}

// ── Picker components ───────────────────────────────────────────────

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
        active
          ? 'bg-brand-600 text-white'
          : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

interface PickerProps {
  bundleId: string;
  cartReady: boolean;
  addItem: ReturnType<typeof useAddRestoreItem>;
}

function ConfigTablesPicker({ bundleId, cartReady, addItem }: PickerProps) {
  const q = useBrowseConfigTables(bundleId);
  if (q.isLoading) return <PickerSkeleton />;
  if (q.isError) return <PickerError msg={(q.error as Error).message} />;
  const tables = q.data?.data.tables ?? [];
  return (
    <ul className="divide-y divide-gray-100 dark:divide-gray-700">
      {tables.map((t) => (
        <li key={t.name} className="flex items-center justify-between py-2">
          <span className="text-sm text-gray-900 dark:text-gray-100">
            {t.name} <span className="ml-1 text-xs text-gray-500">({t.rowCount} rows)</span>
          </span>
          <AddBtn
            disabled={!cartReady || t.rowCount === 0 || addItem.isPending}
            onClick={() => addItem.mutate({
              type: 'config-tables',
              bundleId,
              selector: { kind: 'tables', tables: [t.name] },
              label: `Table: ${t.name}`,
            })}
          />
        </li>
      ))}
    </ul>
  );
}

function DeploymentsPicker({ bundleId, cartReady, addItem }: PickerProps) {
  const q = useBrowseDeployments(bundleId);
  if (q.isLoading) return <PickerSkeleton />;
  if (q.isError) return <PickerError msg={(q.error as Error).message} />;
  const list = q.data?.data.deployments ?? [];
  return (
    <ul className="divide-y divide-gray-100 dark:divide-gray-700">
      {list.map((d) => (
        <li key={d.id} className="flex items-center justify-between py-2">
          <div className="min-w-0">
            <span className="text-sm text-gray-900 dark:text-gray-100">{d.name}</span>
            <span className="ml-2 text-xs text-gray-500">{d.id}</span>
          </div>
          <AddBtn
            disabled={!cartReady || addItem.isPending}
            onClick={() => addItem.mutate({
              type: 'deployments-by-id',
              bundleId,
              selector: { kind: 'ids', deploymentIds: [d.id] },
              label: `Deployment: ${d.name}`,
            })}
          />
        </li>
      ))}
    </ul>
  );
}

function DomainsPicker({ bundleId, cartReady, addItem }: PickerProps) {
  const q = useBrowseDomains(bundleId);
  if (q.isLoading) return <PickerSkeleton />;
  if (q.isError) return <PickerError msg={(q.error as Error).message} />;
  const list = q.data?.data.domains ?? [];
  return (
    <ul className="divide-y divide-gray-100 dark:divide-gray-700">
      {list.map((d) => (
        <li key={d.id} className="flex items-center justify-between py-2">
          <div className="min-w-0">
            <span className="text-sm text-gray-900 dark:text-gray-100">{d.hostname}</span>
            <span className="ml-2 text-xs text-gray-500">{d.id}</span>
          </div>
          <AddBtn
            disabled={!cartReady || addItem.isPending}
            onClick={() => addItem.mutate({
              type: 'domains-by-id',
              bundleId,
              selector: { kind: 'ids', domainIds: [d.id] },
              label: `Domain: ${d.hostname}`,
            })}
          />
        </li>
      ))}
    </ul>
  );
}

function MailboxesPicker({ bundleId, cartReady, addItem }: PickerProps) {
  const q = useBrowseMailboxes(bundleId);
  if (q.isLoading) return <PickerSkeleton />;
  if (q.isError) return <PickerError msg={(q.error as Error).message} />;
  const list = q.data?.data.addresses ?? [];
  if (list.length === 0) return <p className="py-4 text-center text-sm text-gray-500">No mailboxes captured in this bundle.</p>;
  return (
    <div>
      <div className="mb-2 flex justify-end">
        <button
          type="button"
          disabled={!cartReady || addItem.isPending || list.length === 0}
          onClick={() => addItem.mutate({
            type: 'mailboxes-by-address',
            bundleId,
            selector: { kind: 'all' },
            label: `All ${list.length} mailbox(es)`,
          })}
          className="rounded-md border border-brand-500 px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50 dark:hover:bg-brand-900"
        >
          Add all
        </button>
      </div>
      <ul className="divide-y divide-gray-100 dark:divide-gray-700">
        {list.map((addr) => (
          <li key={addr} className="flex items-center justify-between py-2">
            <span className="truncate text-sm text-gray-900 dark:text-gray-100">{addr}</span>
            <AddBtn
              disabled={!cartReady || addItem.isPending}
              onClick={() => addItem.mutate({
                type: 'mailboxes-by-address',
                bundleId,
                selector: { kind: 'addresses', addresses: [addr] },
                label: `Mailbox: ${addr}`,
              })}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function FilesPicker({ bundleId, cartReady, addItem }: PickerProps) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<Array<{ path: string; size: number; mode: number; mtime: string }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const q = useBrowseFiles(bundleId, cursor, 500);
  useEffect(() => {
    if (q.data?.data.entries) {
      setPages((prev) => cursor === null ? [...q.data.data.entries] : [...prev, ...q.data.data.entries]);
    }
  }, [q.data?.data.entries]);

  const toggle = (path: string) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  const allCount = q.data?.data.totalCount ?? 0;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
        <span>{pages.length} of {allCount} entries loaded</span>
        {q.data?.data.nextCursor && (
          <button
            type="button"
            onClick={() => setCursor(q.data.data.nextCursor)}
            className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-700"
          >
            Load more
          </button>
        )}
        <span className="ml-auto">{selected.size} selected</span>
        <button
          type="button"
          disabled={!cartReady || (selected.size === 0 && allCount === 0) || addItem.isPending}
          onClick={() => addItem.mutate({
            type: 'files-paths',
            bundleId,
            selector: selected.size === 0
              ? { kind: 'full' }
              : { kind: 'paths', paths: [...selected] },
            label: selected.size === 0 ? `All files` : `${selected.size} file(s)`,
          })}
          className="rounded-md border border-brand-500 px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50 dark:hover:bg-brand-900"
        >
          {selected.size === 0 ? 'Add all (whole archive)' : `Add ${selected.size}`}
        </button>
      </div>
      {q.isLoading && pages.length === 0 ? (
        <PickerSkeleton />
      ) : q.isError ? (
        <PickerError msg={(q.error as Error).message} />
      ) : (
        <ul className="max-h-96 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700">
          {pages.map((e) => (
            <li key={e.path} className="flex items-center gap-2 py-1.5 text-sm">
              <input
                type="checkbox"
                checked={selected.has(e.path)}
                onChange={() => toggle(e.path)}
                className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="flex-1 truncate text-gray-900 dark:text-gray-100">{e.path}</span>
              <span className="text-xs text-gray-500">{formatSize(e.size)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddBtn({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
    >
      <Plus className="h-3.5 w-3.5" />
    </button>
  );
}

function PickerSkeleton() {
  return (
    <div className="space-y-2 py-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-7 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
      ))}
    </div>
  );
}

function PickerError({ msg }: { msg: string }) {
  return (
    <div className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
      <AlertCircle className="mr-1 inline h-4 w-4" /> {msg}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}
