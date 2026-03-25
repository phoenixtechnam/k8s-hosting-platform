import { useState, useEffect, type FormEvent } from 'react';
import { X, Loader2 } from 'lucide-react';
import { useUpdateClient } from '@/hooks/use-clients';
import type { Client } from '@/types/api';

interface EditClientModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly client: Client;
}

export default function EditClientModal({ open, onClose, client }: EditClientModalProps) {
  const [companyName, setCompanyName] = useState('');
  const [companyEmail, setCompanyEmail] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [subscriptionExpiresAt, setSubscriptionExpiresAt] = useState('');

  const updateClient = useUpdateClient(client.id);

  useEffect(() => {
    if (open) {
      setCompanyName(client.companyName ?? client.name ?? '');
      setCompanyEmail(client.companyEmail ?? client.email ?? '');
      setContactEmail(client.contactEmail ?? '');
      setSubscriptionExpiresAt(
        client.subscriptionExpiresAt
          ? new Date(client.subscriptionExpiresAt).toISOString().split('T')[0]
          : '',
      );
      updateClient.reset();
    }
  }, [open, client]);

  const handleClose = () => {
    onClose();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await updateClient.mutateAsync({
        company_name: companyName,
        company_email: companyEmail,
        contact_email: contactEmail || undefined,
        subscription_expires_at: subscriptionExpiresAt
          ? new Date(subscriptionExpiresAt).toISOString()
          : undefined,
      });
      handleClose();
    } catch {
      // error displayed in modal
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-testid="edit-client-modal">
      <div className="fixed inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-gray-900">Edit Client</h2>
          <button
            onClick={handleClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {updateClient.error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600" data-testid="edit-error">
            {updateClient.error instanceof Error ? updateClient.error.message : 'Failed to update client'}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" data-testid="edit-client-form">
          <div>
            <label htmlFor="edit-company-name" className="block text-sm font-medium text-gray-700">
              Company Name *
            </label>
            <input
              id="edit-company-name"
              type="text"
              required
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="Acme Corp"
              data-testid="edit-company-name-input"
            />
          </div>

          <div>
            <label htmlFor="edit-company-email" className="block text-sm font-medium text-gray-700">
              Company Email *
            </label>
            <input
              id="edit-company-email"
              type="email"
              required
              value={companyEmail}
              onChange={(e) => setCompanyEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="admin@acme.com"
              data-testid="edit-company-email-input"
            />
          </div>

          <div>
            <label htmlFor="edit-contact-email" className="block text-sm font-medium text-gray-700">
              Contact Email
            </label>
            <input
              id="edit-contact-email"
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              placeholder="support@acme.com (optional)"
              data-testid="edit-contact-email-input"
            />
          </div>

          <div>
            <label htmlFor="edit-subscription-expires" className="block text-sm font-medium text-gray-700">
              Subscription Expires
            </label>
            <input
              id="edit-subscription-expires"
              type="date"
              value={subscriptionExpiresAt}
              onChange={(e) => setSubscriptionExpiresAt(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              data-testid="edit-subscription-expires-input"
            />
            <p className="mt-1 text-xs text-gray-500">Leave empty for no expiration</p>
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
              disabled={updateClient.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="edit-submit-button"
            >
              {updateClient.isPending && <Loader2 size={14} className="animate-spin" />}
              Save Changes
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
