import { useState, type FormEvent } from 'react';
import { X, Loader2, Copy, CheckCircle, KeyRound } from 'lucide-react';
import { useCreateClient } from '@/hooks/use-clients';
import { usePlans, useRegions } from '@/hooks/use-plans';

interface CreateClientModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export default function CreateClientModal({ open, onClose }: CreateClientModalProps) {
  const [companyName, setCompanyName] = useState('');
  const [companyEmail, setCompanyEmail] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [planId, setPlanId] = useState('');
  const [regionId, setRegionId] = useState('');

  const { data: plansData } = usePlans();
  const { data: regionsData } = useRegions();
  const createClient = useCreateClient();
  const [createdCredentials, setCreatedCredentials] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const plans = plansData?.data ?? [];
  const regions = regionsData?.data ?? [];

  const resetForm = () => {
    setCompanyName('');
    setCompanyEmail('');
    setContactEmail('');
    setPlanId('');
    setRegionId('');
    setCreatedCredentials(null);
    setCopied(false);
    createClient.reset();
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const result = await createClient.mutateAsync({
        company_name: companyName,
        company_email: companyEmail,
        contact_email: contactEmail || undefined,
        plan_id: planId,
        region_id: regionId,
      });
      // Show generated credentials
      const clientUser = (result as { data: { clientUser?: { email: string; generatedPassword: string } } }).data?.clientUser;
      if (clientUser?.generatedPassword) {
        setCreatedCredentials({ email: clientUser.email, password: clientUser.generatedPassword });
      } else {
        handleClose();
      }
    } catch {
      // error displayed in modal
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-testid="create-client-modal">
      <div className="fixed inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative w-full max-w-lg rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Create Client</h2>
          <button
            onClick={handleClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-400"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {createdCredentials && (
          <div className="space-y-4" data-testid="client-credentials">
            <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
              <CheckCircle size={20} />
              <span className="text-sm font-medium">Client created successfully!</span>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/20 p-4">
              <div className="flex items-center gap-2 mb-3">
                <KeyRound size={16} className="text-amber-600 dark:text-amber-400" />
                <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">Client Portal Credentials</span>
              </div>
              <p className="text-xs text-amber-700 dark:text-amber-400 mb-3">Save these credentials now. The password will not be shown again.</p>
              <div className="space-y-2 text-sm">
                <div><span className="text-gray-500">Email:</span> <span className="font-mono font-medium text-gray-900 dark:text-gray-100">{createdCredentials.email}</span></div>
                <div><span className="text-gray-500">Password:</span> <span className="font-mono font-medium text-gray-900 dark:text-gray-100">{createdCredentials.password}</span></div>
              </div>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(`Email: ${createdCredentials.email}\nPassword: ${createdCredentials.password}`);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white dark:bg-gray-800 px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/20"
                data-testid="copy-credentials"
              >
                {copied ? <CheckCircle size={12} /> : <Copy size={12} />}
                {copied ? 'Copied!' : 'Copy Credentials'}
              </button>
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={handleClose} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600" data-testid="close-credentials">Done</button>
            </div>
          </div>
        )}

        {!createdCredentials && createClient.error && (
          <div className="mb-4 rounded-lg bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-600 dark:text-red-400" data-testid="create-error">
            {createClient.error instanceof Error ? createClient.error.message : 'Failed to create client'}
          </div>
        )}

        {!createdCredentials && <form onSubmit={handleSubmit} className="space-y-4" data-testid="create-client-form">
          <div>
            <label htmlFor="company-name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Company Name *
            </label>
            <input
              id="company-name"
              type="text"
              required
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="Acme Corp"
              data-testid="company-name-input"
            />
          </div>

          <div>
            <label htmlFor="company-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Company Email *
            </label>
            <input
              id="company-email"
              type="email"
              required
              value={companyEmail}
              onChange={(e) => setCompanyEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="admin@acme.com"
              data-testid="company-email-input"
            />
          </div>

          <div>
            <label htmlFor="contact-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Contact Email
            </label>
            <input
              id="contact-email"
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="support@acme.com (optional)"
              data-testid="contact-email-input"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="plan" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Plan *
              </label>
              <select
                id="plan"
                required
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                data-testid="plan-select"
              >
                <option value="">Select plan...</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (${p.monthlyPriceUsd}/mo)
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="region" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Region *
              </label>
              <select
                id="region"
                required
                value={regionId}
                onChange={(e) => setRegionId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                data-testid="region-select"
              >
                <option value="">Select region...</option>
                {regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

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
              disabled={createClient.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="submit-button"
            >
              {createClient.isPending && <Loader2 size={14} className="animate-spin" />}
              Create Client
            </button>
          </div>
        </form>}
      </div>
    </div>
  );
}
