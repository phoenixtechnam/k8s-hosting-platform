import { useState, type FormEvent } from 'react';
import { X, Loader2 } from 'lucide-react';
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

  const plans = plansData?.data ?? [];
  const regions = regionsData?.data ?? [];

  const resetForm = () => {
    setCompanyName('');
    setCompanyEmail('');
    setContactEmail('');
    setPlanId('');
    setRegionId('');
    createClient.reset();
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await createClient.mutateAsync({
        company_name: companyName,
        company_email: companyEmail,
        contact_email: contactEmail || undefined,
        plan_id: planId,
        region_id: regionId,
      });
      handleClose();
    } catch {
      // error displayed in modal
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-testid="create-client-modal">
      <div className="fixed inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-gray-900">Create Client</h2>
          <button
            onClick={handleClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {createClient.error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600" data-testid="create-error">
            {createClient.error instanceof Error ? createClient.error.message : 'Failed to create client'}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" data-testid="create-client-form">
          <div>
            <label htmlFor="company-name" className="block text-sm font-medium text-gray-700">
              Company Name *
            </label>
            <input
              id="company-name"
              type="text"
              required
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="Acme Corp"
              data-testid="company-name-input"
            />
          </div>

          <div>
            <label htmlFor="company-email" className="block text-sm font-medium text-gray-700">
              Company Email *
            </label>
            <input
              id="company-email"
              type="email"
              required
              value={companyEmail}
              onChange={(e) => setCompanyEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="admin@acme.com"
              data-testid="company-email-input"
            />
          </div>

          <div>
            <label htmlFor="contact-email" className="block text-sm font-medium text-gray-700">
              Contact Email
            </label>
            <input
              id="contact-email"
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="support@acme.com (optional)"
              data-testid="contact-email-input"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="plan" className="block text-sm font-medium text-gray-700">
                Plan *
              </label>
              <select
                id="plan"
                required
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
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
              <label htmlFor="region" className="block text-sm font-medium text-gray-700">
                Region *
              </label>
              <select
                id="region"
                required
                value={regionId}
                onChange={(e) => setRegionId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
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
              className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
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
        </form>
      </div>
    </div>
  );
}
