import { Fragment, useState, type FormEvent } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { config } from '@/lib/runtime-config';
import { ArrowLeft, Edit, Pause, Play, Trash2, Loader2, CreditCard, Save, UserCheck, Cpu, ToggleLeft, ToggleRight, Rocket, ServerCrash, FolderOpen, Mail, RefreshCw, Copy, CheckCircle, AlertCircle, AlertTriangle } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import EditClientModal from '@/components/EditClientModal';
import DeleteConfirmDialog from '@/components/DeleteConfirmDialog';
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
import { useWorkerUsageSummary, type WorkerUsage } from '@/hooks/use-worker-usage';
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
  // useResizeClient: still wired into ResourceLimitsCard so the
  // destructive-shrink confirmation can fire POST /storage/resize
  // when the operator confirms the dialog. Suspend/Resume/Archive/
  // Restore hooks are intentionally NOT imported here — those
  // transitions are now driven exclusively by the status dropdown
  // (PATCH /clients/:id with status=…), which dispatches into the
  // same orchestrators on the backend.
  useResizeClient,
  useStorageOperations,
  useClearFailedState,
  useClientStoragePlacement,
  useFsckCheck,
  useFsckRepair,
} from '@/hooks/use-storage-lifecycle';
import { useTableSearch } from '@/hooks/use-table-search';
import ErrorPanel from '@/components/ErrorPanel';

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
  // Op id surfaced when a status PATCH triggered a storage-lifecycle
  // orchestrator (archive, restore-from-archive). Quiesce/unquiesce
  // for plain suspend/active is synchronous today and won't return
  // an op id; the StorageLifecycleCard's local progress strip still
  // shows that path.
  const [statusOpId, setStatusOpId] = useState<string | null>(null);

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
      const res = await updateClient.mutateAsync({ status: 'suspended' });
      const opId = res?.data?.storageArchiveOperationId
        ?? res?.data?.storageRestoreOperationId
        ?? null;
      if (opId) setStatusOpId(opId);
    } catch {
      // silently handled — status badge will reflect current state
    }
  };

  const handleReactivate = async () => {
    if (!id) return;
    // From archived → active is a destructive restore. Confirm explicitly.
    if (client?.status === 'archived') {
      const ok = confirm(
        'Restore this client from the pre-archive snapshot?\n\n'
        + 'Workloads were deleted at archive time and will need to be redeployed after restore. '
        + 'The PVC will be recreated and data restored from the snapshot. '
        + 'Estimated time: a few minutes per GiB of stored data.\n\n'
        + 'Continue?',
      );
      if (!ok) return;
    }
    try {
      const res = await updateClient.mutateAsync({ status: 'active' });
      const opId = res?.data?.storageRestoreOperationId
        ?? res?.data?.storageArchiveOperationId
        ?? null;
      if (opId) setStatusOpId(opId);
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
                <LifecycleStatusControl
                  client={client}
                  clientId={id!}
                  onOpStarted={(opId) => setStatusOpId(opId)}
                />
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

      {/* Shared progress modal for status-driven lifecycle ops
          (archive, restore-from-archive). Suspend/resume run a
          synchronous cascade today and don't return an op id. */}
      <OperationProgressModal
        operationId={statusOpId}
        onClose={() => setStatusOpId(null)}
      />
    </div>
  );
}

/**
 * Editable status dropdown that drives the full client lifecycle.
 *
 * Status transitions:
 *   active   ↔ suspended         — synchronous cascade (no op id today)
 *   *        →  archived         — archiveClient orchestrator
 *                                  (final snapshot then delete workloads/PVC).
 *                                  Inline retention input controls how long
 *                                  the pre-archive snapshot is kept.
 *   archived →  active           — restoreArchivedClient orchestrator
 *                                  (recreate PVC + restore data from snapshot).
 *
 * The orchestrator paths return an opId via PATCH response; the parent
 * surfaces it in OperationProgressModal so the operator can watch
 * progress live. Suspend/resume flips remain a fire-and-forget cascade.
 */
