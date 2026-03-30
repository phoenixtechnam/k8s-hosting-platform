import { useState, type FormEvent } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Edit, Pause, Play, Trash2, Loader2, CreditCard, Save, UserCheck, Cpu, ToggleLeft, ToggleRight, Rocket } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import EditClientModal from '@/components/EditClientModal';
import DeleteConfirmDialog from '@/components/DeleteConfirmDialog';
import { useClient, useDeleteClient, useUpdateClient } from '@/hooks/use-clients';
import { useDomains } from '@/hooks/use-domains';
import { useBackups } from '@/hooks/use-backups';
import { useWorkloads } from '@/hooks/use-workloads';
import { useSubscription, useUpdateSubscription } from '@/hooks/use-subscription';
import { useImpersonate } from '@/hooks/use-impersonate';
import { usePlans } from '@/hooks/use-plans';
import { useEmailDomains, useMailboxes } from '@/hooks/use-email';
import type { Domain, PaginatedResponse, Workload } from '@/types/api';
import type { Backup } from '@/hooks/use-backups';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';
import { useTriggerProvisioning } from '@/hooks/use-provisioning';
import ProvisioningProgressModal from '@/components/ProvisioningProgressModal';

type TabKey = 'domains' | 'applications' | 'workloads' | 'email' | 'backups';

