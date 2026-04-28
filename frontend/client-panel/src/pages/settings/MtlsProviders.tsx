import { useState, type FormEvent } from 'react';
import { Shield, Loader2, ArrowLeft, Upload, Sparkles, FileKey, Copy, CheckCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useClientContext } from '@/hooks/use-client-context';
import {
  useMtlsProviders,
  useCreateMtlsProvider,
  useUpdateMtlsProvider,
  useDeleteMtlsProvider,
  useIssueMtlsCert,
} from '@/hooks/use-mtls-providers';
import ProvidersTable, { type ProviderRow } from '@/components/settings/ProvidersTable';
import type {
  MtlsProviderResponse,
  MtlsProviderInput,
  MtlsProviderUpdate,
  MtlsIssueCertResponse,
} from '@k8s-hosting/api-contracts';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

const LABEL_CLASS = 'block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1';

interface ProviderRowDisplay extends ProviderRow {
  readonly raw: MtlsProviderResponse;
}

type ModalState =
  | null
  | { mode: 'upload' }
  | { mode: 'generate' }
  | { mode: 'edit'; provider: MtlsProviderResponse }
  | { mode: 'issue'; provider: MtlsProviderResponse };

export default function MtlsProviders() {
  const { clientId } = useClientContext();
  const { data: providers, isLoading } = useMtlsProviders(clientId ?? undefined);
  const deleteMut = useDeleteMtlsProvider(clientId ?? '');

  const [modal, setModal] = useState<ModalState>(null);
  const [confirmDelete, setConfirmDelete] = useState<MtlsProviderResponse | null>(null);

  const rows: ProviderRowDisplay[] = (providers ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    subtitle: p.caCertSubject,
    consumerCount: p.consumerCount,
    raw: p,
    extraCells: (
      <td className="px-2 py-2">
        <span className={p.canIssue
          ? 'inline-flex items-center rounded-full bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-200 px-2 py-0.5 text-xs font-medium'
          : 'text-xs text-gray-500 dark:text-gray-400'}>
          {p.canIssue ? 'can issue' : 'no key'}
        </span>
      </td>
    ),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/settings" className="rounded p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">
          <ArrowLeft size={18} />
        </Link>
        <Shield size={24} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">mTLS Providers</h1>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400 max-w-3xl">
        Reusable CA bundles for ingress-level client-cert authentication. Upload an existing CA
        (any source — internal corporate CA, Ziti intermediate, HSM chain) or generate a new
        self-signed CA here. Providers with a CA private key on file (the &quot;can issue&quot;
        flag) can also mint user certs for distribution to end users.
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setModal({ mode: 'upload' })}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          data-testid="mtls-providers-upload-btn"
        >
          <Upload size={14} /> Upload CA
        </button>
        <button
          type="button"
          onClick={() => setModal({ mode: 'generate' })}
          className="inline-flex items-center gap-2 rounded-lg border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 px-3 py-1.5 text-sm font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40"
          data-testid="mtls-providers-generate-btn"
        >
          <Sparkles size={14} /> Generate new CA
        </button>
      </div>

      <ProvidersTable
        title="Providers"
        emptyMessage="No mTLS providers yet. Upload a CA you trust, or generate a fresh one."
        rows={rows}
        isLoading={isLoading}
        onCreate={() => setModal({ mode: 'upload' })}
        onEdit={(r) => setModal({ mode: 'edit', provider: r.raw })}
        onDelete={(r) => setConfirmDelete(r.raw)}
        extraColumns={[{ header: 'Issuance' }]}
        testIdPrefix="mtls-providers"
      />

      {modal?.mode === 'upload' && clientId && (
        <UploadOrEditModal mode="upload" provider={null} clientId={clientId} onClose={() => setModal(null)} />
      )}
      {modal?.mode === 'edit' && clientId && (
        <UploadOrEditModal mode="edit" provider={modal.provider} clientId={clientId} onClose={() => setModal(null)} />
      )}
      {modal?.mode === 'generate' && clientId && (
        <GenerateModal clientId={clientId} onClose={() => setModal(null)} />
      )}
      {modal?.mode === 'issue' && clientId && (
        <IssueCertModal provider={modal.provider} clientId={clientId} onClose={() => setModal(null)} />
      )}

      {/* Show 'Issue user cert' button next to providers that can_issue. */}
      {(providers ?? []).some((p) => p.canIssue) && (
        <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <FileKey size={18} /> Issue User Certs
          </h2>
          <p className="mt-1 mb-3 text-sm text-gray-600 dark:text-gray-400">
            Mint a fresh client cert from a provider that has a CA key on file. The cert + key are
            shown ONCE — copy them right away.
          </p>
          <div className="flex flex-wrap gap-2">
            {(providers ?? []).filter((p) => p.canIssue).map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setModal({ mode: 'issue', provider: p })}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                data-testid={`mtls-issue-${p.id}`}
              >
                <FileKey size={14} /> {p.name}
              </button>
            ))}
          </div>
        </section>
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

// ─── Upload / Edit modal ───────────────────────────────────────────

