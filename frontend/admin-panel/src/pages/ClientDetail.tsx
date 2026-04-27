import { Fragment, useState, type FormEvent } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { config } from '@/lib/runtime-config';
import { ArrowLeft, Edit, Pause, Play, Trash2, Loader2, CreditCard, Save, UserCheck, Cpu, ToggleLeft, ToggleRight, Rocket, ServerCrash, FolderOpen, Mail, RefreshCw, Copy, CheckCircle, AlertCircle } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import EditClientModal from '@/components/EditClientModal';
import DeleteConfirmDialog from '@/components/DeleteConfirmDialog';
import ResizeStorageModal from '@/components/ResizeStorageModal';
import OperationProgressModal from '@/components/OperationProgressModal';
import ClientUsersTab from '@/components/ClientUsersTab';
import { useAdminSubUsers } from '@/hooks/use-sub-users';
import { useClient, useDeleteClient, useUpdateClient } from '@/hooks/use-clients';
import { useDomains } from '@/hooks/use-domains';
import { useBackups } from '@/hooks/use-backups';
import { useDeployments, useRestartDeployment, useBulkRestartDeployments } from '@/hooks/use-deployments';
import type { Deployment } from '@/hooks/use-deployments';
import { useSubscription, useUpdateSubscription } from '@/hooks/use-subscription';
import { useImpersonate } from '@/hooks/use-impersonate';
import { useSystemInfo } from '@/hooks/use-system-info';
import { usePlans } from '@/hooks/use-plans';
import { useClusterNodes } from '@/hooks/use-cluster-nodes';
import { useMigrateClientToWorker } from '@/hooks/use-tenant-migration';
import { useClientNamespaceIntegrity, useRepairClientNamespace, type IntegrityFinding } from '@/hooks/use-namespace-integrity';
import { useEmailDomains, useMailboxes, useMailSubmitCredential, useRotateMailSubmitCredential, useImapSyncJobs, useCreateImapSyncJob, useCancelImapSyncJob, type MailSubmitRotateResult, type ImapSyncJob } from '@/hooks/use-email';
import type { Domain, PaginatedResponse } from '@/types/api';
import type { Backup } from '@/hooks/use-backups';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';
import { useTriggerProvisioning, useTriggerDecommission } from '@/hooks/use-provisioning';
import { useClientMetrics } from '@/hooks/use-resource-metrics';
import ProvisioningProgressModal from '@/components/ProvisioningProgressModal';
import {
  useCreateSnapshot,
  useResizeDryRun,
  useResizeClient,
  useSuspendClient as useStorageSuspend,
  useResumeClient as useStorageResume,
  useArchiveClient as useStorageArchive,
  useRestoreClient as useStorageRestore,
  useStorageOperations,
  useClearFailedState,
} from '@/hooks/use-storage-lifecycle';

type TabKey = 'domains' | 'applications' | 'deployments' | 'files' | 'email' | 'backups' | 'users';

