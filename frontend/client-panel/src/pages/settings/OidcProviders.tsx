import { useState, type FormEvent } from 'react';
import { Lock, Loader2, ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useClientContext } from '@/hooks/use-client-context';
import {
  useOidcProviders,
  useCreateOidcProvider,
  useUpdateOidcProvider,
  useDeleteOidcProvider,
} from '@/hooks/use-ingress-auth';
import ProvidersTable, { type ProviderRow } from '@/components/settings/ProvidersTable';
import type {
  OidcProviderInput,
  OidcProviderResponse,
  OidcAuthMethod,
  OidcResponseType,
} from '@k8s-hosting/api-contracts';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

const LABEL_CLASS = 'block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1';

interface ProviderRowDisplay extends ProviderRow {
  readonly raw: OidcProviderResponse;
}

export default function OidcProviders() {
  const { clientId } = useClientContext();
  const { data: providers, isLoading } = useOidcProviders(clientId ?? undefined);
  const createMut = useCreateOidcProvider(clientId ?? '');
  const deleteMut = useDeleteOidcProvider(clientId ?? '');

  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; provider: OidcProviderResponse } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<OidcProviderResponse | null>(null);

  const rows: ProviderRowDisplay[] = (providers ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    subtitle: p.issuerUrl,
    consumerCount: p.consumerCount,
    raw: p,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/settings" className="rounded p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">
          <ArrowLeft size={18} />
        </Link>
        <Lock size={24} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">OIDC Providers</h1>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400 max-w-3xl">
        Configure OpenID Connect providers reused across multiple ingress routes. After creating
        a provider here, pick it from the dropdown in any ingress's Access Control tab.
      </p>

      <ProvidersTable
        title="Providers"
        emptyMessage="No OIDC providers yet. Create one to start gating ingresses with OAuth2/OIDC."
        rows={rows}
        isLoading={isLoading}
        onCreate={() => setModal({ mode: 'create' })}
        onEdit={(r) => setModal({ mode: 'edit', provider: r.raw })}
        onDelete={(r) => setConfirmDelete(r.raw)}
        testIdPrefix="oidc-providers"
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
        <DeleteModal
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

      {createMut.error && (
        <p className="text-sm text-red-600 dark:text-red-400">Create failed: {String(createMut.error)}</p>
      )}
    </div>
  );
}

interface ModalProps {
  readonly mode: 'create' | 'edit';
  readonly provider: OidcProviderResponse | null;
  readonly clientId: string;
  readonly onClose: () => void;
}