interface UploadModalProps {
  readonly mode: 'upload' | 'edit';
  readonly provider: MtlsProviderResponse | null;
  readonly clientId: string;
  readonly onClose: () => void;
}

function UploadOrEditModal({ mode, provider, clientId, onClose }: UploadModalProps) {
  const createMut = useCreateMtlsProvider(clientId);
  const updateMut = useUpdateMtlsProvider(clientId, provider?.id ?? '');

  const [name, setName] = useState(provider?.name ?? '');
  const [caCertPem, setCaCertPem] = useState('');
  const [caKeyPem, setCaKeyPem] = useState('');

  const isPending = createMut.isPending || updateMut.isPending;
  const error = createMut.error ?? updateMut.error;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (mode === 'upload') {
      const payload: MtlsProviderInput = {
        source: 'upload',
        name,
        caCertPem,
        ...(caKeyPem ? { caKeyPem } : {}),
      };
      await createMut.mutateAsync(payload);
    } else {
      const payload: MtlsProviderUpdate = {
        ...(name ? { name } : {}),
        ...(caCertPem ? { caCertPem } : {}),
        ...(caKeyPem !== '' ? { caKeyPem } : {}),
      };
      await updateMut.mutateAsync(payload);
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="mtls-upload-modal">
      <div className="w-full max-w-2xl rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xl max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {mode === 'upload' ? 'Upload CA' : `Edit "${provider?.name}"`}
        </h2>
        <form onSubmit={onSubmit} className="mt-4 space-y-4">
          <div>
            <label className={LABEL_CLASS}>Name</label>
            <input
              className={INPUT_CLASS}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required={mode === 'upload'}
              placeholder="Internal corporate CA"
              data-testid="mtls-provider-name"
            />
          </div>
          <div>
            <label className={LABEL_CLASS}>
              CA Bundle (PEM) {mode === 'edit' && <span className="ml-2 text-gray-400">leave empty to keep current</span>}
            </label>
            <textarea
              className={`${INPUT_CLASS} font-mono text-xs`}
              rows={6}
              value={caCertPem}
              onChange={(e) => setCaCertPem(e.target.value)}
              required={mode === 'upload'}
              placeholder={'-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----'}
              data-testid="mtls-ca-cert"
            />
          </div>
          <div>
            <label className={LABEL_CLASS}>
              CA Private Key (PEM) — optional
              {mode === 'edit' && (
                <span className="ml-2 text-gray-400">
                  empty = keep current; type a single space then save to remove
                </span>
              )}
            </label>
            <textarea
              className={`${INPUT_CLASS} font-mono text-xs`}
              rows={6}
              value={caKeyPem}
              onChange={(e) => setCaKeyPem(e.target.value)}
              placeholder={'-----BEGIN PRIVATE KEY-----\n(supply if you want to issue user certs)\n-----END PRIVATE KEY-----'}
              data-testid="mtls-ca-key"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Required only if you plan to mint user certs from this CA. Stored encrypted at rest;
              never returned to the client.
            </p>
          </div>

          {error != null && (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {error instanceof Error ? error.message : String(error)}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="mtls-provider-submit"
            >
              {isPending && <Loader2 size={14} className="animate-spin" />}
              {mode === 'upload' ? 'Create' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Generate CA modal ─────────────────────────────────────────────

function GenerateModal({ clientId, onClose }: { readonly clientId: string; readonly onClose: () => void }) {
  const createMut = useCreateMtlsProvider(clientId);
  const [name, setName] = useState('');
  const [commonName, setCommonName] = useState('');
  const [organization, setOrganization] = useState('');
  const [validityDays, setValidityDays] = useState(1825);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const payload: MtlsProviderInput = {
      source: 'generate',
      name,
      commonName,
      validityDays,
      ...(organization ? { organization } : {}),
    };
    await createMut.mutateAsync(payload);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="mtls-generate-modal">
      <div className="w-full max-w-lg rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <Sparkles size={18} /> Generate New CA
        </h2>
        <p className="mt-1 mb-4 text-sm text-gray-600 dark:text-gray-400">
          Server mints a self-signed CA cert + private key. Both stay encrypted server-side; the
          private key never leaves. Use the &quot;Issue User Cert&quot; action to mint client
          certs against this CA.
        </p>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className={LABEL_CLASS}>Name</label>
            <input className={INPUT_CLASS} value={name} onChange={(e) => setName(e.target.value)} required placeholder="Engineering Team CA" data-testid="mtls-gen-name" />
          </div>
          <div>
            <label className={LABEL_CLASS}>Common Name (CN)</label>
            <input className={INPUT_CLASS} value={commonName} onChange={(e) => setCommonName(e.target.value)} required placeholder="Acme Corp Engineering CA" data-testid="mtls-gen-cn" />
          </div>
          <div>
            <label className={LABEL_CLASS}>Organization (optional)</label>
            <input className={INPUT_CLASS} value={organization} onChange={(e) => setOrganization(e.target.value)} placeholder="Acme Corp" />
          </div>
          <div>
            <label className={LABEL_CLASS}>Validity (days)</label>
            <input type="number" min={1} max={3650} className={INPUT_CLASS} value={validityDays} onChange={(e) => setValidityDays(Number(e.target.value))} required />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Default 1825 (5 years). Capped at 3650 (10 years).</p>
          </div>

          {createMut.error != null && (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {createMut.error instanceof Error ? createMut.error.message : String(createMut.error)}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
              Cancel
            </button>
            <button
              type="submit"
              disabled={createMut.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              data-testid="mtls-gen-submit"
            >
              {createMut.isPending && <Loader2 size={14} className="animate-spin" />}
              Generate
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Issue User Cert modal ────────────────────────────────────────

function IssueCertModal({
  provider,
  clientId,
  onClose,
}: {
  readonly provider: MtlsProviderResponse;
  readonly clientId: string;
  readonly onClose: () => void;
}) {
  const issueMut = useIssueMtlsCert(clientId, provider.id);
  const [commonName, setCommonName] = useState('');
  const [organization, setOrganization] = useState('');
  const [organizationalUnit, setOrganizationalUnit] = useState('');
  const [validityDays, setValidityDays] = useState(365);
  const [issued, setIssued] = useState<MtlsIssueCertResponse | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const result = await issueMut.mutateAsync({
      commonName,
      validityDays,
      ...(organization ? { organization } : {}),
      ...(organizationalUnit ? { organizationalUnit } : {}),
    });
    setIssued(result);
  }

  function copy(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-testid="mtls-issue-modal">
      <div className="w-full max-w-3xl rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 shadow-xl max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
          <FileKey size={18} /> Issue User Cert from &quot;{provider.name}&quot;
        </h2>

        {!issued ? (
          <form onSubmit={onSubmit} className="mt-4 space-y-3">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              The server signs a fresh client cert against this CA. Cert + key are returned to
              your browser ONCE — there is no server-side persistence after this response, so
              save them right away.
            </p>
            <div>
              <label className={LABEL_CLASS}>Common Name (CN)</label>
              <input className={INPUT_CLASS} value={commonName} onChange={(e) => setCommonName(e.target.value)} required placeholder="alice@example.com" data-testid="mtls-issue-cn" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={LABEL_CLASS}>Organization (optional)</label>
                <input className={INPUT_CLASS} value={organization} onChange={(e) => setOrganization(e.target.value)} />
              </div>
              <div>
                <label className={LABEL_CLASS}>Organizational Unit (optional)</label>
                <input className={INPUT_CLASS} value={organizationalUnit} onChange={(e) => setOrganizationalUnit(e.target.value)} />
              </div>
            </div>
            <div>
              <label className={LABEL_CLASS}>Validity (days)</label>
              <input type="number" min={1} max={365} className={INPUT_CLASS} value={validityDays} onChange={(e) => setValidityDays(Number(e.target.value))} required />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Capped at 365 days for user certs.</p>
            </div>

            {issueMut.error != null && (
              <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                {issueMut.error instanceof Error ? issueMut.error.message : String(issueMut.error)}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
                Cancel
              </button>
              <button
                type="submit"
                disabled={issueMut.isPending}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                data-testid="mtls-issue-submit"
              >
                {issueMut.isPending && <Loader2 size={14} className="animate-spin" />}
                Issue Cert
              </button>
            </div>
          </form>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-900 dark:text-amber-200">
              <strong>Save these now.</strong> The cert and private key are not stored on the server and
              cannot be retrieved later. Subject: <code className="font-mono text-xs">{issued.subject}</code> ·
              Expires: {new Date(issued.expiresAt).toLocaleDateString()}
            </div>
            <CertBlock label="User Cert (PEM)" pem={issued.certPem} testid="issued-cert" copied={copied === 'cert'} onCopy={() => copy(issued.certPem, 'cert')} />
            <CertBlock label="User Private Key (PEM)" pem={issued.keyPem} testid="issued-key" copied={copied === 'key'} onCopy={() => copy(issued.keyPem, 'key')} />
            <CertBlock label="CA Cert (PEM, for trust chain)" pem={issued.caCertPem} testid="issued-ca" copied={copied === 'ca'} onCopy={() => copy(issued.caCertPem, 'ca')} />
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CertBlock({ label, pem, testid, copied, onCopy }: { label: string; pem: string; testid: string; copied: boolean; onCopy: () => void }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className={LABEL_CLASS}>{label}</span>
        <button type="button" onClick={onCopy} className="inline-flex items-center gap-1 rounded text-xs text-blue-600 hover:underline dark:text-blue-400">
          {copied ? <CheckCircle size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="font-mono text-[10px] bg-gray-50 dark:bg-gray-900 rounded p-2 max-h-48 overflow-auto text-gray-800 dark:text-gray-200" data-testid={testid}>
        {pem}
      </pre>
    </div>
  );
}

// ─── Delete modal ──────────────────────────────────────────────────

interface DeleteConfirmProps {
  readonly provider: MtlsProviderResponse;
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
          This will permanently remove <strong>{provider.name}</strong>. Issued user certs will continue to work
          (they're cryptographic — the platform can't revoke them) but new ones cannot be issued.
        </p>
        {provider.consumerCount > 0 && (
          <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">
            In use by {provider.consumerCount} ingress(es) — detach them first.
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