export default function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useClient(id);
  const client = data?.data;

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('domains');

  const domainsQuery = useDomains(id);
  const workloadsQuery = useWorkloads(id);
  const backupsQuery = useBackups(id);
  const subscriptionQuery = useSubscription(id);
  const emailDomainsQuery = useEmailDomains(id);
  const mailboxesQuery = useMailboxes(id);

  const [provisioningOpen, setProvisioningOpen] = useState(false);

  const deleteClient = useDeleteClient();
  const updateClient = useUpdateClient(id ?? '');
  const impersonate = useImpersonate();
  const triggerProvision = useTriggerProvisioning();

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
        <p className="text-lg text-gray-500 dark:text-gray-400">
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
  const workloadCount = workloadsQuery.data?.data.length ?? 0;
  const backupCount = backupsQuery.data?.data.length ?? 0;
  const emailDomainCount = emailDomainsQuery.data?.data.length ?? 0;

  const tabs: readonly { readonly key: TabKey; readonly label: string; readonly count: number }[] = [
    { key: 'domains', label: 'Domains', count: domainCount },
    { key: 'applications', label: 'Applications', count: 0 },
    { key: 'workloads', label: 'Workloads', count: workloadCount },
    { key: 'email', label: 'Email', count: emailDomainCount },
    { key: 'backups', label: 'Backups', count: backupCount },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link
          to="/clients"
          className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-400"
          aria-label="Back to clients"
        >
          <ArrowLeft size={20} />
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{name}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">{email}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={async () => {
              if (!id) return;
              try {
                const res = await impersonate.mutateAsync(id);
                const data = res.data;
                const clientPanelUrl = import.meta.env.VITE_CLIENT_PANEL_URL ?? 'http://localhost:5174';
                const userJson = encodeURIComponent(JSON.stringify(data.user));
                window.open(`${clientPanelUrl}/login?token=${data.token}&user=${userJson}`, '_blank');
              } catch { /* error shown via impersonate.error */ }
            }}
            disabled={impersonate.isPending}
            className="inline-flex items-center gap-2 rounded-lg border border-brand-200 dark:border-brand-800 bg-brand-50 dark:bg-brand-900/20 px-4 py-2 text-sm font-medium text-brand-700 dark:text-brand-300 shadow-sm hover:bg-brand-100 dark:hover:bg-brand-900/20 disabled:opacity-50"
            data-testid="impersonate-button"
          >
            {impersonate.isPending ? <Loader2 size={14} className="animate-spin" /> : <UserCheck size={14} />}
            <span className="hidden sm:inline">Login as Client</span>
          </button>
          {(client as Record<string, unknown>).provisioningStatus === 'unprovisioned' || (client as Record<string, unknown>).provisioningStatus === 'failed' ? (
            <button
              onClick={async () => {
                if (!id) return;
                try {
                  await triggerProvision.mutateAsync({ clientId: id });
                  setProvisioningOpen(true);
                } catch { /* error shown via mutation state */ }
              }}
              disabled={triggerProvision.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:opacity-50"
              data-testid="provision-button"
            >
              {triggerProvision.isPending ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
              <span className="hidden sm:inline">Provision</span>
            </button>
          ) : (client as Record<string, unknown>).provisioningStatus === 'provisioning' ? (
            <button
              onClick={() => setProvisioningOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-50 dark:bg-brand-900/30 px-4 py-2 text-sm font-medium text-brand-700 dark:text-brand-300 shadow-sm hover:bg-brand-100 dark:hover:bg-brand-900/50"
              data-testid="provision-status-button"
            >
              <Loader2 size={14} className="animate-spin" />
              <span className="hidden sm:inline">Provisioning...</span>
            </button>
          ) : null}
          <button
            onClick={() => setEditOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-700/50"
            data-testid="edit-button"
          >
            <Edit size={14} />
            <span className="hidden sm:inline">Edit</span>
          </button>
          {client.status === 'suspended' || client.status === 'cancelled' ? (
            <button
              onClick={handleReactivate}
              disabled={updateClient.isPending}
              className="inline-flex items-center gap-2 rounded-lg border border-green-200 dark:border-green-800 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-green-600 dark:text-green-400 shadow-sm hover:bg-green-50 dark:hover:bg-green-900/20 disabled:opacity-50"
              data-testid="reactivate-button"
            >
              {updateClient.isPending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              <span className="hidden sm:inline">Reactivate</span>
            </button>
          ) : (
            <button
              onClick={handleSuspend}
              disabled={updateClient.isPending}
              className="inline-flex items-center gap-2 rounded-lg border border-orange-200 dark:border-orange-800 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-orange-600 dark:text-orange-400 shadow-sm hover:bg-orange-50 dark:hover:bg-orange-900/20 disabled:opacity-50"
              data-testid="suspend-button"
            >
              {updateClient.isPending ? <Loader2 size={14} className="animate-spin" /> : <Pause size={14} />}
              <span className="hidden sm:inline">Suspend</span>
            </button>
          )}
          <button
            onClick={() => setDeleteOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-red-600 dark:text-red-400 shadow-sm hover:bg-red-50 dark:hover:bg-red-900/20"
            data-testid="delete-button"
          >
            <Trash2 size={14} />
            <span className="hidden sm:inline">Delete</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm lg:col-span-2">
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">Account Information</h2>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Status</dt>
              <dd className="mt-1">
                <StatusBadge status={client.status} />
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">K8s Status</dt>
              <dd className="mt-1">
                <ProvisioningStatusBadge status={((client as Record<string, unknown>).provisioningStatus as string) ?? 'unprovisioned'} />
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Created</dt>
              <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                {created ? new Date(created).toLocaleDateString() : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Namespace</dt>
              <dd className="mt-1 font-mono text-xs text-gray-700 dark:text-gray-300">
                {client.kubernetesNamespace ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Contact Email</dt>
              <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                {client.contactEmail ?? 'Not set'}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Created By</dt>
              <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                {client.createdBy ?? '—'}
              </dd>
            </div>
          </dl>
        </div>

        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">IDs</h2>
          <div className="space-y-3 text-sm">
            <div>
              <span className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Client ID</span>
              <p className="mt-0.5 break-all font-mono text-xs text-gray-700 dark:text-gray-300">{client.id}</p>
            </div>
            <div>
              <span className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Plan ID</span>
              <p className="mt-0.5 break-all font-mono text-xs text-gray-700 dark:text-gray-300">{client.planId ?? '—'}</p>
            </div>
            <div>
              <span className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Region ID</span>
              <p className="mt-0.5 break-all font-mono text-xs text-gray-700 dark:text-gray-300">{client.regionId ?? '—'}</p>
            </div>
          </div>
        </div>
      </div>

      <SubscriptionCard clientId={id!} data={subscriptionQuery.data?.data} isLoading={subscriptionQuery.isLoading} />

      <ResourceLimitsCard client={client} clientId={id!} />

      {/* Resource tabs */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        <div className="border-b border-gray-200 dark:border-gray-700" data-testid="resource-tabs">
          <nav className="-mb-px flex gap-6 px-5" aria-label="Resource tabs">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                data-testid={`tab-${tab.key}`}
                className={`whitespace-nowrap border-b-2 py-3 text-sm font-medium transition-colors ${
                  activeTab === tab.key
                    ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                    : 'border-transparent text-gray-500 hover:border-gray-300 dark:hover:border-gray-600 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                {tab.label} ({tab.count})
              </button>
            ))}
          </nav>
        </div>

        <div className="p-5">
          {activeTab === 'domains' && <DomainsTab data={domainsQuery.data} isLoading={domainsQuery.isLoading} error={domainsQuery.error} />}
          {activeTab === 'applications' && <ApplicationsTab />}
          {activeTab === 'workloads' && <WorkloadsTab data={workloadsQuery.data} isLoading={workloadsQuery.isLoading} error={workloadsQuery.error} />}
          {activeTab === 'email' && <EmailTab emailDomains={emailDomainsQuery.data?.data} mailboxes={mailboxesQuery.data?.data} isLoading={emailDomainsQuery.isLoading || mailboxesQuery.isLoading} error={emailDomainsQuery.error || mailboxesQuery.error} />}
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

      {provisioningOpen && id && (
        <ProvisioningProgressModal
          clientId={id}
          clientName={name}
          onClose={() => setProvisioningOpen(false)}
        />
      )}
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
    <p className="py-6 text-center text-sm text-red-500 dark:text-red-400" data-testid="tab-error">
      {message}
    </p>
  );
}

function TabEmpty({ resource }: { readonly resource: string }) {
  return (
    <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400" data-testid="tab-empty">
      No {resource} found for this client.
    </p>
  );
}

function DomainsTab({ data, isLoading, error }: TabContentProps<Domain>) {
  if (isLoading) return <TabLoading />;
  if (error) return <TabError message="Failed to load domains." />;
  const items = data?.data ?? [];
  const { sortedData: sortedItems, sortKey, sortDirection, onSort } = useSortable(items, 'domainName');
  if (items.length === 0) return <TabEmpty resource="domains" />;

  return (
    <table className="w-full text-left text-sm" data-testid="domains-table">
      <thead>
        <tr className="border-b border-gray-100 dark:border-gray-700 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
          <SortableHeader label="Domain" sortKey="domainName" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="DNS Mode" sortKey="dnsMode" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="SSL" sortKey="sslAutoRenew" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Status" sortKey="status" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Created" sortKey="createdAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
        </tr>
      </thead>
      <tbody>
        {sortedItems.map((d) => (
          <tr key={d.id} className="border-b border-gray-50 dark:border-gray-700">
            <td className="py-2 font-medium text-gray-900 dark:text-gray-100">{d.domainName}</td>
            <td className="py-2 text-gray-600 dark:text-gray-400">{d.dnsMode}</td>
            <td className="py-2 text-gray-600 dark:text-gray-400">{d.sslAutoRenew ? 'Auto' : 'Manual'}</td>
            <td className="py-2"><StatusBadge status={d.status as 'active' | 'pending' | 'error'} /></td>
            <td className="py-2 text-gray-500 dark:text-gray-400">{new Date(d.createdAt).toLocaleDateString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ApplicationsTab() {
  return (
    <div className="py-10 text-center" data-testid="applications-tab">
      <p className="text-sm text-gray-500 dark:text-gray-400">Application management coming soon.</p>
    </div>
  );
}

interface EmailTabProps {
  readonly emailDomains: readonly { readonly id: string; readonly domainName: string; readonly enabled: number; readonly mailboxCount?: number; readonly createdAt: string }[] | undefined;
  readonly mailboxes: readonly { readonly id: string; readonly fullAddress: string; readonly displayName: string | null; readonly status: string; readonly quotaMb: number; readonly usedMb: number; readonly createdAt: string }[] | undefined;
  readonly isLoading: boolean;
  readonly error: Error | null;
}

function EmailTab({ emailDomains, mailboxes, isLoading, error }: EmailTabProps) {
  if (isLoading) return <TabLoading />;
  if (error) return <TabError message="Failed to load email data." />;

  const domains = emailDomains ?? [];
  const mboxes = mailboxes ?? [];
  const { sortedData: sortedDomains, sortKey: domainSortKey, sortDirection: domainSortDir, onSort: onDomainSort } = useSortable(domains, 'domainName');
  const { sortedData: sortedMailboxes, sortKey: mboxSortKey, sortDirection: mboxSortDir, onSort: onMboxSort } = useSortable(mboxes, 'fullAddress');

  if (domains.length === 0) {
    return (
      <div className="py-10 text-center" data-testid="email-tab-empty">
        <p className="text-sm text-gray-500 dark:text-gray-400">Email not enabled for this client.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="email-tab">
      <div>
        <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">Email Domains</h3>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-700 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
              <SortableHeader label="Domain" sortKey="domainName" currentKey={domainSortKey} direction={domainSortDir} onSort={onDomainSort} />
              <SortableHeader label="Mailboxes" sortKey="mailboxCount" currentKey={domainSortKey} direction={domainSortDir} onSort={onDomainSort} />
              <SortableHeader label="Status" sortKey="enabled" currentKey={domainSortKey} direction={domainSortDir} onSort={onDomainSort} />
              <SortableHeader label="Created" sortKey="createdAt" currentKey={domainSortKey} direction={domainSortDir} onSort={onDomainSort} />
            </tr>
          </thead>
          <tbody>
            {sortedDomains.map((d) => (
              <tr key={d.id} className="border-b border-gray-50 dark:border-gray-700">
                <td className="py-2 font-medium text-gray-900 dark:text-gray-100">{d.domainName}</td>
                <td className="py-2 text-gray-600 dark:text-gray-400">{d.mailboxCount ?? 0}</td>
                <td className="py-2">
                  <StatusBadge status={d.enabled ? 'active' : 'suspended'} />
                </td>
                <td className="py-2 text-gray-500 dark:text-gray-400">{new Date(d.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {mboxes.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">Mailboxes</h3>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-700 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                <SortableHeader label="Address" sortKey="fullAddress" currentKey={mboxSortKey} direction={mboxSortDir} onSort={onMboxSort} />
                <SortableHeader label="Display Name" sortKey="displayName" currentKey={mboxSortKey} direction={mboxSortDir} onSort={onMboxSort} />
                <SortableHeader label="Quota" sortKey="usedMb" currentKey={mboxSortKey} direction={mboxSortDir} onSort={onMboxSort} />
                <SortableHeader label="Status" sortKey="status" currentKey={mboxSortKey} direction={mboxSortDir} onSort={onMboxSort} />
              </tr>
            </thead>
            <tbody>
              {sortedMailboxes.map((m) => (
                <tr key={m.id} className="border-b border-gray-50 dark:border-gray-700">
                  <td className="py-2 font-medium text-gray-900 dark:text-gray-100">{m.fullAddress}</td>
                  <td className="py-2 text-gray-600 dark:text-gray-400">{m.displayName ?? '\u2014'}</td>
                  <td className="py-2 text-gray-600 dark:text-gray-400">{m.usedMb}/{m.quotaMb} MB</td>
                  <td className="py-2">
                    <StatusBadge status={m.status as 'active' | 'pending' | 'suspended'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function WorkloadsTab({ data, isLoading, error }: TabContentProps<Workload>) {
  if (isLoading) return <TabLoading />;
  if (error) return <TabError message="Failed to load workloads." />;
  const items = data?.data ?? [];
  const { sortedData: sortedItems, sortKey, sortDirection, onSort } = useSortable(items, 'name');
  if (items.length === 0) return <TabEmpty resource="workloads" />;

  return (
    <table className="w-full text-left text-sm" data-testid="workloads-table">
      <thead>
        <tr className="border-b border-gray-100 dark:border-gray-700 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
          <SortableHeader label="Name" sortKey="name" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Replicas" sortKey="replicaCount" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="CPU" sortKey="cpuRequest" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Memory" sortKey="memoryRequest" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Status" sortKey="status" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Created" sortKey="createdAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
        </tr>
      </thead>
      <tbody>
        {sortedItems.map((w) => (
          <tr key={w.id} className="border-b border-gray-50 dark:border-gray-700">
            <td className="py-2 font-medium text-gray-900 dark:text-gray-100">{w.name}</td>
            <td className="py-2 text-gray-600 dark:text-gray-400">{w.replicaCount}</td>
            <td className="py-2 text-gray-600 dark:text-gray-400">{w.cpuRequest}</td>
            <td className="py-2 text-gray-600 dark:text-gray-400">{w.memoryRequest}</td>
            <td className="py-2"><StatusBadge status={w.status} /></td>
            <td className="py-2 text-gray-500 dark:text-gray-400">{new Date(w.createdAt).toLocaleDateString()}</td>
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
  const { sortedData: sortedItems, sortKey, sortDirection, onSort } = useSortable(items, 'resourceType');
  if (items.length === 0) return <TabEmpty resource="backups" />;

  return (
    <table className="w-full text-left text-sm" data-testid="backups-table">
      <thead>
        <tr className="border-b border-gray-100 dark:border-gray-700 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
          <SortableHeader label="Resource" sortKey="resourceType" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Type" sortKey="backupType" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Size" sortKey="sizeBytes" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Created" sortKey="createdAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Expires" sortKey="expiresAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
        </tr>
      </thead>
      <tbody>
        {sortedItems.map((b) => (
          <tr key={b.id} className="border-b border-gray-50 dark:border-gray-700">
            <td className="py-2 font-medium text-gray-900 dark:text-gray-100">{b.resourceType}</td>
            <td className="py-2 text-gray-600 dark:text-gray-400">{b.backupType}</td>
            <td className="py-2 text-gray-600 dark:text-gray-400">{b.sizeBytes ? formatBytes(b.sizeBytes) : '—'}</td>
            <td className="py-2 text-gray-500 dark:text-gray-400">{new Date(b.createdAt).toLocaleDateString()}</td>
            <td className="py-2 text-gray-500 dark:text-gray-400">{b.expiresAt ? new Date(b.expiresAt).toLocaleDateString() : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ResourceLimitsCard({
  client,
  clientId,
}: {
  readonly client: import('@/types/api').Client;
  readonly clientId: string;
}) {
  const updateClient = useUpdateClient(clientId);
  const { data: plansData } = usePlans();
  const plans = plansData?.data ?? [];
  const plan = plans.find((p) => p.id === client.planId);

  const [editing, setEditing] = useState(false);
  const [cpuOverride, setCpuOverride] = useState<string>('');
  const [memOverride, setMemOverride] = useState<string>('');
  const [storageOverride, setStorageOverride] = useState<string>('');
  const [subUsersOverride, setSubUsersOverride] = useState<string>('');
  const [priceOverride, setPriceOverride] = useState<string>('');
  const [cpuCustom, setCpuCustom] = useState(false);
  const [memCustom, setMemCustom] = useState(false);
  const [storageCustom, setStorageCustom] = useState(false);
  const [subUsersCustom, setSubUsersCustom] = useState(false);
  const [priceCustom, setPriceCustom] = useState(false);

  const effectiveCpu = client.cpuLimitOverride ?? plan?.cpuLimit ?? '—';
  const effectiveMem = client.memoryLimitOverride ?? plan?.memoryLimit ?? '—';
  const effectiveStorage = client.storageLimitOverride ?? plan?.storageLimit ?? '—';
  const effectiveSubUsers = client.maxSubUsersOverride ?? plan?.maxSubUsers ?? '—';
  const effectivePrice = client.monthlyPriceOverride ?? plan?.monthlyPriceUsd ?? '—';

  const startEditing = () => {
    const hasCpu = client.cpuLimitOverride != null;
    const hasMem = client.memoryLimitOverride != null;
    const hasStorage = client.storageLimitOverride != null;
    const hasSubUsers = client.maxSubUsersOverride != null;
    const hasPrice = client.monthlyPriceOverride != null;
    setCpuCustom(hasCpu);
    setMemCustom(hasMem);
    setStorageCustom(hasStorage);
    setSubUsersCustom(hasSubUsers);
    setPriceCustom(hasPrice);
    setCpuOverride(hasCpu ? String(client.cpuLimitOverride) : (plan?.cpuLimit ?? ''));
    setMemOverride(hasMem ? String(client.memoryLimitOverride) : (plan?.memoryLimit ?? ''));
    setStorageOverride(hasStorage ? String(client.storageLimitOverride) : (plan?.storageLimit ?? ''));
    setSubUsersOverride(hasSubUsers ? String(client.maxSubUsersOverride) : String(plan?.maxSubUsers ?? ''));
    setPriceOverride(hasPrice ? String(client.monthlyPriceOverride) : (plan?.monthlyPriceUsd ?? ''));
    setEditing(true);
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await updateClient.mutateAsync({
        cpu_limit_override: cpuCustom ? Number(cpuOverride) : null,
        memory_limit_override: memCustom ? Number(memOverride) : null,
        storage_limit_override: storageCustom ? Number(storageOverride) : null,
        max_sub_users_override: subUsersCustom ? Number(subUsersOverride) : null,
        monthly_price_override: priceCustom ? Number(priceOverride) : null,
      });
      setEditing(false);
    } catch { /* error via updateClient.error */ }
  };

  const INPUT_CLS = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100';

  const renderField = (
    label: string,
    unit: string,
    effectiveValue: string | number,
    isCustom: boolean,
    setCustom: (v: boolean) => void,
    value: string,
    setValue: (v: string) => void,
    isOverridden: boolean,
    inputType: string = 'number',
    step: string = '0.01',
  ) => (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">{label}</label>
        {editing && (
          <button
            type="button"
            onClick={() => setCustom(!isCustom)}
            className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
            data-testid={`toggle-${label.toLowerCase().replace(/\s/g, '-')}`}
          >
            {isCustom ? <ToggleRight size={16} className="text-brand-500" /> : <ToggleLeft size={16} />}
            {isCustom ? 'Custom' : 'Plan default'}
          </button>
        )}
      </div>
      {editing ? (
        <div className="flex items-center gap-2">
          <input
            type={inputType}
            step={step}
            className={`${INPUT_CLS} ${!isCustom ? 'bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500' : ''}`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={!isCustom}
          />
          <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{unit}</span>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-900 dark:text-gray-100 font-medium">{effectiveValue}</span>
          <span className="text-xs text-gray-500 dark:text-gray-400">{unit}</span>
          {isOverridden && (
            <span className="inline-flex rounded-full bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400">custom</span>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm" data-testid="resource-limits-card">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Cpu size={18} className="text-gray-600 dark:text-gray-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Resource Limits</h2>
          {plan && <span className="text-sm text-gray-500 dark:text-gray-400">({plan.name} plan)</span>}
        </div>
        {!editing && (
          <button
            type="button"
            onClick={startEditing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            data-testid="edit-limits-button"
          >
            <Edit size={14} />
            Edit
          </button>
        )}
      </div>

      <form onSubmit={handleSave}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {renderField('CPU Limit', 'cores', effectiveCpu, cpuCustom, setCpuCustom, cpuOverride, setCpuOverride, client.cpuLimitOverride != null, 'number', '0.25')}
          {renderField('Memory Limit', 'GB', effectiveMem, memCustom, setMemCustom, memOverride, setMemOverride, client.memoryLimitOverride != null, 'number', '0.5')}
          {renderField('Storage Limit', 'GB', effectiveStorage, storageCustom, setStorageCustom, storageOverride, setStorageOverride, client.storageLimitOverride != null, 'number', '1')}
          {renderField('Max Sub-Users', '', effectiveSubUsers, subUsersCustom, setSubUsersCustom, subUsersOverride, setSubUsersOverride, client.maxSubUsersOverride != null, 'number', '1')}
          {renderField('Monthly Price', 'USD', effectivePrice, priceCustom, setPriceCustom, priceOverride, setPriceOverride, client.monthlyPriceOverride != null, 'number', '0.01')}
        </div>

        {updateClient.error && editing && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">
            {updateClient.error instanceof Error ? updateClient.error.message : 'Failed to update limits'}
          </p>
        )}

        {editing && (
          <div className="mt-4 flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={updateClient.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="save-limits-button"
            >
              {updateClient.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

function SubscriptionCard({
  clientId,
  data,
  isLoading,
}: {
  readonly clientId: string;
  readonly data: import('@/types/api').SubscriptionResponse | undefined;
  readonly isLoading: boolean;
}) {
  const updateSub = useUpdateSubscription(clientId);
  const { data: plansData } = usePlans();
  const plans = plansData?.data ?? [];

  const [editing, setEditing] = useState(false);
  const [planId, setPlanId] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  const startEditing = () => {
    setPlanId(data?.plan?.id ?? '');
    setExpiresAt(data?.subscription_expires_at?.slice(0, 10) ?? '');
    setEditing(true);
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await updateSub.mutateAsync({
        plan_id: planId || undefined,
        subscription_expires_at: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
      setEditing(false);
    } catch { /* error via updateSub.error */ }
  };

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <Loader2 size={16} className="animate-spin text-gray-400" />
          <span className="text-sm text-gray-500 dark:text-gray-400">Loading subscription...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm" data-testid="subscription-card">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <CreditCard size={18} className="text-gray-600 dark:text-gray-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Subscription</h2>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={startEditing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            data-testid="edit-subscription-button"
          >
            <Edit size={14} />
            Edit
          </button>
        )}
      </div>

      {!editing ? (
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Plan</dt>
            <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">{data?.plan?.name ?? 'No plan'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Status</dt>
            <dd className="mt-1">
              <StatusBadge status={(data?.status ?? 'active') as 'active' | 'pending' | 'suspended'} />
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase text-gray-500 dark:text-gray-400">Expires</dt>
            <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
              {data?.subscription_expires_at
                ? new Date(data.subscription_expires_at).toLocaleDateString()
                : 'Not set'}
            </dd>
          </div>
        </dl>
      ) : (
        <form onSubmit={handleSave} className="space-y-4" data-testid="subscription-edit-form">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="sub-plan" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Plan</label>
              <select
                id="sub-plan"
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100"
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
                data-testid="sub-plan-select"
              >
                <option value="">No plan</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} — ${p.monthlyPriceUsd}/mo</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="sub-expires" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Expires</label>
              <input
                id="sub-expires"
                type="date"
                className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                data-testid="sub-expires-input"
              />
            </div>
          </div>
          {updateSub.error && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {updateSub.error instanceof Error ? updateSub.error.message : 'Failed to update subscription'}
            </p>
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={updateSub.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="save-subscription-button"
            >
              {updateSub.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(1)} ${units[i]}`;
}

const provisioningStatusColors: Record<string, string> = {
  unprovisioned: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  provisioning: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  provisioned: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
};

function ProvisioningStatusBadge({ status }: { readonly status: string }) {
  const colors = provisioningStatusColors[status] ?? provisioningStatusColors.unprovisioned;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${colors}`}>
      {status === 'provisioning' && <Loader2 size={10} className="animate-spin" />}
      {status}
    </span>
  );
}