export default function ClientDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useClient(id);
  const client = data?.data;

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('domains');

  const domainsQuery = useDomains(id);
  const deploymentsQuery = useDeployments(id);
  const backupsQuery = useBackups(id);
  const subscriptionQuery = useSubscription(id);
  const emailDomainsQuery = useEmailDomains(id);
  const mailboxesQuery = useMailboxes(id);
  const subUsersQuery = useAdminSubUsers(id ?? null);

  const [provisioningOpen, setProvisioningOpen] = useState(false);
  const [decommissionOpen, setDecommissionOpen] = useState(false);

  const deleteClient = useDeleteClient();
  const updateClient = useUpdateClient(id ?? '');
  const impersonate = useImpersonate();
  const systemInfo = useSystemInfo();
  const triggerProvision = useTriggerProvisioning();
  const triggerDecommission = useTriggerDecommission();
  const bulkRestart = useBulkRestartDeployments();

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
  const deploymentCount = deploymentsQuery.data?.data.length ?? 0;
  const applicationCount = deploymentsQuery.data?.data.filter((d) => d.type === 'application').length ?? 0;
  const backupCount = backupsQuery.data?.data.length ?? 0;
  const emailDomainCount = emailDomainsQuery.data?.data.length ?? 0;
  const subUserCount = subUsersQuery.data?.data.length ?? 0;

  const tabs: readonly { readonly key: TabKey; readonly label: string; readonly count: number }[] = [
    { key: 'domains', label: 'Domains', count: domainCount },
    { key: 'applications', label: 'Applications', count: applicationCount },
    { key: 'deployments', label: 'Deployments', count: deploymentCount },
    { key: 'files', label: 'Files', count: 0 },
    { key: 'email', label: 'Email', count: emailDomainCount },
    { key: 'backups', label: 'Backups', count: backupCount },
    { key: 'users', label: 'Users', count: subUserCount },
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
              // Prefer the admin-configured clientPanelUrl from System Settings
              // (served via /api/v1/system-info) over the build-time env fallback
              // (config.CLIENT_PANEL_URL) — the former is what the operator
              // actually wants customers to see and what the Ingress reconciler
              // points at. Trim trailing slash so we don't build "https://x//login".
              const rawFromDb = systemInfo.data?.clientPanelUrl ?? '';
              const clientPanelUrl = (rawFromDb.trim() || config.CLIENT_PANEL_URL).replace(/\/+$/, '');
              if (!clientPanelUrl) {
                // Neither source populated — bail before opening a broken tab.
                alert('Client Panel URL is not configured. Set it in System Settings before using "Login as Client".');
                return;
              }
              try {
                const res = await impersonate.mutateAsync(id);
                const data = res.data;
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
          ) : (client as Record<string, unknown>).provisioningStatus === 'provisioned' ? (
            <button
              onClick={async () => {
                if (!id) return;
                try {
                  await triggerProvision.mutateAsync({ clientId: id });
                  setProvisioningOpen(true);
                } catch { /* error shown via mutation state */ }
              }}
              disabled={triggerProvision.isPending}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
              title="Re-run provisioning to fix inconsistent K8s state"
              data-testid="reprovision-button"
            >
              {triggerProvision.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              <span className="hidden sm:inline">Re-provision</span>
            </button>
          ) : null}
          <button
            onClick={() => bulkRestart.mutate(undefined)}
            disabled={bulkRestart.isPending}
            className="inline-flex items-center gap-2 rounded-lg border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 px-4 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 shadow-sm hover:bg-blue-100 dark:hover:bg-blue-900/40 disabled:opacity-50"
            title="Pull latest images and restart all running deployments"
            data-testid="refresh-all-apps-button"
          >
            {bulkRestart.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            <span className="hidden sm:inline">Refresh All Apps</span>
          </button>
          <button
            onClick={() => setEditOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-700/50"
            data-testid="edit-button"
          >
            <Edit size={14} />
            <span className="hidden sm:inline">Edit</span>
          </button>
          {client.status === 'suspended' ? (
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
          {client.status === 'suspended' && ((client as Record<string, unknown>).provisioningStatus === 'provisioned' || (client as Record<string, unknown>).provisioningStatus === 'failed') && (
            <button
              onClick={() => setDecommissionOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-red-600 dark:text-red-400 shadow-sm hover:bg-red-50 dark:hover:bg-red-900/20"
              data-testid="decommission-button"
            >
              <ServerCrash size={14} />
              <span className="hidden sm:inline">Decommission</span>
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

      <NamespaceIntegrityBanner clientId={id!} />

      <StorageLifecycleCard clientId={id!} client={client} />

      <PlacementCard clientId={id!} client={client} />

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
          {activeTab === 'applications' && <ApplicationsTab clientId={id} />}
          {activeTab === 'deployments' && <DeploymentsTab data={deploymentsQuery.data} isLoading={deploymentsQuery.isLoading} error={deploymentsQuery.error} clientId={id} />}
          {activeTab === 'files' && (
            <div className="text-center py-8 text-sm text-gray-500 dark:text-gray-400">
              <FolderOpen size={32} className="mx-auto mb-2 text-gray-300 dark:text-gray-600" />
              <p>File browser available in the client panel.</p>
              <p className="mt-1 text-xs">Use "Login as Client" to access the file manager.</p>
            </div>
          )}
          {activeTab === 'email' && <EmailTab clientId={id} emailDomains={emailDomainsQuery.data?.data} mailboxes={mailboxesQuery.data?.data} isLoading={emailDomainsQuery.isLoading || mailboxesQuery.isLoading} error={emailDomainsQuery.error || mailboxesQuery.error} />}
          {activeTab === 'backups' && <BackupsTab data={backupsQuery.data} isLoading={backupsQuery.isLoading} error={backupsQuery.error} />}
          {activeTab === 'users' && id && <ClientUsersTab clientId={id} />}
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

      {decommissionOpen && id && (
        <DecommissionConfirmDialog
          open={decommissionOpen}
          onClose={() => setDecommissionOpen(false)}
          onConfirm={async () => {
            try {
              await triggerDecommission.mutateAsync(id);
              setDecommissionOpen(false);
              setProvisioningOpen(true);
            } catch { /* error shown in dialog */ }
          }}
          clientName={name}
          namespace={client.kubernetesNamespace}
          isPending={triggerDecommission.isPending}
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

function ApplicationsTab({ clientId }: { readonly clientId: string | undefined }) {
  const { data, isLoading, error } = useDeployments(clientId, 'application');

  if (isLoading) return <TabLoading />;
  if (error) return <TabError message="Failed to load applications." />;

  const items = data?.data ?? [];
  if (items.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400" data-testid="applications-tab-empty">
        No applications deployed.
      </p>
    );
  }

  return (
    <table className="w-full text-left text-sm" data-testid="applications-table">
      <thead>
        <tr className="border-b border-gray-100 dark:border-gray-700 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
          <th className="py-2 pr-4">Name</th>
          <th className="py-2 pr-4">Version</th>
          <th className="py-2 pr-4">Domain</th>
          <th className="py-2 pr-4">Status</th>
          <th className="py-2 pr-4">Created</th>
        </tr>
      </thead>
      <tbody>
        {items.map((d) => (
          <tr key={d.id} className="border-b border-gray-50 dark:border-gray-700">
            <td className="py-2 font-medium text-gray-900 dark:text-gray-100">{d.name}</td>
            <td className="py-2 text-gray-600 dark:text-gray-400">{d.installedVersion ?? '\u2014'}</td>
            <td className="py-2 text-gray-600 dark:text-gray-400">{d.domainName ?? '\u2014'}</td>
            <td className="py-2"><StatusBadge status={d.status as Parameters<typeof StatusBadge>[0]['status']} /></td>
            <td className="py-2 text-gray-500 dark:text-gray-400">{new Date(d.createdAt).toLocaleDateString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface EmailTabProps {
  readonly emailDomains: readonly { readonly id: string; readonly domainName: string; readonly enabled: number; readonly mailboxCount?: number; readonly createdAt: string }[] | undefined;
  readonly mailboxes: readonly { readonly id: string; readonly fullAddress: string; readonly displayName: string | null; readonly status: string; readonly quotaMb: number; readonly usedMb: number; readonly createdAt: string }[] | undefined;
  readonly clientId?: string;
  readonly isLoading: boolean;
  readonly error: Error | null;
}

function EmailTab({ emailDomains, mailboxes, clientId, isLoading, error }: EmailTabProps) {
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

      {clientId && <MailSubmitCredentialPanel clientId={clientId} />}
      {clientId && mboxes.length > 0 && (
        <ImapSyncPanel clientId={clientId} mailboxes={mboxes.map(m => ({ id: m.id, fullAddress: m.fullAddress }))} />
      )}

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

// ─── Mail Submit Credential Panel (sendmail compat) ──────────────────────

function MailSubmitCredentialPanel({ clientId }: { readonly clientId: string }) {
  const { data, isLoading } = useMailSubmitCredential(clientId);
  const rotate = useRotateMailSubmitCredential(clientId);
  const [latest, setLatest] = useState<MailSubmitRotateResult | null>(null);
  const [copied, setCopied] = useState(false);

  const cred = data?.data;

  const handleRotate = async (pushToPvc: boolean) => {
    setLatest(null);
    const res = await rotate.mutateAsync({ pushToPvc });
    setLatest(res.data);
  };

  const copyPassword = async () => {
    if (!latest?.password) return;
    try {
      await navigator.clipboard.writeText(latest.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Browsers without clipboard API — silently ignore
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4" data-testid="mail-submit-panel">
      <div className="mb-3 flex items-center gap-2">
        <Mail size={16} className="text-brand-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Sendmail submission credentials</h3>
      </div>

      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
        Per-customer SMTP credentials used by workload pods (WordPress, PHP <code>mail()</code>, etc.) to relay outbound mail through Stalwart. The auth file is written to the customer PVC at <code>.platform/sendmail-auth</code> and hidden from the file manager.
      </p>

      {isLoading && <div className="py-3 text-center"><Loader2 size={16} className="inline animate-spin text-brand-500" /></div>}

      {!isLoading && cred && cred.exists && (
        <div className="mb-3 grid grid-cols-[100px_1fr] gap-2 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3 text-xs">
          <span className="font-medium text-gray-500 dark:text-gray-400">Username</span>
          <code className="font-mono text-gray-900 dark:text-gray-100">{cred.username}</code>
          <span className="font-medium text-gray-500 dark:text-gray-400">Created</span>
          <span className="text-gray-700 dark:text-gray-300">{cred.createdAt ? new Date(cred.createdAt).toLocaleString() : '—'}</span>
          <span className="font-medium text-gray-500 dark:text-gray-400">Last used</span>
          <span className="text-gray-700 dark:text-gray-300">{cred.lastUsedAt ? new Date(cred.lastUsedAt).toLocaleString() : 'never'}</span>
        </div>
      )}

      {!isLoading && cred && !cred.exists && (
        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400 italic">No credentials provisioned yet.</p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => handleRotate(true)}
          disabled={rotate.isPending}
          className="inline-flex items-center gap-1 rounded-md bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="rotate-submit-credential"
        >
          {rotate.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Rotate &amp; push to PVC
        </button>
        <button
          type="button"
          onClick={() => handleRotate(false)}
          disabled={rotate.isPending}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
        >
          Rotate only
        </button>
      </div>

      {latest && (
        <div className="mt-3 rounded-md border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-xs">
          <p className="mb-2 font-medium text-amber-900 dark:text-amber-100">
            New credential generated. The plain password is shown ONCE — copy it now if you need it for manual configuration.
          </p>
          <div className="grid grid-cols-[80px_1fr] gap-2">
            <span className="font-medium text-gray-500 dark:text-gray-400">Username</span>
            <code className="font-mono text-gray-900 dark:text-gray-100">{latest.username}</code>
            <span className="font-medium text-gray-500 dark:text-gray-400">Password</span>
            <div className="flex items-start gap-1">
              <code className="flex-1 break-all font-mono text-gray-900 dark:text-gray-100">{latest.password}</code>
              <button
                type="button"
                onClick={copyPassword}
                className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                title="Copy password to clipboard"
              >
                {copied ? <CheckCircle size={12} className="text-green-500" /> : <Copy size={12} />}
              </button>
            </div>
          </div>
          <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
            {latest.pushedToPvc
              ? '✓ Auth file written to customer PVC. Workload pods will pick it up on next mail send.'
              : `⚠ PVC write skipped or failed${latest.pushError ? `: ${latest.pushError}` : ''}.`}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── IMAPSync Panel (one-shot mailbox migration) ───────────────────────

function ImapSyncPanel({
  clientId,
  mailboxes,
}: {
  readonly clientId: string;
  readonly mailboxes: readonly { readonly id: string; readonly fullAddress: string }[];
}) {
  const { data: jobsRes, isLoading } = useImapSyncJobs(clientId);
  const create = useCreateImapSyncJob(clientId);
  const cancel = useCancelImapSyncJob(clientId);
  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const jobs = jobsRes?.data ?? [];

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);
    const fd = new FormData(e.currentTarget);
    try {
      await create.mutateAsync({
        mailbox_id: String(fd.get('mailbox_id') ?? ''),
        source_host: String(fd.get('source_host') ?? ''),
        source_port: parseInt(String(fd.get('source_port') ?? '993'), 10),
        source_username: String(fd.get('source_username') ?? ''),
        source_password: String(fd.get('source_password') ?? ''),
        source_ssl: fd.get('source_ssl') === 'on',
        options: {
          automap: fd.get('automap') === 'on',
          dryRun: fd.get('dry_run') === 'on',
        },
      });
      setShowForm(false);
      (e.currentTarget as HTMLFormElement).reset();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to start sync');
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4" data-testid="imapsync-panel">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Mail size={16} className="text-brand-500" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">IMAP migration jobs</h3>
        </div>
        <button
          type="button"
          onClick={() => setShowForm(s => !s)}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          data-testid="imapsync-toggle-form"
        >
          {showForm ? 'Cancel' : 'Migrate from external IMAP…'}
        </button>
      </div>

      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
        Run a one-shot migration from an external IMAP server (Gmail, Outlook, legacy hosting) into one of this client&apos;s mailboxes. The destination uses Stalwart master SSO so no per-mailbox password is needed.
      </p>

      {showForm && (
        <form onSubmit={onSubmit} className="mb-4 space-y-2 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3 text-xs">
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="block text-gray-500 dark:text-gray-400">Destination mailbox</span>
              <select name="mailbox_id" required className="w-full rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1">
                {mailboxes.map(m => <option key={m.id} value={m.id}>{m.fullAddress}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="block text-gray-500 dark:text-gray-400">Source host</span>
              <input name="source_host" required placeholder="imap.gmail.com" className="w-full rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1" />
            </label>
            <label className="space-y-1">
              <span className="block text-gray-500 dark:text-gray-400">Source port</span>
              <input name="source_port" type="number" defaultValue={993} required className="w-full rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1" />
            </label>
            <label className="space-y-1">
              <span className="block text-gray-500 dark:text-gray-400">Source username</span>
              <input name="source_username" required className="w-full rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1" />
            </label>
            <label className="col-span-2 space-y-1">
              <span className="block text-gray-500 dark:text-gray-400">Source password</span>
              <input name="source_password" type="password" required className="w-full rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1" />
            </label>
          </div>
          <div className="flex items-center gap-4 pt-1">
            <label className="inline-flex items-center gap-1 text-gray-600 dark:text-gray-300">
              <input type="checkbox" name="source_ssl" defaultChecked /> SSL
            </label>
            <label className="inline-flex items-center gap-1 text-gray-600 dark:text-gray-300">
              <input type="checkbox" name="automap" defaultChecked /> Automap folders
            </label>
            <label className="inline-flex items-center gap-1 text-gray-600 dark:text-gray-300">
              <input type="checkbox" name="dry_run" /> Dry run
            </label>
          </div>
          {formError && <p className="text-red-600 dark:text-red-400">{formError}</p>}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={create.isPending}
              className="inline-flex items-center gap-1 rounded-md bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="imapsync-submit"
            >
              {create.isPending && <Loader2 size={12} className="animate-spin" />}
              Start sync
            </button>
          </div>
        </form>
      )}

      {isLoading && <div className="py-3 text-center"><Loader2 size={16} className="inline animate-spin text-brand-500" /></div>}

      {!isLoading && jobs.length === 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400 italic">No IMAPSync jobs yet.</p>
      )}

      {jobs.length > 0 && (
        <div className="space-y-2">
          {jobs.map(j => (
            <ImapSyncJobRow key={j.id} job={j} onCancel={() => cancel.mutate(j.id)} cancelPending={cancel.isPending} />
          ))}
        </div>
      )}
    </div>
  );
}

function ImapSyncJobRow({ job, onCancel, cancelPending }: { readonly job: ImapSyncJob; readonly onCancel: () => void; readonly cancelPending: boolean }) {
  const [showLog, setShowLog] = useState(false);
  const isActive = job.status === 'pending' || job.status === 'running';
  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3 text-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <code className="font-mono text-gray-900 dark:text-gray-100">{job.sourceUsername}@{job.sourceHost}</code>
          <span className="text-gray-400">→</span>
          <code className="font-mono text-gray-900 dark:text-gray-100">{job.mailboxId.slice(0, 8)}</code>
          <ImapSyncStatusBadge status={job.status} />
        </div>
        {isActive && (
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelPending}
            className="rounded border border-red-200 dark:border-red-700 px-2 py-0.5 text-xs text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
          >
            Cancel
          </button>
        )}
      </div>
      <div className="mt-1 text-gray-500 dark:text-gray-400">
        Started {job.startedAt ? new Date(job.startedAt).toLocaleString() : '—'}
        {job.finishedAt && ` · Finished ${new Date(job.finishedAt).toLocaleString()}`}
      </div>
      {job.errorMessage && (
        <p className="mt-1 text-red-600 dark:text-red-400">{job.errorMessage}</p>
      )}
      {job.logTail && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowLog(s => !s)}
            className="text-brand-600 dark:text-brand-400 hover:underline"
          >
            {showLog ? 'Hide log' : 'Show log'}
          </button>
          {showLog && (
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-gray-900 p-2 font-mono text-[11px] text-gray-100">{job.logTail}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function ImapSyncStatusBadge({ status }: { readonly status: ImapSyncJob['status'] }) {
  const styles = {
    pending: 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
    running: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
    succeeded: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
    failed: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
    cancelled: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  } as const;
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${styles[status]}`}>{status}</span>;
}

function DeploymentsTab({ data, isLoading, error, clientId }: TabContentProps<Deployment> & { readonly clientId: string | undefined }) {
  const restartDeployment = useRestartDeployment(clientId);

  if (isLoading) return <TabLoading />;
  if (error) return <TabError message="Failed to load deployments." />;
  const items = data?.data ?? [];
  const { sortedData: sortedItems, sortKey, sortDirection, onSort } = useSortable(items, 'name');
  if (items.length === 0) return <TabEmpty resource="deployments" />;

  return (
    <table className="w-full text-left text-sm" data-testid="deployments-table">
      <thead>
        <tr className="border-b border-gray-100 dark:border-gray-700 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
          <SortableHeader label="Name" sortKey="name" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Type" sortKey="type" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Replicas" sortKey="replicaCount" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="CPU" sortKey="cpuRequest" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Memory" sortKey="memoryRequest" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Status" sortKey="status" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Created" sortKey="createdAt" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <th className="px-3 py-2 text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {sortedItems.map((d) => {
          // Surface lastError / statusMessage as a follow-up row so
          // operators see the failure reason without drilling down.
          // Pre-fix this was invisible — a stuck Longhorn volume looked
          // identical to a healthy starting workload until the 60-min
          // stale timeout kicked in.
          const detail = (d.lastError && d.lastError.trim()) || (d.statusMessage && d.statusMessage.trim()) || '';
          const detailTone = d.status === 'failed'
            ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'
            : 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300';
          return (
            <Fragment key={d.id}>
              <tr className="border-b border-gray-50 dark:border-gray-700">
                <td className="py-2 font-medium text-gray-900 dark:text-gray-100">{d.name}</td>
                <td className="py-2 text-gray-600 dark:text-gray-400">{d.type}</td>
                <td className="py-2 text-gray-600 dark:text-gray-400">{d.replicaCount}</td>
                <td className="py-2 text-gray-600 dark:text-gray-400">{d.cpuRequest}</td>
                <td className="py-2 text-gray-600 dark:text-gray-400">{d.memoryRequest}</td>
                <td className="py-2"><StatusBadge status={d.status as Parameters<typeof StatusBadge>[0]['status']} /></td>
                <td className="py-2 text-gray-500 dark:text-gray-400">{new Date(d.createdAt).toLocaleDateString()}</td>
                <td className="py-2 text-right">
                  {d.status === 'running' && (
                    <button
                      type="button"
                      onClick={() => restartDeployment.mutate(d.id)}
                      disabled={restartDeployment.isPending}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/20 px-2.5 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Pull latest image and restart"
                      data-testid={`restart-deployment-${d.id}`}
                    >
                      {restartDeployment.isPending ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <RefreshCw size={12} />
                      )}
                      Restart
                    </button>
                  )}
                </td>
              </tr>
              {detail && (
                <tr className={detailTone} data-testid={`deployment-${d.id}-detail`}>
                  <td colSpan={8} className="px-3 py-1.5 text-xs">
                    <span className="font-medium">{d.status === 'failed' ? 'Error: ' : 'Status: '}</span>
                    {detail}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
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
  const { data: metricsData, isLoading: metricsLoading } = useClientMetrics(clientId);
  const plans = plansData?.data ?? [];
  const plan = plans.find((p) => p.id === client.planId);

  const [editing, setEditing] = useState(false);
  const [cpuOverride, setCpuOverride] = useState<string>('');
  const [memOverride, setMemOverride] = useState<string>('');
  const [storageOverride, setStorageOverride] = useState<string>('');
  const [subUsersOverride, setSubUsersOverride] = useState<string>('');
  const [mailboxesOverride, setMailboxesOverride] = useState<string>('');
  const [priceOverride, setPriceOverride] = useState<string>('');
  const [cpuCustom, setCpuCustom] = useState(false);
  const [memCustom, setMemCustom] = useState(false);
  const [storageCustom, setStorageCustom] = useState(false);
  const [subUsersCustom, setSubUsersCustom] = useState(false);
  const [mailboxesCustom, setMailboxesCustom] = useState(false);
  const [priceCustom, setPriceCustom] = useState(false);

  const effectiveCpu = client.cpuLimitOverride ?? plan?.cpuLimit ?? '—';
  const effectiveMem = client.memoryLimitOverride ?? plan?.memoryLimit ?? '—';
  const effectiveStorage = client.storageLimitOverride ?? plan?.storageLimit ?? '—';
  const effectiveSubUsers = client.maxSubUsersOverride ?? plan?.maxSubUsers ?? '—';
  const effectiveMailboxes = client.maxMailboxesOverride ?? plan?.maxMailboxes ?? '—';
  const effectivePrice = client.monthlyPriceOverride ?? plan?.monthlyPriceUsd ?? '—';

  const startEditing = () => {
    const hasCpu = client.cpuLimitOverride != null;
    const hasMem = client.memoryLimitOverride != null;
    const hasStorage = client.storageLimitOverride != null;
    const hasSubUsers = client.maxSubUsersOverride != null;
    const hasMailboxes = client.maxMailboxesOverride != null;
    const hasPrice = client.monthlyPriceOverride != null;
    setCpuCustom(hasCpu);
    setMemCustom(hasMem);
    setStorageCustom(hasStorage);
    setSubUsersCustom(hasSubUsers);
    setMailboxesCustom(hasMailboxes);
    setPriceCustom(hasPrice);
    setCpuOverride(hasCpu ? String(client.cpuLimitOverride) : (plan?.cpuLimit ?? ''));
    setMemOverride(hasMem ? String(client.memoryLimitOverride) : (plan?.memoryLimit ?? ''));
    setStorageOverride(hasStorage ? String(client.storageLimitOverride) : (plan?.storageLimit ?? ''));
    setSubUsersOverride(hasSubUsers ? String(client.maxSubUsersOverride) : String(plan?.maxSubUsers ?? ''));
    setMailboxesOverride(hasMailboxes ? String(client.maxMailboxesOverride) : String(plan?.maxMailboxes ?? ''));
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
        max_mailboxes_override: mailboxesCustom ? Number(mailboxesOverride) : null,
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6">
          {renderField('CPU Limit', 'cores', effectiveCpu, cpuCustom, setCpuCustom, cpuOverride, setCpuOverride, client.cpuLimitOverride != null, 'number', '0.25')}
          {renderField('Memory Limit', 'GB', effectiveMem, memCustom, setMemCustom, memOverride, setMemOverride, client.memoryLimitOverride != null, 'number', '0.5')}
          {renderField('Storage Limit', 'GB', effectiveStorage, storageCustom, setStorageCustom, storageOverride, setStorageOverride, client.storageLimitOverride != null, 'number', '1')}
          {renderField('Max Sub-Users', '', effectiveSubUsers, subUsersCustom, setSubUsersCustom, subUsersOverride, setSubUsersOverride, client.maxSubUsersOverride != null, 'number', '1')}
          {renderField('Max Mailboxes', '', effectiveMailboxes, mailboxesCustom, setMailboxesCustom, mailboxesOverride, setMailboxesOverride, client.maxMailboxesOverride != null, 'number', '1')}
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

      {/* Current Metrics */}
      <div className="mt-5 border-t border-gray-200 dark:border-gray-700 pt-4" data-testid="current-metrics-section">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Current Usage</h3>
        {metricsLoading && (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 size={14} className="animate-spin" />
            Loading metrics...
          </div>
        )}
        {!metricsLoading && (!metricsData?.data?.cpu || !metricsData?.data?.memory || !metricsData?.data?.storage) && (
          <p className="text-sm text-gray-400 dark:text-gray-500">No metrics available yet.</p>
        )}
        {metricsData?.data?.cpu && metricsData?.data?.memory && metricsData?.data?.storage && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <MetricsUsageBlock
              label="CPU"
              inUse={metricsData.data.cpu.inUse}
              reserved={metricsData.data.cpu.reserved}
              available={metricsData.data.cpu.available}
              formatValue={formatMetricsCpu}
              unit="cores"
            />
            <MetricsUsageBlock
              label="Memory"
              inUse={metricsData.data.memory.inUse}
              reserved={metricsData.data.memory.reserved}
              available={metricsData.data.memory.available}
              formatValue={formatMetricsGi}
              unit=""
            />
            <MetricsUsageBlock
              label="Storage"
              inUse={metricsData.data.storage.inUse}
              reserved={metricsData.data.storage.reserved}
              available={metricsData.data.storage.available}
              formatValue={formatMetricsGi}
              unit=""
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Metrics Display Helpers ─────────────────────────────────────────────────

function formatMetricsCpu(value: number): string {
  if (value >= 10) return value.toFixed(0);
  if (value >= 1) return value.toFixed(1);
  return value.toFixed(2);
}

function formatMetricsGi(valueGi: number): string {
  if (valueGi <= 0) return '0 Mi';
  if (valueGi < 1) {
    const mi = valueGi * 1024;
    if (mi >= 100) return `${mi.toFixed(0)} Mi`;
    if (mi >= 10) return `${mi.toFixed(1)} Mi`;
    return `${mi.toFixed(2)} Mi`;
  }
  if (valueGi >= 10) return `${valueGi.toFixed(0)} Gi`;
  return `${valueGi.toFixed(1)} Gi`;
}

function MetricsUsageBlock({
  label,
  inUse,
  reserved,
  available,
  formatValue,
  unit,
}: {
  readonly label: string;
  readonly inUse: number;
  readonly reserved: number;
  readonly available: number;
  readonly formatValue: (v: number) => string;
  readonly unit: string;
}) {
  const ratio = available > 0 ? inUse / available : 0;
  const pct = Math.min(Math.max(ratio * 100, 0), 100);

  let barColor: string;
  if (ratio >= 0.8) {
    barColor = 'bg-red-500 dark:bg-red-400';
  } else if (ratio >= 0.5) {
    barColor = 'bg-amber-500 dark:bg-amber-400';
  } else {
    barColor = 'bg-green-500 dark:bg-green-400';
  }

  const suffix = unit ? ` ${unit}` : '';

  return (
    <div className="rounded-lg border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 p-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-semibold text-gray-600 dark:text-gray-400">{label}</span>
        <span className="text-xs text-gray-500 dark:text-gray-400">{formatValue(inUse)}{suffix} / {formatValue(available)}{suffix}</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-700 mb-2">
        <div className={`h-1.5 rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="space-y-0.5 text-xs text-gray-500 dark:text-gray-400">
        <div className="flex justify-between">
          <span>In Use</span>
          <span className="font-mono text-gray-700 dark:text-gray-300">{formatValue(inUse)}{suffix}</span>
        </div>
        <div className="flex justify-between">
          <span>Reserved</span>
          <span className="font-mono text-gray-700 dark:text-gray-300">{formatValue(reserved)}{suffix}</span>
        </div>
        <div className="flex justify-between">
          <span>Available</span>
          <span className="font-mono text-gray-700 dark:text-gray-300">{formatValue(available)}{suffix}</span>
        </div>
      </div>
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

function DecommissionConfirmDialog({
  open,
  onClose,
  onConfirm,
  clientName,
  namespace,
  isPending,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
  readonly clientName: string;
  readonly namespace: string;
  readonly isPending: boolean;
}) {
  const [confirmText, setConfirmText] = useState('');

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-60 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="decommission-dialog-backdrop"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800" data-testid="decommission-dialog">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
            <ServerCrash size={20} className="text-red-600 dark:text-red-400" />
          </div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Decommission Client
          </h2>
        </div>

        <div className="space-y-3 text-sm text-gray-600 dark:text-gray-400">
          <p>
            This will permanently delete <strong>all Kubernetes resources</strong> for{' '}
            <strong className="text-gray-900 dark:text-gray-100">{clientName}</strong>:
          </p>
          <ul className="list-disc pl-5 space-y-1">
            <li>Namespace <code className="rounded bg-gray-100 px-1 dark:bg-gray-700">{namespace}</code></li>
            <li>All deployments, services, and ingress rules</li>
            <li>Persistent volume claims and stored data</li>
            <li>Resource quotas and network policies</li>
          </ul>
          <p className="font-semibold text-red-600 dark:text-red-400">
            This action cannot be undone. All customer data on the cluster will be permanently lost.
          </p>
        </div>

        <div className="mt-4">
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Type <strong>DECOMMISSION</strong> to confirm
          </label>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            placeholder="DECOMMISSION"
            data-testid="decommission-confirm-input"
          />
        </div>

        <div className="mt-5 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={confirmText !== 'DECOMMISSION' || isPending}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            data-testid="decommission-confirm-button"
          >
            {isPending ? <Loader2 size={14} className="animate-spin inline mr-1" /> : null}
            Decommission
          </button>
        </div>
      </div>
    </div>
  );
}

function StorageLifecycleCard({ clientId, client }: { readonly clientId: string; readonly client: { status?: string; storageLifecycleState?: string; storageLimitOverride?: string | null } }) {
  const opsQuery = useStorageOperations(clientId);
  const dryRun = useResizeDryRun();
  const resize = useResizeClient();
  const snapshot = useCreateSnapshot();
  const suspend = useStorageSuspend();
  const resume = useStorageResume();
  const archive = useStorageArchive();
  const restore = useStorageRestore();
  const clearFailed = useClearFailedState();

  const ops = opsQuery.data?.data ?? [];
  const activeOp = ops.find((o) => o.state !== 'idle' && o.state !== 'failed' && !o.completedAt);
  const recentOp = ops[0];
  const lifecycleState = client.storageLifecycleState ?? 'idle';
  const isBusy = lifecycleState !== 'idle' || !!activeOp
    || resize.isPending || snapshot.isPending || suspend.isPending
    || resume.isPending || archive.isPending || restore.isPending;

  const [resizeOpen, setResizeOpen] = useState(false);
  const [trackedOpId, setTrackedOpId] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  const trackOp = (operationId: string) => { setTrackedOpId(operationId); setOpError(null); };
  const surfaceError = (err: unknown) => {
    setOpError(err instanceof Error ? err.message : String(err));
  };

  // Parse current storage in MiB from override (GiB decimal) or plan.
  const currentMib = client.storageLimitOverride != null
    ? Math.round(Number(client.storageLimitOverride) * 1024)
    : 10 * 1024; // fallback until we have plan info

  const onResize = () => { setOpError(null); setResizeOpen(true); };

  const onSuspend = async () => {
    if (!confirm('Suspend this client? All workloads will scale to 0 and the site will show a suspension page.')) return;
    try {
      const res = await suspend.mutateAsync(clientId);
      const opId = (res as { data?: { operationId?: string } })?.data?.operationId;
      if (opId) trackOp(opId);
    } catch (err) { surfaceError(err); }
  };
  const onResume = async () => {
    if (!confirm('Resume this client? Workloads will be restored to their pre-suspend replica counts.')) return;
    try {
      const res = await resume.mutateAsync(clientId);
      const opId = (res as { data?: { operationId?: string } })?.data?.operationId;
      if (opId) trackOp(opId);
    } catch (err) { surfaceError(err); }
  };
  const onArchive = async () => {
    const raw = prompt('Archive retention (days) — how long to keep the final snapshot:', '90');
    if (!raw) return;
    const retentionDays = parseInt(raw, 10);
    if (!confirm(`Archive client — take final snapshot (retained ${retentionDays}d), delete mailboxes, aliases, and all live workloads?`)) return;
    try {
      const res = await archive.mutateAsync({ clientId, retentionDays });
      const opId = (res as { data?: { operationId?: string } })?.data?.operationId;
      if (opId) trackOp(opId);
    } catch (err) { surfaceError(err); }
  };
  const onRestore = async () => {
    if (!confirm('Restore this archived client from the pre-archive snapshot?')) return;
    try {
      const res = await restore.mutateAsync({ clientId });
      const opId = (res as { data?: { operationId?: string } })?.data?.operationId;
      if (opId) trackOp(opId);
    } catch (err) { surfaceError(err); }
  };
  const onSnapshot = async () => {
    const label = prompt('Snapshot label (optional):', `Manual ${new Date().toISOString().slice(0, 16)}`);
    if (label === null) return;
    try {
      const res = await snapshot.mutateAsync({ clientId, label });
      const opId = (res as { data?: { operationId?: string } })?.data?.operationId;
      if (opId) trackOp(opId);
    } catch (err) { surfaceError(err); }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Storage Lifecycle</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Snapshot, resize, suspend, or archive this client. Snapshots live in the platform's snapshot store (hostPath in dev, S3 in prod).
          </p>
        </div>
        <div className="text-right text-xs">
          <div className="text-gray-500 dark:text-gray-400">Lifecycle state</div>
          <div className={`mt-0.5 rounded px-2 py-0.5 font-mono ${lifecycleState === 'idle' ? 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200'}`}>
            {lifecycleState}
          </div>
        </div>
      </div>

      {activeOp && (
        <div className="mb-3 rounded-md bg-amber-50 dark:bg-amber-900/20 p-3 text-sm">
          <div className="flex items-center justify-between text-amber-900 dark:text-amber-100">
            <span className="font-medium">{activeOp.opType}: {activeOp.state}</span>
            <span className="text-xs">{activeOp.progressPct}%</span>
          </div>
          {activeOp.progressMessage && <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">{activeOp.progressMessage}</p>}
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-amber-200 dark:bg-amber-900/40">
            <div className="h-full bg-amber-600 transition-all" style={{ width: `${activeOp.progressPct}%` }} />
          </div>
        </div>
      )}

      {!activeOp && recentOp && recentOp.state === 'failed' && (
        <div className="mb-3 rounded-md bg-red-50 dark:bg-red-900/20 p-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-medium text-red-800 dark:text-red-200">Last {recentOp.opType} failed</div>
              {recentOp.lastError && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{recentOp.lastError}</p>}
            </div>
            {lifecycleState === 'failed' && (
              <button
                onClick={() => {
                  if (confirm("Reset this client's storage state back to 'idle'? The failed operation's log is kept for debugging.")) {
                    clearFailed.mutate(clientId);
                  }
                }}
                disabled={clearFailed.isPending}
                className="shrink-0 rounded-md border border-red-300 dark:border-red-700 bg-white dark:bg-gray-900 px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-50"
                data-testid="lifecycle-clear-failed-button"
              >
                {clearFailed.isPending ? 'Clearing…' : 'Reset to idle'}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={onSnapshot}
          disabled={isBusy}
          className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
          data-testid="lifecycle-snapshot-button"
        >
          Take snapshot
        </button>
        <button
          onClick={onResize}
          disabled={isBusy || client.status === 'archived' || client.status === 'suspended'}
          className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
          data-testid="lifecycle-resize-button"
        >
          Resize storage…
        </button>
        {client.status !== 'suspended' && client.status !== 'archived' && (
          <button
            onClick={onSuspend}
            disabled={isBusy}
            className="rounded-md border border-orange-200 dark:border-orange-800 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-orange-700 dark:text-orange-300 hover:bg-orange-50 dark:hover:bg-orange-900/20 disabled:opacity-50"
          >
            Suspend
          </button>
        )}
        {client.status === 'suspended' && (
          <button
            onClick={onResume}
            disabled={isBusy}
            className="rounded-md border border-green-200 dark:border-green-800 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-green-700 dark:text-green-300 hover:bg-green-50 dark:hover:bg-green-900/20 disabled:opacity-50"
          >
            Resume
          </button>
        )}
        {client.status !== 'archived' && (
          <button
            onClick={onArchive}
            disabled={isBusy}
            className="rounded-md border border-red-200 dark:border-red-800 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
          >
            Archive
          </button>
        )}
        {client.status === 'archived' && (
          <button
            onClick={onRestore}
            disabled={isBusy}
            className="rounded-md border border-blue-200 dark:border-blue-800 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-50"
          >
            Restore
          </button>
        )}
      </div>

      {/* Inline error banner — shown when a lifecycle op rejects synchronously. */}
      {opError && (
        <div
          role="alert"
          className="mt-3 rounded-md bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-800 dark:text-red-200 flex items-start gap-2"
          data-testid="lifecycle-error-banner"
        >
          <span className="flex-1 whitespace-pre-wrap">{opError}</span>
          <button
            onClick={() => setOpError(null)}
            className="shrink-0 text-red-400 hover:text-red-600 dark:hover:text-red-300"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Resize modal — replaces the legacy prompt()+confirm() chain. */}
      <ResizeStorageModal
        clientId={clientId}
        open={resizeOpen}
        initialMib={currentMib}
        onClose={() => setResizeOpen(false)}
        onStarted={trackOp}
      />

      {/* Shared progress modal — mounts once per op started from this card. */}
      <OperationProgressModal
        operationId={trackedOpId}
        onClose={() => setTrackedOpId(null)}
      />
    </div>
  );
}

/**
 * Placement card — tenant worker pin + storage tier + "migrate now"
 * action. The pin change (via useUpdateClient) only records intent;
 * the migrate action flips the pin AND triggers a rollout-restart on
 * every Deployment in the client's namespace so pods actually move.
 *
 * Surfaces the ADR-031 distinction between "re-pin for future
 * deploys" (cheap, immediate) and "rebalance running workloads"
 * (intentional, has downtime).
 */
function PlacementCard({ clientId, client }: {
  readonly clientId: string;
  readonly client: { workerNodeName?: string | null; storageTier?: 'local' | 'ha' };
}) {
  const update = useUpdateClient(clientId);
  const migrate = useMigrateClientToWorker(clientId);
  const { data: nodesData } = useClusterNodes();
  const nodes = (nodesData?.data ?? []).filter((n) => n.canHostClientWorkloads);

  const [pinTarget, setPinTarget] = useState<string>(client.workerNodeName ?? '');
  const [tierTarget, setTierTarget] = useState<'local' | 'ha'>(client.storageTier ?? 'local');

  const currentWorker = client.workerNodeName ?? '(scheduler picks)';
  const hasChanges = (pinTarget || null) !== (client.workerNodeName ?? null) || tierTarget !== (client.storageTier ?? 'local');

  const saveChanges = async () => {
    try {
      await update.mutateAsync({
        worker_node_name: pinTarget === '' ? null : pinTarget,
        storage_tier: tierTarget,
      });
    } catch {
      // error surfaced via update.error below
    }
  };

  const migrateNow = async () => {
    if (!pinTarget) return;
    try {
      await migrate.mutateAsync(pinTarget);
    } catch {
      // error surfaced via migrate.error below
    }
  };

  const migrateErr = migrate.error as { message?: string } | null;
  const updateErr = update.error as { message?: string } | null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Placement</h2>
        <span className="text-xs text-gray-500 dark:text-gray-400">Current worker: <span className="font-mono text-gray-700 dark:text-gray-300">{currentWorker}</span></span>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Worker pin</label>
          <select
            value={pinTarget}
            onChange={(e) => setPinTarget(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            data-testid="placement-worker-select"
          >
            <option value="">Default scheduler (any tenant-capable node)</option>
            {nodes.map((n) => (
              <option key={n.name} value={n.name}>
                {n.name} — {n.role}
                {n.cpuMillicores ? ` · ${(n.cpuMillicores / 1000).toFixed(1)} cores` : ''}
                {n.memoryBytes ? ` · ${(n.memoryBytes / 1024 ** 3).toFixed(0)}GiB` : ''}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Storage tier</label>
          <select
            value={tierTarget}
            onChange={(e) => setTierTarget(e.target.value as 'local' | 'ha')}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            data-testid="placement-tier-select"
          >
            <option value="local">Local (1 replica)</option>
            <option value="ha">HA (2 replicas)</option>
          </select>
          {tierTarget !== (client.storageTier ?? 'local') && client.workerNodeName && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              Tier changes only affect new PVCs. Existing volume keeps its class until a storage migration runs.
            </p>
          )}
        </div>
      </div>

      {(updateErr || migrateErr) && (
        <p className="mt-3 text-xs text-red-600 dark:text-red-400">
          {(updateErr ?? migrateErr)?.message}
        </p>
      )}

      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={saveChanges}
          disabled={!hasChanges || update.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
          data-testid="placement-save-button"
        >
          {update.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save intent
        </button>
        <button
          type="button"
          onClick={migrateNow}
          disabled={!pinTarget || migrate.isPending}
          title={!pinTarget ? 'Pick a worker first' : 'Applies the pin AND restarts pods so they move now'}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="placement-migrate-button"
        >
          {migrate.isPending ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
          Migrate pods now
        </button>
      </div>

      {migrate.isSuccess && migrate.data && (
        <p className="mt-2 text-xs text-green-600 dark:text-green-400">
          Migrated — restarted {migrate.data.data.deploymentsRestarted} deployment(s).
        </p>
      )}
    </div>
  );
}

const FINDING_LABEL: Record<IntegrityFinding, string> = {
  namespace_missing: 'Namespace missing',
  pvc_missing: 'Tenant PVC missing',
  resource_quota_missing: 'ResourceQuota missing',
  network_policy_missing: 'NetworkPolicies missing',
};

function NamespaceIntegrityBanner({ clientId }: { readonly clientId: string }) {
  const { data, isLoading } = useClientNamespaceIntegrity(clientId);
  const repair = useRepairClientNamespace(clientId);
  const report = data?.data;

  if (isLoading || !report) return null;
  // Defensive — when the test harness or an in-flight rollout supplies a
  // partial payload, treat missing arrays as empty so the banner never
  // blows up the whole detail page.
  const stillBroken = report.findings ?? [];
  const justRepaired = repair.data?.data.repaired ?? [];
  const repairErrors = repair.data?.data.errors ?? [];

  if (stillBroken.length === 0 && justRepaired.length === 0 && repairErrors.length === 0 && !repair.error) {
    // Healthy + nothing repaired this session — render nothing to keep the page tight.
    return null;
  }
  const tone = stillBroken.length > 0
    ? 'border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-900/20'
    : 'border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-900/20';

  return (
    <div className={`rounded-xl border p-4 text-sm ${tone}`} data-testid="namespace-integrity-banner">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {stillBroken.length > 0 ? (
            <AlertCircle size={18} className="mt-0.5 shrink-0 text-red-600 dark:text-red-400" />
          ) : (
            <CheckCircle size={18} className="mt-0.5 shrink-0 text-green-600 dark:text-green-400" />
          )}
          <div>
            <div className="font-semibold text-gray-900 dark:text-gray-100">
              {stillBroken.length > 0 ? 'Namespace integrity issues detected' : 'Namespace integrity restored'}
            </div>
            {stillBroken.length > 0 && (
              <p className="mt-0.5 text-xs text-red-800 dark:text-red-300">
                The reconciler will retry every 30 minutes. You can also run it now.
              </p>
            )}
            {stillBroken.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs">
                {stillBroken.map((f) => (
                  <li key={f} className="text-red-800 dark:text-red-300">• {FINDING_LABEL[f]}</li>
                ))}
              </ul>
            )}
            {justRepaired.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs">
                {justRepaired.map((f) => (
                  <li key={`r-${f}`} className="text-green-800 dark:text-green-300">✓ Repaired: {FINDING_LABEL[f]}</li>
                ))}
              </ul>
            )}
            {repairErrors.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-xs">
                {repairErrors.map((e, i) => (
                  <li key={`e-${i}`} className="font-mono text-red-700 dark:text-red-400">{e}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={() => repair.mutate()}
          disabled={repair.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="namespace-integrity-repair-button"
        >
          {repair.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Run reconciler
        </button>
      </div>
    </div>
  );
}