function LifecycleStatusControl({
  client,
  clientId,
  onOpStarted,
}: {
  readonly client: import('@/types/api').Client;
  readonly clientId: string;
  readonly onOpStarted: (opId: string) => void;
}) {
  const updateClient = useUpdateClient(clientId);
  const [editing, setEditing] = useState(false);
  // Selected next status. Stays in local state so the operator can
  // type a retention value before confirming.
  const [pending, setPending] = useState<'active' | 'suspended' | 'archived'>(client.status as 'active' | 'suspended' | 'archived');
  const [retentionDays, setRetentionDays] = useState<number>(90);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const startEdit = () => {
    setPending(client.status as 'active' | 'suspended' | 'archived');
    setRetentionDays(90);
    setSubmitError(null);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setSubmitError(null);
  };

  const apply = async () => {
    setSubmitError(null);

    // Restoring from archived is destructive (pre-archive snapshot
    // restore, workloads need redeploy). Confirm explicitly.
    if (client.status === 'archived' && pending === 'active') {
      const ok = confirm(
        'Restore this client from the pre-archive snapshot?\n\n'
        + 'Workloads were deleted at archive time and will need to be redeployed after restore. '
        + 'The PVC will be recreated and data restored from the snapshot. '
        + 'Estimated time: a few minutes per GiB of stored data.\n\n'
        + 'Continue?',
      );
      if (!ok) return;
    }

    // Archiving is destructive (mailboxes, aliases, deployments, PVC).
    // Confirm explicitly.
    if (pending === 'archived' && client.status !== 'archived') {
      const ok = confirm(
        `Archive this client?\n\n`
        + `A final pre-archive snapshot will be taken and retained for ${retentionDays} day(s). `
        + `All mailboxes, aliases, deployments, and the live PVC will be deleted. `
        + `The client can be restored from the snapshot any time before retention expires.\n\n`
        + 'Continue?',
      );
      if (!ok) return;
    }

    try {
      const payload: import('@k8s-hosting/api-contracts').UpdateClientInput = { status: pending };
      if (pending === 'archived' && client.status !== 'archived') {
        payload.archive_retention_days = retentionDays;
      }
      const res = await updateClient.mutateAsync(payload);
      const opId = res?.data?.storageArchiveOperationId
        ?? res?.data?.storageRestoreOperationId
        ?? null;
      if (opId) onOpStarted(opId);
      setEditing(false);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <StatusBadge status={client.status} />
        <button
          type="button"
          onClick={startEdit}
          className="rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
          data-testid="lifecycle-status-edit"
          title="Change client lifecycle status"
        >
          Change…
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="lifecycle-status-editor">
      <select
        value={pending}
        onChange={(e) => setPending(e.target.value as 'active' | 'suspended' | 'archived')}
        className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm text-gray-900 dark:text-gray-100"
        data-testid="lifecycle-status-select"
      >
        <option value="active">Active</option>
        <option value="suspended">Suspended</option>
        <option value="archived">Archived</option>
      </select>

      {pending === 'archived' && client.status !== 'archived' && (
        <div className="space-y-1">
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
            Snapshot retention (days)
          </label>
          <input
            type="number"
            min={1}
            max={365}
            value={retentionDays}
            onChange={(e) => setRetentionDays(Math.max(1, Math.min(365, Number(e.target.value) || 90)))}
            className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-sm text-gray-900 dark:text-gray-100"
            data-testid="lifecycle-archive-retention-input"
          />
          <p className="text-[11px] text-gray-500 dark:text-gray-400">
            Days to retain the pre-archive snapshot for restore. After this window, restore is no longer possible.
          </p>
        </div>
      )}

      {pending === 'active' && client.status === 'archived' && (
        <p className="text-[11px] text-blue-700 dark:text-blue-300">
          This restores the client from the pre-archive snapshot. Workloads were deleted at archive time and will need to be redeployed after restore.
        </p>
      )}

      {submitError && (
        <p className="text-xs text-red-600 dark:text-red-400" role="alert" data-testid="lifecycle-status-error">{submitError}</p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={apply}
          disabled={updateClient.isPending || pending === client.status}
          className="inline-flex items-center gap-1 rounded-md bg-brand-500 px-3 py-1 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="lifecycle-status-apply"
        >
          {updateClient.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          Apply
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={updateClient.isPending}
          className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-1 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
          data-testid="lifecycle-status-cancel"
        >
          Cancel
        </button>
      </div>
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

  const items = (data?.data ?? []) as readonly Deployment[];
  const search = useTableSearch(items, ['name', 'type', 'status', 'currentNodeName'] as ReadonlyArray<keyof Deployment>);
  const { sortedData: sortedItems, sortKey, sortDirection, onSort } = useSortable(search.filteredData, 'name');

  if (isLoading) return <TabLoading />;
  if (error) return <TabError message="Failed to load deployments." />;
  if (items.length === 0) return <TabEmpty resource="deployments" />;

  return (
    <div>
      <div className="mb-3 flex items-center justify-end">
        <input
          type="search"
          value={search.query}
          onChange={(e) => search.setQuery(e.target.value)}
          placeholder="Search by name, type, status, node…"
          className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1 text-sm"
          data-testid="deployments-search"
        />
      </div>
      <table className="w-full text-left text-sm" data-testid="deployments-table">
      <thead>
        <tr className="border-b border-gray-100 dark:border-gray-700 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
          <SortableHeader label="Name" sortKey="name" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Type" sortKey="type" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
          <SortableHeader label="Node" sortKey="currentNodeName" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
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
          // Try to parse lastError as the OperatorError envelope (JSON
          // produced by the status-reconciler since the error-standard
          // change). Fall back to plain string for legacy rows.
          let envelope: import('@k8s-hosting/api-contracts').OperatorError | null = null;
          let plainDetail = '';
          if (d.lastError && d.lastError.trim()) {
            try {
              const parsed = JSON.parse(d.lastError);
              if (parsed && typeof parsed === 'object' && parsed.code && parsed.title) {
                envelope = parsed as import('@k8s-hosting/api-contracts').OperatorError;
              } else {
                plainDetail = d.lastError;
              }
            } catch {
              plainDetail = d.lastError;
            }
          }
          if (!envelope && !plainDetail) plainDetail = (d.statusMessage ?? '').trim();
          const detailTone = d.status === 'failed'
            ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'
            : 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300';
          return (
            <Fragment key={d.id}>
              <tr className="border-b border-gray-50 dark:border-gray-700">
                <td className="py-2 font-medium text-gray-900 dark:text-gray-100">{d.name}</td>
                <td className="py-2 text-gray-600 dark:text-gray-400">{d.type}</td>
                <td className="py-2 font-mono text-gray-700 dark:text-gray-300">{d.currentNodeName ?? <span className="text-gray-400">—</span>}</td>
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
              {envelope && (
                <tr data-testid={`deployment-${d.id}-detail`}>
                  <td colSpan={9} className="px-3 py-1.5">
                    <ErrorPanel
                      error={envelope}
                      severity={d.status === 'failed' ? 'error' : 'warn'}
                      compact
                      onRetry={d.status === 'failed' ? () => restartDeployment.mutate(d.id) : undefined}
                      retryPending={restartDeployment.isPending}
                    />
                  </td>
                </tr>
              )}
              {!envelope && plainDetail && (
                <tr className={detailTone} data-testid={`deployment-${d.id}-detail`}>
                  <td colSpan={9} className="px-3 py-1.5 text-xs">
                    <span className="font-medium">{d.status === 'failed' ? 'Error: ' : 'Status: '}</span>
                    {plainDetail}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
    {search.query && search.filteredData.length === 0 && (
      <p className="mt-2 text-xs text-gray-500 italic">No deployments match &quot;{search.query}&quot;.</p>
    )}
    </div>
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
  // When PATCH /clients/:id auto-triggers an online-grow, the response
  // includes storageGrowOperationId. Open the shared progress modal so
  // the operator can watch growing_pvc → growing_filesystem → idle live.
  const [growOpId, setGrowOpId] = useState<string | null>(null);
  // Shrink path: PATCH rejects with STORAGE_RESIZE_REQUIRED. We surface
  // a confirmation dialog with the OperatorError remediation, then call
  // the explicit destructive resize endpoint when the operator confirms.
  // shrinkPending captures the target MiB while the dialog is open so
  // we can fire the resize call on confirm without re-prompting.
  const [shrinkPending, setShrinkPending] = useState<{
    targetMib: number;
    targetGi: number;
    currentGi: number;
    remediation: string;
  } | null>(null);
  const resizeStorage = useResizeClient();

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
      const result = await updateClient.mutateAsync({
        cpu_limit_override: cpuCustom ? Number(cpuOverride) : null,
        memory_limit_override: memCustom ? Number(memOverride) : null,
        storage_limit_override: storageCustom ? Number(storageOverride) : null,
        max_sub_users_override: subUsersCustom ? Number(subUsersOverride) : null,
        max_mailboxes_override: mailboxesCustom ? Number(mailboxesOverride) : null,
        monthly_price_override: priceCustom ? Number(priceOverride) : null,
      });
      // If the PATCH grew storage online, the backend kicked off a
      // storage-lifecycle op and surfaces its id here.
      const opId = (result as { data?: { storageGrowOperationId?: string | null } })?.data?.storageGrowOperationId;
      if (opId) setGrowOpId(opId);
      setEditing(false);
    } catch (err) {
      // Shrink-path: backend rejects with STORAGE_RESIZE_REQUIRED. We
      // surface a destructive-resize confirmation; on Confirm we fire
      // the dedicated /storage/resize endpoint (no PATCH retry, since
      // the destructive flow is opt-in by design).
      const apiErr = err as { code?: string; details?: { targetMib?: number; targetGi?: number; currentGi?: number; remediation?: string } };
      if (apiErr?.code === 'STORAGE_RESIZE_REQUIRED' && apiErr.details?.targetMib != null) {
        setShrinkPending({
          targetMib: apiErr.details.targetMib,
          targetGi: apiErr.details.targetGi ?? Math.round(apiErr.details.targetMib / 102.4) / 10,
          currentGi: apiErr.details.currentGi ?? Number(client.storageLimitOverride ?? 0),
          remediation: apiErr.details.remediation ?? 'This is a destructive resize: the platform takes a snapshot, drops the PVC, recreates at the smaller size, and restores from the snapshot.',
        });
        // Keep the form open so the operator sees the value they typed.
      }
      // Other errors render via updateClient.error below.
    }
  };

  const confirmDestructiveShrink = async () => {
    if (!shrinkPending) return;
    try {
      const res = await resizeStorage.mutateAsync({ clientId, newMib: shrinkPending.targetMib });
      setGrowOpId(res.data.operationId);
      setShrinkPending(null);
      setEditing(false);
    } catch (err) {
      // Surface inline — the dialog stays open so the operator can read
      // the failure (e.g. orchestrator already busy, no snapshot store).
      const msg = err instanceof Error ? err.message : String(err);
      setShrinkPending({ ...shrinkPending, remediation: `${shrinkPending.remediation}\n\nFailed: ${msg}` });
    }
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

      {/* Online-grow progress modal — opens when the PATCH response
          carries a storageGrowOperationId. Polls the storage-lifecycle
          op record and shows resizing → restoring → idle live so
          operators don't have to wonder if the bump took effect. */}
      <OperationProgressModal
        operationId={growOpId}
        title="Storage grow"
        onClose={() => setGrowOpId(null)}
      />

      {/* Destructive shrink confirmation. Opens when PATCH rejected
          the storage_limit_override write with STORAGE_RESIZE_REQUIRED.
          Confirm fires POST /admin/clients/:id/storage/resize, which
          quiesces, snapshots, drops the PVC, recreates at the smaller
          size, and restores. The shrink op id then opens the existing
          OperationProgressModal so the operator can watch the dance. */}
      {shrinkPending && (
        <div
          className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4"
          data-testid="shrink-confirm-modal"
          onClick={(e) => { if (e.target === e.currentTarget && !resizeStorage.isPending) setShrinkPending(null); }}
        >
          <div className="w-full max-w-lg rounded-xl bg-white dark:bg-gray-800 shadow-xl">
            <div className="border-b border-red-200 dark:border-red-700/40 bg-red-50 dark:bg-red-900/20 px-5 py-3">
              <h3 className="text-base font-semibold text-red-800 dark:text-red-200 flex items-center gap-2">
                <AlertCircle size={18} />
                Destructive storage shrink
              </h3>
            </div>
            <div className="p-5 space-y-3 text-sm text-gray-700 dark:text-gray-300">
              <p>
                You are shrinking storage from <strong>{shrinkPending.currentGi} GiB</strong> to <strong>{shrinkPending.targetGi} GiB</strong>.
              </p>
              <p className="whitespace-pre-wrap">{shrinkPending.remediation}</p>
              <p>
                This is destructive: the platform takes a snapshot, drops the PVC, recreates at the smaller size, and restores from the snapshot.
                <strong> Estimated downtime: a few minutes per GiB.</strong>
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-100 dark:border-gray-700 px-5 py-3">
              <button
                type="button"
                onClick={() => setShrinkPending(null)}
                disabled={resizeStorage.isPending}
                className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50"
                data-testid="shrink-confirm-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDestructiveShrink}
                disabled={resizeStorage.isPending}
                className="inline-flex items-center gap-1 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                data-testid="shrink-confirm-button"
              >
                {resizeStorage.isPending ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}
                Continue with destructive resize
              </button>
            </div>
          </div>
        </div>
      )}
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
  // Storage Operations card (formerly "Storage Lifecycle"). After the
  // collapse, lifecycle transitions (suspend / resume / archive /
  // restore / resize) are driven from the client row itself: status
  // dropdown for suspend/archive/restore, ResourceLimitsCard for grow,
  // ResourceLimitsCard's destructive-shrink dialog for shrink. The
  // standalone buttons that lived here were redundant — they all
  // hit the same orchestrators.
  //
  // What stays here:
  //   • PVC placement table (read-only health surface)
  //   • Active / recent op progress (live readout while a lifecycle
  //     transition started elsewhere is running)
  //   • Manual snapshot button (orthogonal to lifecycle — operator
  //     wants ad-hoc backups without a status flip)
  //   • Reset-to-idle (recovery valve when an op left state=failed)
  const opsQuery = useStorageOperations(clientId);
  const snapshot = useCreateSnapshot();
  const clearFailed = useClearFailedState();

  const ops = opsQuery.data?.data ?? [];
  const activeOp = ops.find((o) => o.state !== 'idle' && o.state !== 'failed' && !o.completedAt);
  const recentOp = ops[0];
  const lifecycleState = client.storageLifecycleState ?? 'idle';
  const isBusy = lifecycleState !== 'idle' || !!activeOp || snapshot.isPending;

  const [trackedOpId, setTrackedOpId] = useState<string | null>(null);
  const [opError, setOpError] = useState<string | null>(null);

  const trackOp = (operationId: string) => { setTrackedOpId(operationId); setOpError(null); };
  const surfaceError = (err: unknown) => {
    setOpError(err instanceof Error ? err.message : String(err));
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
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Storage Operations</h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            PVC placement and live op status. Lifecycle transitions
            (suspend / archive / restore) are driven by the client
            <span className="font-medium"> Status</span> dropdown above;
            grow/shrink by the
            <span className="font-medium"> Resource Limits</span> card.
          </p>
        </div>
        <div className="text-right text-xs">
          <div className="text-gray-500 dark:text-gray-400">Lifecycle state</div>
          <div className={`mt-0.5 rounded px-2 py-0.5 font-mono ${lifecycleState === 'idle' ? 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200'}`}>
            {lifecycleState}
          </div>
        </div>
      </div>

      <PvcPlacementSection clientId={clientId} />

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

      {!activeOp && recentOp && recentOp.state === 'failed' && (() => {
        // Try to parse lastError as the structured OperatorError envelope.
        let envelope: import('@k8s-hosting/api-contracts').OperatorError | null = null;
        let plainDetail = '';
        if (recentOp.lastError && recentOp.lastError.trim()) {
          try {
            const parsed = JSON.parse(recentOp.lastError);
            if (parsed && typeof parsed === 'object' && parsed.code && parsed.title) {
              envelope = parsed as import('@k8s-hosting/api-contracts').OperatorError;
            } else {
              plainDetail = recentOp.lastError;
            }
          } catch {
            plainDetail = recentOp.lastError;
          }
        }
        const showClearButton = lifecycleState === 'failed';
        const clearButton = showClearButton ? (
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
        ) : null;

        if (envelope) {
          return (
            <div className="mb-3">
              <div className="mb-1 text-xs font-medium text-red-800 dark:text-red-200">
                Last {recentOp.opType} failed
              </div>
              <ErrorPanel
                error={envelope}
                severity="error"
                testId="lifecycle-error-panel"
              />
              {clearButton && <div className="mt-2 flex justify-end">{clearButton}</div>}
            </div>
          );
        }
        return (
          <div className="mb-3 rounded-md bg-red-50 dark:bg-red-900/20 p-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium text-red-800 dark:text-red-200">Last {recentOp.opType} failed</div>
                {plainDetail && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{plainDetail}</p>}
              </div>
              {clearButton}
            </div>
          </div>
        );
      })()}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={onSnapshot}
          disabled={isBusy}
          className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
          data-testid="lifecycle-snapshot-button"
        >
          Take snapshot
        </button>
      </div>

      {/* Inline error banner — shown when the snapshot op rejects synchronously. */}
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

      {/* Shared progress modal — opens for the manual snapshot started here. */}
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
/**
 * Render "free / total" CPU + RAM + Disk for the worker selector
 * dropdown. Returns an empty string when usage data is unavailable so
 * the option still shows the bare node name. Examples:
 *   " — 3.2/6 CPUs · 6.5/8 GB RAM · 60/80 GB disk available"
 *   ""   (usage not yet loaded)
 */
function formatAvailability(usage: WorkerUsage | undefined): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.cpuMillicoresAllocatable != null && usage.cpuMillicoresUsed != null) {
    const total = usage.cpuMillicoresAllocatable / 1000;
    const free = Math.max(0, (usage.cpuMillicoresAllocatable - usage.cpuMillicoresUsed) / 1000);
    parts.push(`${free.toFixed(2)}/${total.toFixed(0)} CPUs`);
  }
  if (usage.memoryBytesAllocatable != null && usage.memoryBytesUsed != null) {
    const total = usage.memoryBytesAllocatable / 1024 ** 3;
    const free = Math.max(0, (usage.memoryBytesAllocatable - usage.memoryBytesUsed) / 1024 ** 3);
    parts.push(`${free.toFixed(1)}/${total.toFixed(0)} GB RAM`);
  }
  if (usage.diskBytesTotal != null && usage.diskBytesFree != null) {
    const total = usage.diskBytesTotal / 1024 ** 3;
    const free = usage.diskBytesFree / 1024 ** 3;
    parts.push(`${free.toFixed(0)}/${total.toFixed(0)} GB disk`);
  }
  return parts.length > 0 ? ` — ${parts.join(' · ')} available` : '';
}

function PlacementCard({ clientId, client }: {
  readonly clientId: string;
  readonly client: { workerNodeName?: string | null; storageTier?: 'local' | 'ha' };
}) {
  const update = useUpdateClient(clientId);
  const migrate = useMigrateClientToWorker(clientId);
  const { data: nodesData } = useClusterNodes();
  const { data: usageData } = useWorkerUsageSummary();
  const nodes = (nodesData?.data ?? []).filter((n) => n.canHostClientWorkloads);
  const usageByName = new Map((usageData?.data ?? []).map((u) => [u.name, u]));

  const [pinTarget, setPinTarget] = useState<string>(client.workerNodeName ?? '');
  const [tierTarget, setTierTarget] = useState<'local' | 'ha'>(client.storageTier ?? 'local');

  const currentWorker = client.workerNodeName ?? '(Auto — scheduler picks)';
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
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
            Worker node (primary data location)
          </label>
          <select
            value={pinTarget}
            onChange={(e) => setPinTarget(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            data-testid="placement-worker-select"
          >
            <option value="">Auto (recommended — scheduler picks based on capacity)</option>
            {nodes.map((n) => {
              const usage = usageByName.get(n.name);
              return (
                <option key={n.name} value={n.name}>
                  {n.name}
                  {formatAvailability(usage)}
                </option>
              );
            })}
          </select>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Pod and primary Longhorn replica land on the chosen node. Auto picks the node with most free capacity at provisioning.
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Storage tier</label>
          <select
            value={tierTarget}
            onChange={(e) => setTierTarget(e.target.value as 'local' | 'ha')}
            className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            data-testid="placement-tier-select"
          >
            <option value="local">Local — 1 replica · cheaper · restore-from-backup on node loss</option>
            <option value="ha">HA — 2 replicas · auto-failover ~30–90s · 2× storage</option>
          </select>
          {tierTarget !== (client.storageTier ?? 'local') && client.workerNodeName && (
            <p className="mt-1 text-xs text-blue-700 dark:text-blue-400">
              Tier changes are applied live. Replica rebuild runs in the background.
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

/**
 * Storage Lifecycle subsection — shows which cluster node currently
 * holds the client's PVC(s). Operators want this at a glance so they
 * can correlate "client is on staging1" with platform metrics, drains,
 * and capacity plans.
 *
 * Sortable + searchable — same UX as the Deployments tab and admin
 * Installed Applications table.
 */
function PvcPlacementSection({ clientId }: { readonly clientId: string }) {
  const { data, isLoading, error } = useClientStoragePlacement(clientId);
  const opsQuery = useStorageOperations(clientId);
  const fsckCheck = useFsckCheck();
  const fsckRepair = useFsckRepair();
  const [confirmRepair, setConfirmRepair] = useState<{ pvcName: string } | null>(null);
  const [reportOpId, setReportOpId] = useState<string | null>(null);

  const pvcs = data?.data.pvcs ?? [];
  const search = useTableSearch(pvcs, ['pvcName', 'volumeName', 'state', 'robustness', 'fsType']);
  const { sortedData, sortKey, sortDirection, onSort } = useSortable(search.filteredData, 'pvcName');

  // Latest fsck op (any state) — drives the Report modal contents.
  const fsckOps = (opsQuery.data?.data ?? []).filter((o) => o.opType === 'fsck');
  const reportOp = reportOpId ? fsckOps.find((o) => o.id === reportOpId) ?? null : null;

  // In-flight fsck for this client — disables Check/Repair buttons
  // while a quiesce-and-fsck cycle is running.
  const fsckInFlight = fsckOps.find((o) => !o.completedAt && o.state !== 'idle' && o.state !== 'failed');

  if (isLoading) {
    return (
      <div className="mb-3 rounded-md border border-gray-200 dark:border-gray-700 p-3 text-xs text-gray-500 dark:text-gray-400">
        Loading PVC placement…
      </div>
    );
  }
  if (error || pvcs.length === 0) {
    return (
      <div className="mb-3 rounded-md border border-gray-200 dark:border-gray-700 p-3 text-xs text-gray-500 dark:text-gray-400">
        No PVCs found for this client (yet).
      </div>
    );
  }
  return (
    <div className="mb-3 rounded-md border border-gray-200 dark:border-gray-700 p-3" data-testid="pvc-placement-section">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-gray-700 dark:text-gray-300">Persistent volumes ({pvcs.length})</h3>
        <input
          type="search"
          value={search.query}
          onChange={(e) => search.setQuery(e.target.value)}
          placeholder="Search…"
          className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-0.5 text-xs"
          data-testid="pvc-placement-search"
        />
      </div>
      <table className="w-full text-xs">
        <thead className="text-left text-gray-500 dark:text-gray-400">
          <tr>
            <SortableHeader label="PVC" sortKey="pvcName" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="!px-2 !py-1.5 !text-left" />
            <SortableHeader label="Volume" sortKey="volumeName" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="!px-2 !py-1.5 !text-left" />
            <SortableHeader label="FS" sortKey="fsType" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="!px-2 !py-1.5 !text-left" />
            <SortableHeader label="Requested" sortKey="sizeBytes" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="!px-2 !py-1.5 !text-left" />
            <SortableHeader label="Used" sortKey="usedBytes" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="!px-2 !py-1.5 !text-left" />
            <SortableHeader label="State" sortKey="state" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="!px-2 !py-1.5 !text-left" />
            <SortableHeader label="Robustness" sortKey="robustness" currentKey={sortKey} direction={sortDirection} onSort={onSort} className="!px-2 !py-1.5 !text-left" />
            <th className="px-2 py-1.5 text-left font-medium">Replicas</th>
            <th className="px-2 py-1.5 text-left font-medium">Replica node(s)</th>
            <th className="px-2 py-1.5 text-left font-medium">Filesystem</th>
          </tr>
        </thead>
        <tbody>
          {sortedData.map((p) => {
            const replicasOk = p.replicasHealthy >= p.replicasExpected;
            const fsLabel = (p.fsType ?? '—').toLowerCase();
            return (
              <tr key={p.volumeName} className="border-t border-gray-100 dark:border-gray-700">
                <td className="px-2 py-1.5 font-mono">{p.pvcName}</td>
                <td className="px-2 py-1.5 font-mono text-gray-500 dark:text-gray-400">{p.volumeName.slice(0, 12)}…</td>
                <td className="px-2 py-1.5">
                  <span className={fsLabel === 'xfs'
                    ? 'rounded bg-blue-100 px-1 py-0.5 text-[10px] text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
                    : fsLabel === 'ext4' || fsLabel === 'ext3'
                      ? 'rounded bg-purple-100 px-1 py-0.5 text-[10px] text-purple-800 dark:bg-purple-900/40 dark:text-purple-300'
                      : 'rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-700 dark:bg-gray-800 dark:text-gray-300'}
                  >
                    {fsLabel}
                  </span>
                </td>
                <td className="px-2 py-1.5">{p.sizeBytes > 0 ? formatBytes(p.sizeBytes) : '—'}</td>
                <td className="px-2 py-1.5">
                  {p.usedBytes > 0 ? formatBytes(p.usedBytes) : '0 B'}
                  {p.allocatedBytes > 0 && (
                    <span className="ml-1 text-gray-500 dark:text-gray-400">({formatBytes(p.allocatedBytes)})</span>
                  )}
                </td>
                <td className="px-2 py-1.5">{p.state ?? '—'}</td>
                <td className="px-2 py-1.5">
                  <span className={p.robustness === 'healthy'
                    ? 'rounded bg-green-100 px-1 py-0.5 text-[10px] text-green-800 dark:bg-green-900/40 dark:text-green-300'
                    : p.robustness === 'degraded' ? 'rounded bg-amber-100 px-1 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                    : 'rounded bg-gray-100 px-1 py-0.5 text-[10px] text-gray-700 dark:bg-gray-800 dark:text-gray-300'}>
                    {p.robustness ?? '—'}
                  </span>
                </td>
                <td className="px-2 py-1.5">
                  <span className={replicasOk
                    ? 'rounded bg-green-100 px-1 py-0.5 text-[10px] text-green-800 dark:bg-green-900/40 dark:text-green-300'
                    : 'rounded bg-amber-100 px-1 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'}
                  >
                    {p.replicasHealthy}/{p.replicasExpected}
                  </span>
                </td>
                <td className="px-2 py-1.5 font-mono">
                  {p.replicaNodes.length === 0 ? <span className="text-gray-400">—</span> : p.replicaNodes.join(', ')}
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex gap-1">
                    <button
                      type="button"
                      disabled={Boolean(fsckInFlight) || fsckCheck.isPending}
                      onClick={() => {
                        fsckCheck.mutate(clientId, {
                          onSuccess: (resp) => setReportOpId(resp.data.operationId),
                        });
                      }}
                      className="rounded border border-gray-300 dark:border-gray-600 px-1.5 py-0.5 text-[10px] hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
                      data-testid={`fsck-check-${p.pvcName}`}
                      title="Run xfs_repair -n / e2fsck -n on this volume (quiesces tenant)"
                    >
                      Check
                    </button>
                    <button
                      type="button"
                      disabled={Boolean(fsckInFlight) || fsckRepair.isPending}
                      onClick={() => setConfirmRepair({ pvcName: p.pvcName })}
                      className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-1.5 py-0.5 text-[10px] text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 disabled:opacity-50"
                      data-testid={`fsck-repair-${p.pvcName}`}
                      title="Run fsck in REPAIR mode (writes to disk; quiesces tenant)"
                    >
                      Repair
                    </button>
                  </div>
                  {p.engineConditions.length > 0 && (
                    <div className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">
                      {p.engineConditions.map((c) => c.type).join(', ')}
                    </div>
                  )}
                  {p.lastBackupAt && (
                    <div className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400" title={p.lastBackupAt}>
                      backup: {new Date(p.lastBackupAt).toISOString().slice(0, 10)}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {search.query && search.filteredData.length === 0 && (
        <p className="mt-2 text-xs text-gray-500 italic">No PVCs match &quot;{search.query}&quot;.</p>
      )}
      <p className="mt-2 text-[10px] text-gray-500 dark:text-gray-400 italic">
        Used = filesystem-level user-file bytes from kubelet stats. Parenthetical = Longhorn block-level allocation including filesystem metadata + sparse blocks (~230 MiB on an empty 10 GiB ext4 volume; ~40 MiB on XFS).
        Replicas = healthy/desired. Check/Repair quiesce the tenant for the duration of the run.
      </p>

      {fsckCheck.error instanceof Error && (
        <div className="mt-2 rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-800 dark:text-red-300">
          <strong>Failed to start filesystem check:</strong> {fsckCheck.error.message}
        </div>
      )}
      {fsckRepair.error instanceof Error && (
        <div className="mt-2 rounded border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-800 dark:text-red-300">
          <strong>Failed to start filesystem repair:</strong> {fsckRepair.error.message}
        </div>
      )}

      {confirmRepair && (
        <FsckRepairConfirmModal
          pvcName={confirmRepair.pvcName}
          isPending={fsckRepair.isPending}
          onCancel={() => setConfirmRepair(null)}
          onConfirm={() => {
            fsckRepair.mutate(clientId, {
              onSuccess: (resp) => {
                setReportOpId(resp.data.operationId);
                setConfirmRepair(null);
              },
            });
          }}
        />
      )}

      {reportOp && (
        <FsckReportModal
          op={reportOp}
          onClose={() => setReportOpId(null)}
        />
      )}
    </div>
  );
}

function FsckRepairConfirmModal({
  pvcName, isPending, onCancel, onConfirm,
}: {
  readonly pvcName: string;
  readonly isPending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg bg-white dark:bg-gray-900 p-5 shadow-xl">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          Repair filesystem on {pvcName}?
        </h3>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          This will:
        </p>
        <ul className="mt-1 list-disc pl-5 text-sm text-gray-600 dark:text-gray-300">
          <li>Scale all tenant workloads to 0 (downtime)</li>
          <li>Run xfs_repair / e2fsck -y against the raw block device</li>
          <li>Restore workloads after completion</li>
        </ul>
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          On a badly damaged filesystem the repair may move corrupted files into <code>lost+found</code>. Take a snapshot first if the data is critical.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="rounded border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="rounded bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            data-testid="fsck-repair-confirm"
          >
            {isPending ? 'Starting…' : 'Repair filesystem'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FsckReportModal({
  op, onClose,
}: {
  readonly op: { id: string; state: string; progressPct: number; progressMessage: string | null; lastError: string | null; completedAt: string | null };
  readonly onClose: () => void;
}) {
  const inFlight = !op.completedAt && op.state !== 'idle' && op.state !== 'failed';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-3xl rounded-lg bg-white dark:bg-gray-900 p-5 shadow-xl">
        <div className="flex items-start justify-between">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Filesystem check report
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          >
            ✕
          </button>
        </div>
        <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          op {op.id.slice(0, 8)} — state: <span className="font-mono">{op.state}</span>
          {op.completedAt ? ` (completed ${new Date(op.completedAt).toLocaleString()})` : ''}
        </div>
        {inFlight && (
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <div className="h-full bg-blue-500 transition-all" style={{ width: `${op.progressPct}%` }} />
          </div>
        )}
        {op.lastError ? (
          <div className="mt-3">
            <div className="text-xs font-semibold text-red-700 dark:text-red-400">Errors found:</div>
            <pre className="mt-1 max-h-96 overflow-auto rounded bg-gray-50 dark:bg-gray-800 p-2 text-[11px] font-mono whitespace-pre-wrap text-red-800 dark:text-red-300">
              {op.lastError}
            </pre>
          </div>
        ) : op.progressMessage ? (
          <div className="mt-3">
            <div className="text-xs font-semibold text-green-700 dark:text-green-400">Report:</div>
            <pre className="mt-1 max-h-96 overflow-auto rounded bg-gray-50 dark:bg-gray-800 p-2 text-[11px] font-mono whitespace-pre-wrap text-gray-800 dark:text-gray-200">
              {op.progressMessage}
            </pre>
          </div>
        ) : (
          <p className="mt-3 text-xs text-gray-500">Waiting for output…</p>
        )}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
