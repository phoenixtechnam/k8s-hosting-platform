import { useState, type FormEvent } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit, Pause, Play, Trash2, Loader2 } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import EditClientModal from '@/components/EditClientModal';
import DeleteConfirmDialog from '@/components/DeleteConfirmDialog';
import { useClient, useDeleteClient, useUpdateClient } from '@/hooks/use-clients';

export default function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useClient(id);
  const client = data?.data;

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const deleteClient = useDeleteClient();
  const updateClient = useUpdateClient(id ?? '');

  const handleDelete = async () => {
    if (!id) return;
    try {
      await deleteClient.mutateAsync(id);
      navigate('/clients');
    } catch {
      // error stays visible in dialog
    }
  };

  const handleSuspend = async () => {
    if (!id) return;
    try {
      await updateClient.mutateAsync({ status: 'suspended' });
    } catch {
      // silently handled — status badge will reflect current state
    }
  };

  const handleReactivate = async () => {
    if (!id) return;
    try {
      await updateClient.mutateAsync({ status: 'active' });
    } catch {
      // silently handled — status badge will reflect current state
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={32} className="animate-spin text-gray-400" />
      </div>
    );
  }

  if (error || !client) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="text-lg text-gray-500">
          {error instanceof Error ? error.message : 'Client not found'}
        </p>
        <Link to="/clients" className="mt-4 text-sm text-brand-500 hover:text-brand-600">
          Back to clients
        </Link>
      </div>
    );
  }

  const name = client.companyName ?? client.name ?? 'Unknown';
  const email = client.companyEmail ?? client.email ?? '';
  const created = client.createdAt ?? client.created_at;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          to="/clients"
          className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          aria-label="Back to clients"
        >
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900">{name}</h1>
          <p className="text-sm text-gray-500">{email}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setEditOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50"
            data-testid="edit-button"
          >
            <Edit size={14} />
            <span className="hidden sm:inline">Edit</span>
          </button>
          {client.status === 'suspended' || client.status === 'cancelled' ? (
            <button
              onClick={handleReactivate}
              disabled={updateClient.isPending}
              className="inline-flex items-center gap-2 rounded-lg border border-green-200 bg-white px-4 py-2 text-sm font-medium text-green-600 shadow-sm hover:bg-green-50 disabled:opacity-50"
              data-testid="reactivate-button"
            >
              {updateClient.isPending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              <span className="hidden sm:inline">Reactivate</span>
            </button>
          ) : (
            <button
              onClick={handleSuspend}
              disabled={updateClient.isPending}
              className="inline-flex items-center gap-2 rounded-lg border border-orange-200 bg-white px-4 py-2 text-sm font-medium text-orange-600 shadow-sm hover:bg-orange-50 disabled:opacity-50"
              data-testid="suspend-button"
            >
              {updateClient.isPending ? <Loader2 size={14} className="animate-spin" /> : <Pause size={14} />}
              <span className="hidden sm:inline">Suspend</span>
            </button>
          )}
          <button
            onClick={() => setDeleteOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-600 shadow-sm hover:bg-red-50"
            data-testid="delete-button"
          >
            <Trash2 size={14} />
            <span className="hidden sm:inline">Delete</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm lg:col-span-2">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">Account Information</h2>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase text-gray-500">Status</dt>
              <dd className="mt-1">
                <StatusBadge status={client.status} />
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-gray-500">Created</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {created ? new Date(created).toLocaleDateString() : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-gray-500">Namespace</dt>
              <dd className="mt-1 font-mono text-xs text-gray-700">
                {client.kubernetesNamespace ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-gray-500">Subscription Expires</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {client.subscriptionExpiresAt
                  ? new Date(client.subscriptionExpiresAt).toLocaleDateString()
                  : 'Not set'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-gray-500">Contact Email</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {client.contactEmail ?? 'Not set'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-gray-500">Created By</dt>
              <dd className="mt-1 text-sm text-gray-900">
                {client.createdBy ?? '—'}
              </dd>
            </div>
          </dl>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-gray-900">IDs</h2>
          <div className="space-y-3 text-sm">
            <div>
              <span className="text-xs font-medium uppercase text-gray-500">Client ID</span>
              <p className="mt-0.5 break-all font-mono text-xs text-gray-700">{client.id}</p>
            </div>
            <div>
              <span className="text-xs font-medium uppercase text-gray-500">Plan ID</span>
              <p className="mt-0.5 break-all font-mono text-xs text-gray-700">{client.planId ?? '—'}</p>
            </div>
            <div>
              <span className="text-xs font-medium uppercase text-gray-500">Region ID</span>
              <p className="mt-0.5 break-all font-mono text-xs text-gray-700">{client.regionId ?? '—'}</p>
            </div>
          </div>
        </div>
      </div>

      <EditClientModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        client={client}
      />

      <DeleteConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
        clientName={name}
        isPending={deleteClient.isPending}
      />
    </div>
  );
}
