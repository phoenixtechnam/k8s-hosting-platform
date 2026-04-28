import { useState, type FormEvent } from 'react';
import { Network, Loader2, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useClientContext } from '@/hooks/use-client-context';
import {
  useZitiProviders,
  useCreateZitiProvider,
  useUpdateZitiProvider,
  useDeleteZitiProvider,
} from '@/hooks/use-ziti-providers';
import ProvidersTable, { type ProviderRow } from '@/components/settings/ProvidersTable';
import type { ZitiProviderInput, ZitiProviderResponse } from '@k8s-hosting/api-contracts';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

const LABEL_CLASS = 'block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1';

interface ProviderRowDisplay extends ProviderRow {
  readonly raw: ZitiProviderResponse;
}

export default function OpenZitiProviders() {
  const { clientId } = useClientContext();
  const { data: providers, isLoading } = useZitiProviders(clientId ?? undefined);
  const deleteMut = useDeleteZitiProvider(clientId ?? '');

  const [modal, setModal] = useState<
    { mode: 'create' } | { mode: 'edit'; provider: ZitiProviderResponse } | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState<ZitiProviderResponse | null>(null);

  const rows: ProviderRowDisplay[] = (providers ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    subtitle: p.controllerUrl,
    consumerCount: p.consumerCount,
    raw: p,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/settings" className="rounded p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">
          <ArrowLeft size={18} />
        </Link>
        <Network size={24} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">OpenZiti Providers</h1>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400 max-w-3xl">
        Configure OpenZiti controllers used by the App-level <strong>Network Access</strong>
        feature (tunneler mode). Once a provider is registered, pick it on any deployment's
        Network Access tab to advertise that app as a Ziti service. End users must run a Ziti
        tunneler on their device to reach it.
      </p>

      <ProvidersTable
        title="Providers"
        emptyMessage="No OpenZiti providers yet. Register one to start using mesh-only Network Access."
        rows={rows}
        isLoading={isLoading}
        onCreate={() => setModal({ mode: 'create' })}
        onEdit={(r) => setModal({ mode: 'edit', provider: r.raw })}
        onDelete={(r) => setConfirmDelete(r.raw)}
        testIdPrefix="ziti-providers"
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
  readonly provider: ZitiProviderResponse | null;
  readonly clientId: string;
  readonly onClose: () => void;
}

function ProviderModal({ mode, provider, clientId, onClose }: ModalProps) {
  const createMut = useCreateZitiProvider(clientId);
  const updateMut = useUpdateZitiProvider(clientId, provider?.id ?? '');

  const [name, setName] = useState(provider?.name ?? '');
  const [controllerUrl, setControllerUrl] = useState(provider?.controllerUrl ?? '');
  const [enrollmentJwt, setEnrollmentJwt] = useState('');

  const isPending = createMut.isPending || updateMut.isPending;
  const error = createMut.error ?? updateMut.error;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mode === 'create' && !enrollmentJwt) return;
    const payload: ZitiProviderInput = {
      name,
      controllerUrl,
      ...(enrollmentJwt ? { enrollmentJwt } : {}),
    };
    if (mode === 'create') {
      await createMut.mutateAsync(payload);
    } else {
      await updateMut.mutateAsync(payload);
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="ziti-provider-modal">
      <div className="w-full max-w-2xl rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {mode === 'create' ? 'New OpenZiti Provider' : `Edit "${provider?.name}"`}
        </h2>
        <form onSubmit={onSubmit} className="mt-4 grid grid-cols-1 gap-4">
          <div>
            <label className={LABEL_CLASS}>Name</label>
            <input
              className={INPUT_CLASS}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Production Ziti Mesh"
              data-testid="ziti-provider-name"
            />
          </div>
          <div>
            <label className={LABEL_CLASS}>Controller URL</label>
            <input
              className={INPUT_CLASS}
              type="url"
              value={controllerUrl}
              onChange={(e) => setControllerUrl(e.target.value)}
              required
              placeholder="https://ziti-controller.example.com:1280"
              data-testid="ziti-provider-controller"
            />
          </div>
          <div>
            <label className={LABEL_CLASS}>
              Enrollment JWT
              {mode === 'edit' && <span className="ml-2 text-gray-400">(leave empty to keep current)</span>}
            </label>
            <textarea
              className={`${INPUT_CLASS} font-mono text-xs`}
              rows={4}
              value={enrollmentJwt}
              onChange={(e) => setEnrollmentJwt(e.target.value)}
              required={mode === 'create'}
              placeholder="eyJhbGc...one-shot enrollment token from your Ziti controller"
              data-testid="ziti-provider-jwt"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              One-shot token issued by the Ziti controller. The platform's tunneler exchanges it
              for a long-lived client cert on first use.
            </p>
          </div>

          {error != null && (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {error instanceof Error ? error.message : String(error)}
            </div>
          )}

          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="ziti-provider-submit"
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
  readonly provider: ZitiProviderResponse;
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
