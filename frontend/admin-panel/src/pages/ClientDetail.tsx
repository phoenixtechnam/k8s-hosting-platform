import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit, Pause, Play, Trash2, Loader2 } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import EditClientModal from '@/components/EditClientModal';
import DeleteConfirmDialog from '@/components/DeleteConfirmDialog';
import { useClient, useDeleteClient, useUpdateClient } from '@/hooks/use-clients';
import { useDomains } from '@/hooks/use-domains';
import { useDatabases, useBackups } from '@/hooks/use-databases';
import { useWorkloads } from '@/hooks/use-workloads';
import type { Domain, PaginatedResponse, Workload } from '@/types/api';
import type { Database, Backup } from '@/hooks/use-databases';

type TabKey = 'domains' | 'databases' | 'workloads' | 'backups';

export default function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useClient(id);
  const client = data?.data;

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('domains');

  const domainsQuery = useDomains(id);
  const databasesQuery = useDatabases(id);
  const workloadsQuery = useWorkloads(id);
  const backupsQuery = useBackups(id);

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

  const name = client.companyName ?? 'Unknown';
  const email = client.companyEmail ?? '';
  const created = client.createdAt;

  const domainCount = domainsQuery.data?.data.length ?? 0;
  const databaseCount = databasesQuery.data?.data.length ?? 0;
  const workloadCount = workloadsQuery.data?.data.length ?? 0;
  const backupCount = backupsQuery.data?.data.length ?? 0;

  const tabs: readonly { readonly key: TabKey; readonly label: string; readonly count: number }[] = [
    { key: 'domains', label: 'Domains', count: domainCount },
    { key: 'databases', label: 'Databases', count: databaseCount },
    { key: 'workloads', label: 'Workloads', count: workloadCount },
    { key: 'backups', label: 'Backups', count: backupCount },
  ];

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

      {/* Resource tabs */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200" data-testid="resource-tabs">
          <nav className="-mb-px flex gap-6 px-5" aria-label="Resource tabs">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                data-testid={`tab-${tab.key}`}
                className={`whitespace-nowrap border-b-2 py-3 text-sm font-medium transition-colors ${
                  activeTab === tab.key
                    ? 'border-brand-500 text-brand-600'
                    : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
                }`}
              >
                {tab.label} ({tab.count})
              </button>
            ))}
          </nav>
        </div>

        <div className="p-5">
          {activeTab === 'domains' && <DomainsTab data={domainsQuery.data} isLoading={domainsQuery.isLoading} error={domainsQuery.error} />}
          {activeTab === 'databases' && <DatabasesTab data={databasesQuery.data} isLoading={databasesQuery.isLoading} error={databasesQuery.error} />}
          {activeTab === 'workloads' && <WorkloadsTab data={workloadsQuery.data} isLoading={workloadsQuery.isLoading} error={workloadsQuery.error} />}
          {activeTab === 'backups' && <BackupsTab data={backupsQuery.data} isLoading={backupsQuery.isLoading} error={backupsQuery.error} />}
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

interface TabContentProps<T> {
  readonly data: PaginatedResponse<T> | undefined;
  readonly isLoading: boolean;
  readonly error: Error | null;
}

function TabLoading() {
  return (
    <div className="flex items-center justify-center py-10" data-testid="tab-loading">
      <Loader2 size={24} className="animate-spin text-gray-400" />
    </div>
  );
}

function TabError({ message }: { readonly message: string }) {
  return (
    <p className="py-6 text-center text-sm text-red-500" data-testid="tab-error">
      {message}
    </p>
  );
}

function TabEmpty({ resource }: { readonly resource: string }) {
  return (
    <p className="py-6 text-center text-sm text-gray-500" data-testid="tab-empty">
      No {resource} found for this client.
    </p>
  );
}

