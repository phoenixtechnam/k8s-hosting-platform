import { useState, type FormEvent } from 'react';
import { X, Loader2 } from 'lucide-react';
import { useCreateDomain } from '@/hooks/use-domains';
import { useDeployments } from '@/hooks/use-deployments';
import SearchableClientSelect from '@/components/ui/SearchableClientSelect';

interface CreateDomainModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly clientId?: string | null;
}

export default function CreateDomainModal({ open, onClose, clientId }: CreateDomainModalProps) {
  const [domainName, setDomainName] = useState('');
  const [dnsMode, setDnsMode] = useState<'cname' | 'primary' | 'secondary'>('cname');
  const [deploymentId, setDeploymentId] = useState<string>('');
  const [internalClientId, setInternalClientId] = useState<string | null>(clientId ?? null);

  const effectiveClientId = clientId ?? internalClientId;

  const createDomain = useCreateDomain(effectiveClientId ?? undefined);
  const { data: deploymentsResponse } = useDeployments(effectiveClientId ?? undefined);
  const deployments = deploymentsResponse?.data ?? [];

  const resetForm = () => {
    setDomainName('');
    setDnsMode('cname');
    setDeploymentId('');
    if (!clientId) {
      setInternalClientId(null);
    }
    createDomain.reset();
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!effectiveClientId) return;
    try {
      await createDomain.mutateAsync({
        domain_name: domainName,
        dns_mode: dnsMode,
        ...(deploymentId ? { deployment_id: deploymentId } : {}),
      });
      handleClose();
    } catch {
      // error displayed in modal
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-testid="create-domain-modal">
      <div className="fixed inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative w-full max-w-lg rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Add Domain</h2>
          <button
            onClick={handleClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-400"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {createDomain.error && (
          <div className="mb-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-600 dark:text-red-400" data-testid="create-domain-error">
            {createDomain.error instanceof Error ? createDomain.error.message : 'Failed to create domain'}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" data-testid="create-domain-form">
          {!clientId && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Client *
              </label>
              <SearchableClientSelect
                selectedClientId={internalClientId}
                onSelect={setInternalClientId}
                placeholder="Search for a client..."
              />
            </div>
          )}

          <div>
            <label htmlFor="domain-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Domain Name *
            </label>
            <input
              id="domain-name"
              type="text"
              required
              value={domainName}
              onChange={(e) => setDomainName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="example.com"
              data-testid="domain-name-input"
            />
          </div>

          <div>
            <label htmlFor="dns-mode" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              DNS Mode *
            </label>
            <select
              id="dns-mode"
              required
              value={dnsMode}
              onChange={(e) => setDnsMode(e.target.value as 'cname' | 'primary' | 'secondary')}
              className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              data-testid="dns-mode-select"
            >
              <option value="cname">CNAME</option>
              <option value="primary">Primary</option>
              <option value="secondary">Secondary</option>
            </select>
          </div>

          {effectiveClientId && (
            <div>
              <label htmlFor="deployment-id" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Route to Deployment
              </label>
              {deployments.length > 0 ? (
                <>
                  <select
                    id="deployment-id"
                    value={deploymentId}
                    onChange={(e) => setDeploymentId(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    data-testid="deployment-select"
                  >
                    <option value="">None (assign later)</option>
                    {deployments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} ({d.status})
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    Links this domain to a deployment for Ingress routing. Creates the Ingress + TLS certificate automatically.
                  </p>
                </>
              ) : (
                <p className="mt-1 text-sm text-gray-400 dark:text-gray-500 italic" data-testid="no-deployments-message">
                  No deployments active yet. You can assign a deployment later from the Routing tab.
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createDomain.isPending || !effectiveClientId}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="submit-domain-button"
            >
              {createDomain.isPending && <Loader2 size={14} className="animate-spin" />}
              Add Domain
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
