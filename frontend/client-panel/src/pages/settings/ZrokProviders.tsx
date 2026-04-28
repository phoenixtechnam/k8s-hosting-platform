import { useState, type FormEvent } from 'react';
import { Share2, Loader2, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useClientContext } from '@/hooks/use-client-context';
import {
  useZrokProviders,
  useCreateZrokProvider,
  useUpdateZrokProvider,
  useDeleteZrokProvider,
} from '@/hooks/use-zrok-providers';
import ProvidersTable, { type ProviderRow } from '@/components/settings/ProvidersTable';
import {
  ZROK_DEFAULT_CONTROLLER_URL,
  type ZrokProviderInput,
  type ZrokProviderResponse,
} from '@k8s-hosting/api-contracts';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

const LABEL_CLASS = 'block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1';

interface ProviderRowDisplay extends ProviderRow {
  readonly raw: ZrokProviderResponse;
}

export default function ZrokProviders() {
  const { clientId } = useClientContext();
  const { data: providers, isLoading } = useZrokProviders(clientId ?? undefined);
  const deleteMut = useDeleteZrokProvider(clientId ?? '');

  const [modal, setModal] = useState<
    { mode: 'create' } | { mode: 'edit'; provider: ZrokProviderResponse } | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState<ZrokProviderResponse | null>(null);

  const rows: ProviderRowDisplay[] = (providers ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    subtitle: `${p.controllerUrl} · ${p.accountEmail}`,
    consumerCount: p.consumerCount,
    raw: p,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/settings" className="rounded p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">
          <ArrowLeft size={18} />
        </Link>
        <Share2 size={24} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Zrok Providers</h1>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400 max-w-3xl">
        Register zrok controllers (default <code className="rounded bg-gray-100 dark:bg-gray-700 px-1 py-0.5 text-xs">{ZROK_DEFAULT_CONTROLLER_URL}</code>
        {' '}or self-hosted) for the App-level <strong>Network Access</strong> feature (zrok share
        mode). End users access an app via <code className="rounded bg-gray-100 dark:bg-gray-700 px-1 py-0.5 text-xs">zrok access private &lt;token&gt;</code>.
      </p>

      <ProvidersTable
        title="Providers"
        emptyMessage="No zrok providers yet. Register one to enable private-share Network Access."
        rows={rows}
        isLoading={isLoading}
        onCreate={() => setModal({ mode: 'create' })}
        onEdit={(r) => setModal({ mode: 'edit', provider: r.raw })}
        onDelete={(r) => setConfirmDelete(r.raw)}
        testIdPrefix="zrok-providers"
      />

      {modal && clientId && (
        <ProviderModal
          mode={modal.mode}
          provider={modal.mode === 'edit' ? modal.provider : null}
          clientId={clientId}
          onClose={() => setModal(null)}
        />
      )}

      {confirmDelete && (
        <DeleteConfirmModal
          provider={confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onConfirm={async () => {
            await deleteMut.mutateAsync(confirmDelete.id);
            setConfirmDelete(null);
          }}
          isPending={deleteMut.isPending}
          error={deleteMut.error}
        />
      )}
    </div>
  );
}

interface ModalProps {
  readonly mode: 'create' | 'edit';
  readonly provider: ZrokProviderResponse | null;
  readonly clientId: string;
  readonly onClose: () => void;
}

function ProviderModal({ mode, provider, clientId, onClose }: ModalProps) {
  const createMut = useCreateZrokProvider(clientId);
  const updateMut = useUpdateZrokProvider(clientId, provider?.id ?? '');

  const [name, setName] = useState(provider?.name ?? '');
  const [controllerUrl, setControllerUrl] = useState(
    provider?.controllerUrl ?? ZROK_DEFAULT_CONTROLLER_URL,
  );
  const [accountEmail, setAccountEmail] = useState(provider?.accountEmail ?? '');
  const [accountToken, setAccountToken] = useState('');

  const isPending = createMut.isPending || updateMut.isPending;
  const error = createMut.error ?? updateMut.error;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mode === 'create' && !accountToken) return;
    const payload: ZrokProviderInput = {
      name,
      controllerUrl,
      accountEmail,
      ...(accountToken ? { accountToken } : {}),
    };
    if (mode === 'create') {
      await createMut.mutateAsync(payload);
    } else {
      await updateMut.mutateAsync(payload);
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="zrok-provider-modal">
      <div className="w-full max-w-2xl rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {mode === 'create' ? 'New Zrok Provider' : `Edit "${provider?.name}"`}
        </h2>
        <form onSubmit={onSubmit} className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={LABEL_CLASS}>Name</label>
            <input
              className={INPUT_CLASS}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Hosted zrok"
              data-testid="zrok-provider-name"
            />
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL_CLASS}>
              Controller URL{' '}
              <button
                type="button"
                onClick={() => setControllerUrl(ZROK_DEFAULT_CONTROLLER_URL)}
                className="ml-2 text-blue-600 hover:underline dark:text-blue-400"
              >
                use default
              </button>
            </label>
            <input
              className={INPUT_CLASS}
              type="url"
              value={controllerUrl}
              onChange={(e) => setControllerUrl(e.target.value)}
              required
              placeholder={ZROK_DEFAULT_CONTROLLER_URL}
              data-testid="zrok-provider-controller"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Use {ZROK_DEFAULT_CONTROLLER_URL} for hosted zrok or paste a self-hosted URL.
            </p>
          </div>
          <div>
            <label className={LABEL_CLASS}>Account Email</label>
            <input
              className={INPUT_CLASS}
              type="email"
              value={accountEmail}
              onChange={(e) => setAccountEmail(e.target.value)}
              required
              data-testid="zrok-provider-email"
            />
          </div>
          <div>
            <label className={LABEL_CLASS}>
              Account Token
              {mode === 'edit' && <span className="ml-2 text-gray-400">(leave empty to keep)</span>}
            </label>
            <input
              className={INPUT_CLASS}
              type="password"
              value={accountToken}
              onChange={(e) => setAccountToken(e.target.value)}
              required={mode === 'create'}
              placeholder={mode === 'edit' && provider?.tokenSet ? '••••••••' : ''}
              data-testid="zrok-provider-token"
            />
          </div>

          {error != null && (
            <div className="sm:col-span-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {error instanceof Error ? error.message : String(error)}
            </div>
          )}

          <div className="sm:col-span-2 mt-2 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="zrok-provider-submit"
            >
              {isPending && <Loader2 size={14} className="animate-spin" />}
              {mode === 'create' ? 'Create' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface DeleteConfirmProps {
  readonly provider: ZrokProviderResponse;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<void>;
  readonly isPending: boolean;
  readonly error: unknown;
}

function DeleteConfirmModal({ provider, onClose, onConfirm, isPending, error }: DeleteConfirmProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Delete provider?</h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          This will permanently remove <strong>{provider.name}</strong>.
        </p>
        {provider.consumerCount > 0 && (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
            In use by {provider.consumerCount} deployment(s) — detach them first.
          </p>
        )}
        {error != null && (
          <div className="mt-3 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error instanceof Error ? error.message : String(error)}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending || provider.consumerCount > 0}
            className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {isPending && <Loader2 size={14} className="animate-spin" />}
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