function DomainsTab({ data, isLoading, error }: TabContentProps<Domain>) {
  if (isLoading) return <TabLoading />;
  if (error) return <TabError message="Failed to load domains." />;
  const items = data?.data ?? [];
  if (items.length === 0) return <TabEmpty resource="domains" />;

  return (
    <table className="w-full text-left text-sm" data-testid="domains-table">
      <thead>
        <tr className="border-b border-gray-100 text-xs font-medium uppercase text-gray-500">
          <th className="pb-2">Domain</th>
          <th className="pb-2">DNS Mode</th>
          <th className="pb-2">SSL</th>
          <th className="pb-2">Status</th>
          <th className="pb-2">Created</th>
        </tr>
      </thead>
      <tbody>
        {items.map((d) => (
          <tr key={d.id} className="border-b border-gray-50">
            <td className="py-2 font-medium text-gray-900">{d.domainName}</td>
            <td className="py-2 text-gray-600">{d.dnsMode}</td>
            <td className="py-2 text-gray-600">{d.sslAutoRenew ? 'Auto' : 'Manual'}</td>
            <td className="py-2"><StatusBadge status={d.status as 'active' | 'pending' | 'error'} /></td>
            <td className="py-2 text-gray-500">{new Date(d.createdAt).toLocaleDateString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DatabasesTab({ data, isLoading, error }: TabContentProps<Database>) {
  if (isLoading) return <TabLoading />;
  if (error) return <TabError message="Failed to load databases." />;
  const items = data?.data ?? [];
  if (items.length === 0) return <TabEmpty resource="databases" />;

  return (
    <table className="w-full text-left text-sm" data-testid="databases-table">
      <thead>
        <tr className="border-b border-gray-100 text-xs font-medium uppercase text-gray-500">
          <th className="pb-2">Name</th>
          <th className="pb-2">Type</th>
          <th className="pb-2">Size</th>
          <th className="pb-2">Status</th>
          <th className="pb-2">Created</th>
        </tr>
      </thead>
      <tbody>
        {items.map((db) => (
          <tr key={db.id} className="border-b border-gray-50">
            <td className="py-2 font-medium text-gray-900">{db.name}</td>
            <td className="py-2 text-gray-600">{db.type}</td>
            <td className="py-2 text-gray-600">{formatBytes(db.sizeBytes)}</td>
            <td className="py-2"><StatusBadge status={db.status} /></td>
            <td className="py-2 text-gray-500">{new Date(db.createdAt).toLocaleDateString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WorkloadsTab({ data, isLoading, error }: TabContentProps<Workload>) {
  if (isLoading) return <TabLoading />;
  if (error) return <TabError message="Failed to load workloads." />;
  const items = data?.data ?? [];
  if (items.length === 0) return <TabEmpty resource="workloads" />;

  return (
    <table className="w-full text-left text-sm" data-testid="workloads-table">
      <thead>
        <tr className="border-b border-gray-100 text-xs font-medium uppercase text-gray-500">
          <th className="pb-2">Name</th>
          <th className="pb-2">Replicas</th>
          <th className="pb-2">CPU</th>
          <th className="pb-2">Memory</th>
          <th className="pb-2">Status</th>
          <th className="pb-2">Created</th>
        </tr>
      </thead>
      <tbody>
        {items.map((w) => (
          <tr key={w.id} className="border-b border-gray-50">
            <td className="py-2 font-medium text-gray-900">{w.name}</td>
            <td className="py-2 text-gray-600">{w.replicas}</td>
            <td className="py-2 text-gray-600">{w.cpu}</td>
            <td className="py-2 text-gray-600">{w.memory}</td>
            <td className="py-2"><StatusBadge status={w.status} /></td>
            <td className="py-2 text-gray-500">{new Date(w.createdAt).toLocaleDateString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BackupsTab({ data, isLoading, error }: TabContentProps<Backup>) {
  if (isLoading) return <TabLoading />;
  if (error) return <TabError message="Failed to load backups." />;
  const items = data?.data ?? [];
  if (items.length === 0) return <TabEmpty resource="backups" />;

  return (
    <table className="w-full text-left text-sm" data-testid="backups-table">
      <thead>
        <tr className="border-b border-gray-100 text-xs font-medium uppercase text-gray-500">
          <th className="pb-2">Resource</th>
          <th className="pb-2">Type</th>
          <th className="pb-2">Size</th>
          <th className="pb-2">Created</th>
          <th className="pb-2">Expires</th>
        </tr>
      </thead>
      <tbody>
        {items.map((b) => (
          <tr key={b.id} className="border-b border-gray-50">
            <td className="py-2 font-medium text-gray-900">{b.resource}</td>
            <td className="py-2 text-gray-600">{b.type}</td>
            <td className="py-2 text-gray-600">{formatBytes(b.sizeBytes)}</td>
            <td className="py-2 text-gray-500">{new Date(b.createdAt).toLocaleDateString()}</td>
            <td className="py-2 text-gray-500">{new Date(b.expiresAt).toLocaleDateString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(1)} ${units[i]}`;
}