function ProviderModal({ mode, provider, clientId, onClose }: ModalProps) {
  const createMut = useCreateOidcProvider(clientId);
  const updateMut = useUpdateOidcProvider(clientId, provider?.id ?? '');

  const [name, setName] = useState(provider?.name ?? '');
  const [issuerUrl, setIssuerUrl] = useState(provider?.issuerUrl ?? '');
  const [oauthClientId, setOauthClientId] = useState(provider?.oauthClientId ?? '');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const [authMethod, setAuthMethod] = useState<OidcAuthMethod>(provider?.authMethod ?? 'client_secret_basic');
  const [responseType, setResponseType] = useState<OidcResponseType>(provider?.responseType ?? 'code');
  const [usePkce, setUsePkce] = useState(provider?.usePkce ?? true);
  const [defaultScopes, setDefaultScopes] = useState(provider?.defaultScopes ?? 'openid profile email');

  const isPending = createMut.isPending || updateMut.isPending;
  const error = createMut.error ?? updateMut.error;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const payload: OidcProviderInput = {
      name,
      issuerUrl,
      oauthClientId,
      ...(oauthClientSecret ? { oauthClientSecret } : {}),
      authMethod,
      responseType,
      usePkce,
      defaultScopes,
    };
    if (mode === 'create') {
      // Secret is required on create.
      if (!oauthClientSecret) {
        return;
      }
      await createMut.mutateAsync(payload);
    } else {
      await updateMut.mutateAsync(payload);
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="oidc-provider-modal">
      <div className="w-full max-w-2xl rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {mode === 'create' ? 'New OIDC Provider' : `Edit "${provider?.name}"`}
        </h2>

        <form onSubmit={onSubmit} className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <label className={LABEL_CLASS}>Name</label>
            <input
              className={INPUT_CLASS}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Production Zitadel"
              data-testid="oidc-provider-name"
            />
          </div>
          <div className="md:col-span-2">
            <label className={LABEL_CLASS}>Issuer URL</label>
            <input
              className={INPUT_CLASS}
              type="url"
              value={issuerUrl}
              onChange={(e) => setIssuerUrl(e.target.value)}
              required
              placeholder="https://auth.example.com/"
              data-testid="oidc-provider-issuer"
            />
          </div>
          <div>
            <label className={LABEL_CLASS}>Client ID</label>
            <input
              className={INPUT_CLASS}
              value={oauthClientId}
              onChange={(e) => setOauthClientId(e.target.value)}
              required
              data-testid="oidc-provider-client-id"
            />
          </div>
          <div>
            <label className={LABEL_CLASS}>
              Client Secret {mode === 'edit' && <span className="text-gray-400">(leave empty to keep current)</span>}
            </label>
            <input
              className={INPUT_CLASS}
              type="password"
              value={oauthClientSecret}
              onChange={(e) => setOauthClientSecret(e.target.value)}
              required={mode === 'create'}
              placeholder={mode === 'edit' && provider?.secretSet ? '••••••••' : ''}
              data-testid="oidc-provider-client-secret"
            />
          </div>
          <div>
            <label className={LABEL_CLASS}>Authentication Method</label>
            <select className={INPUT_CLASS} value={authMethod} onChange={(e) => setAuthMethod(e.target.value as OidcAuthMethod)}>
              <option value="client_secret_basic">client_secret_basic</option>
              <option value="client_secret_post">client_secret_post</option>
            </select>
          </div>
          <div>
            <label className={LABEL_CLASS}>Response Type</label>
            <select className={INPUT_CLASS} value={responseType} onChange={(e) => setResponseType(e.target.value as OidcResponseType)}>
              <option value="code">code</option>
              <option value="id_token">id_token</option>
              <option value="code_id_token">code id_token</option>
            </select>
          </div>
          <div>
            <label className={LABEL_CLASS}>Default Scopes</label>
            <input
              className={INPUT_CLASS}
              value={defaultScopes}
              onChange={(e) => setDefaultScopes(e.target.value)}
              placeholder="openid profile email"
            />
          </div>
          <div className="flex items-center gap-2 pt-6">
            <input
              type="checkbox"
              id="provider-pkce"
              checked={usePkce}
              onChange={(e) => setUsePkce(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <label htmlFor="provider-pkce" className="text-sm text-gray-700 dark:text-gray-300">
              Use PKCE (S256)
            </label>
          </div>

          {error && (
            <div className="md:col-span-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {error instanceof Error ? error.message : String(error)}
            </div>
          )}

          <div className="md:col-span-2 mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="oidc-provider-submit"
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

interface DeleteModalProps {
  readonly provider: OidcProviderResponse;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<void>;
  readonly isPending: boolean;
  readonly error: unknown;
}

function DeleteModal({ provider, onClose, onConfirm, isPending, error }: DeleteModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Delete provider?</h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          This will permanently remove <strong>{provider.name}</strong>. This cannot be undone.
        </p>
        {provider.consumerCount > 0 && (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
            This provider is referenced by {provider.consumerCount} ingress
            {provider.consumerCount === 1 ? '' : 'es'} — detach them first.
          </p>
        )}
        {error != null && (
          <div className="mt-3 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error instanceof Error ? error.message : String(error)}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending || provider.consumerCount > 0}
            className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            data-testid="oidc-provider-confirm-delete"
          >
            {isPending && <Loader2 size={14} className="animate-spin" />}
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
