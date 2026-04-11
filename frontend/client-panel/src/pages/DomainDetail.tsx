import { useState, type FormEvent } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Loader2, AlertCircle, Plus, Trash2, Globe, X,
  CheckCircle, Network, Pencil, Check, RefreshCw, Lock,
  ArrowLeftRight, ArrowDownToLine, ArrowUpFromLine, CheckCircle2, Upload, ShieldCheck,
} from 'lucide-react';
import clsx from 'clsx';
import { useClientContext } from '@/hooks/use-client-context';
import { useDomains, useVerifyDomain, useDeleteDomain, useDnsProviderGroups, useMigrateDomainDns, useDomainDeletePreview } from '@/hooks/use-domains';
import { useIngressRoutes, useCreateIngressRoute, useUpdateIngressRoute, useDeleteIngressRoute } from '@/hooks/use-ingress-routes';
import { useDeployments } from '@/hooks/use-deployments';
import {
  useDnsRecords, useCreateDnsRecord, useUpdateDnsRecord, useDeleteDnsRecord,
  useDnsRecordDiff, usePullDnsRecord, usePushDnsRecord,
  type DnsRecordDiffEntry,
} from '@/hooks/use-dns-records';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';
import { useSslCert, useUploadSslCert, useDeleteSslCert } from '@/hooks/use-ssl-certs';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

type Tab = 'routing' | 'dns' | 'ssl';

export default function DomainDetail() {
  const { domainId } = useParams<{ domainId: string }>();
  const { clientId } = useClientContext();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>('routing');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showMigrateModal, setShowMigrateModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const verifyDomain = useVerifyDomain(clientId ?? undefined);
  const deleteDomain = useDeleteDomain(clientId ?? undefined);
  const migrateDns = useMigrateDomainDns(clientId ?? undefined);
  const { data: groupsData } = useDnsProviderGroups();
  const groups = groupsData?.data ?? [];
  // Round-3: load the cascade preview only when the modal is open so
  // the dashboard doesn't eagerly fetch it for every domain row.
  const deletePreview = useDomainDeletePreview(
    clientId ?? undefined,
    domainId,
    showDeleteModal,
  );

  const { data: domainsData, isLoading } = useDomains(clientId ?? undefined);
  const domain = domainsData?.data?.find((d) => d.id === domainId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20" data-testid="domain-detail-loading">
        <Loader2 size={24} className="animate-spin text-blue-600" />
      </div>
    );
  }

  if (!domain) {
    return (
      <div className="py-20 text-center text-gray-500 dark:text-gray-400" data-testid="domain-not-found">
        <p>Domain not found.</p>
        <Link to="/domains" className="mt-2 text-blue-600 hover:underline">Back to Domains</Link>
      </div>
    );
  }

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'routing', label: 'Routing', icon: <Network size={14} /> },
    { key: 'dns', label: 'DNS Records', icon: <Globe size={14} /> },
    { key: 'ssl', label: 'SSL/TLS', icon: <ShieldCheck size={14} /> },
  ];

  return (
    <div className="space-y-6" data-testid="domain-detail-page">
      <div className="flex items-center gap-3">
        <Link
          to="/domains"
          className="inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          data-testid="back-to-domains"
        >
          <ArrowLeft size={16} />
          Domains
        </Link>
        <span className="text-gray-300 dark:text-gray-600">/</span>
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100" data-testid="domain-name-heading">
          {domain.domainName}
        </h1>
        {(() => {
          const dnsGroupId = (domain as Record<string, unknown>).dnsGroupId as string | null | undefined;
          const groupName = dnsGroupId ? groups.find((g) => g.id === dnsGroupId)?.name : null;
          return (
            <span className="rounded-full bg-indigo-50 dark:bg-indigo-900/20 px-2.5 py-0.5 text-xs font-medium text-indigo-600 dark:text-indigo-400" data-testid="domain-dns-group-badge">
              {groupName ?? 'Default DNS Group'}
            </span>
          );
        })()}
        <div className="ml-auto flex items-center gap-2">
          {groups.length > 1 && (
            <button
              type="button"
              onClick={() => setShowMigrateModal(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-300 dark:border-indigo-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30"
              data-testid="migrate-dns-button"
            >
              <RefreshCw size={14} />
              Migrate DNS
            </button>
          )}
          <button
            type="button"
            onClick={() => verifyDomain.mutate(domainId!)}
            disabled={verifyDomain.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 dark:border-blue-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-50"
            data-testid="verify-dns-button"
          >
            {verifyDomain.isPending ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
            Verify DNS
          </button>
          <button
            type="button"
            onClick={() => setShowDeleteModal(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 dark:border-red-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
            data-testid="delete-domain-button"
          >
            <Trash2 size={14} />
            Delete Domain
          </button>
        </div>
      </div>
      {verifyDomain.isSuccess && verifyDomain.data?.data && (
        <div
          className={clsx(
            'rounded-lg border px-4 py-3 text-sm',
            verifyDomain.data.data.verified
              ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
              : 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300',
          )}
          data-testid="verify-dns-result"
        >
          {verifyDomain.data.data.verified ? 'DNS verification passed.' : 'DNS verification failed.'}
          {verifyDomain.data.data.checks.map((check) => (
            <div key={check.type} className="mt-1 text-xs opacity-80">
              [{check.status.toUpperCase()}] {check.type}: {check.detail}
            </div>
          ))}
        </div>
      )}
      {verifyDomain.isError && (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300" data-testid="verify-dns-error">
          <AlertCircle size={14} className="mr-1 inline" />
          {verifyDomain.error instanceof Error ? verifyDomain.error.message : 'Verification request failed.'}
        </div>
      )}

      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" data-testid="delete-domain-modal">
          <div className="w-full max-w-xl rounded-xl bg-white dark:bg-gray-800 p-6 shadow-xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-red-600 dark:text-red-400">Delete Domain</h3>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              This will permanently delete the following resources. This action cannot be undone.
            </p>

            {/*
              Round-3: dynamic cascade preview. The modal fetches the exact
              list of resources that will be removed via
              GET /api/v1/clients/:cid/domains/:did/delete-preview so clients
              can see every DNS record, mailbox, alias, ingress route, and
              webmail Ingress by name BEFORE they confirm.
            */}
            <div className="mt-4 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/20 p-4" data-testid="delete-preview-list">
              {deletePreview.isLoading && (
                <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
                  <Loader2 size={14} className="animate-spin" />
                  Loading cascade list…
                </div>
              )}
              {deletePreview.isError && (
                <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                  <AlertCircle size={14} />
                  Failed to load cascade preview — delete anyway at your own risk.
                </div>
              )}
              {deletePreview.data?.data && (
                <div className="space-y-3 text-sm">
                  <div className="font-medium text-amber-800 dark:text-amber-200">
                    Cascade summary for {deletePreview.data.data.domainName}
                  </div>

                  {deletePreview.data.data.dnsRecords.length > 0 && (
                    <div data-testid="delete-preview-dns">
                      <div className="font-medium text-gray-700 dark:text-gray-300">
                        {deletePreview.data.data.dnsRecords.length} DNS record(s):
                      </div>
                      <ul className="ml-4 mt-1 list-disc text-xs text-gray-600 dark:text-gray-400">
                        {deletePreview.data.data.dnsRecords.slice(0, 20).map((r) => (
                          <li key={r.id}>
                            {r.type} {r.name ?? '(apex)'}
                          </li>
                        ))}
                        {deletePreview.data.data.dnsRecords.length > 20 && (
                          <li className="italic">
                            …and {deletePreview.data.data.dnsRecords.length - 20} more
                          </li>
                        )}
                      </ul>
                    </div>
                  )}

                  {deletePreview.data.data.emailDomain && (
                    <div data-testid="delete-preview-email">
                      <div className="font-medium text-gray-700 dark:text-gray-300">
                        Email hosting (DKIM keys + configuration)
                      </div>
                      {deletePreview.data.data.emailDomain.mailboxes.length > 0 && (
                        <ul className="ml-4 mt-1 list-disc text-xs text-gray-600 dark:text-gray-400">
                          <li className="font-medium">
                            {deletePreview.data.data.emailDomain.mailboxes.length} mailbox(es):
                          </li>
                          {deletePreview.data.data.emailDomain.mailboxes.slice(0, 10).map((m) => (
                            <li key={m.id} className="ml-4">{m.fullAddress}</li>
                          ))}
                          {deletePreview.data.data.emailDomain.mailboxes.length > 10 && (
                            <li className="ml-4 italic">
                              …and {deletePreview.data.data.emailDomain.mailboxes.length - 10} more
                            </li>
                          )}
                        </ul>
                      )}
                      {deletePreview.data.data.emailDomain.aliases.length > 0 && (
                        <ul className="ml-4 mt-1 list-disc text-xs text-gray-600 dark:text-gray-400">
                          <li className="font-medium">
                            {deletePreview.data.data.emailDomain.aliases.length} alias(es):
                          </li>
                          {deletePreview.data.data.emailDomain.aliases.slice(0, 10).map((a) => (
                            <li key={a.id} className="ml-4">{a.sourceAddress}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {deletePreview.data.data.ingressRoutes.length > 0 && (
                    <div data-testid="delete-preview-routes">
                      <div className="font-medium text-gray-700 dark:text-gray-300">
                        {deletePreview.data.data.ingressRoutes.length} ingress route(s):
                      </div>
                      <ul className="ml-4 mt-1 list-disc text-xs text-gray-600 dark:text-gray-400">
                        {deletePreview.data.data.ingressRoutes.slice(0, 10).map((r) => (
                          <li key={r.id}>{r.hostname}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {deletePreview.data.data.webmailIngressHostname && (
                    <div data-testid="delete-preview-webmail">
                      <div className="font-medium text-gray-700 dark:text-gray-300">
                        Webmail site:
                      </div>
                      <ul className="ml-4 mt-1 list-disc text-xs text-gray-600 dark:text-gray-400">
                        <li>{deletePreview.data.data.webmailIngressHostname}</li>
                      </ul>
                    </div>
                  )}

                  <div className="border-t border-amber-200 dark:border-amber-900/50 pt-2 text-xs text-amber-700 dark:text-amber-300">
                    The DNS zone will also be removed from the authoritative DNS
                    provider(s) and the TLS certificate will be deleted from the
                    cluster.
                  </div>
                </div>
              )}
            </div>

            <div className="mt-4">
              <label htmlFor="delete-confirm-input" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Type <span className="font-mono font-bold text-gray-900 dark:text-gray-100">{domain.domainName}</span> to confirm
              </label>
              <input
                id="delete-confirm-input"
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder={domain.domainName}
                className={INPUT_CLASS + ' mt-1'}
                data-testid="delete-confirm-input"
              />
            </div>
            {deleteDomain.isError && (
              <div className="mt-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                <AlertCircle size={14} />
                {deleteDomain.error instanceof Error ? deleteDomain.error.message : 'Failed to delete domain'}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setShowDeleteModal(false); setDeleteConfirmText(''); }}
                className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600"
                data-testid="delete-cancel-button"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  deleteDomain.mutate(domainId!, {
                    onSuccess: () => {
                      setShowDeleteModal(false);
                      setDeleteConfirmText('');
                      navigate('/domains');
                    },
                  });
                }}
                disabled={deleteConfirmText !== domain.domainName || deleteDomain.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                data-testid="delete-confirm-button"
              >
                {deleteDomain.isPending && <Loader2 size={14} className="animate-spin" />}
                Delete Domain
              </button>
            </div>
          </div>
        </div>
      )}

      {showMigrateModal && (
        <MigrateDnsModal
          domainId={domainId!}
          currentGroupId={(domain as Record<string, unknown>).dnsGroupId as string | null | undefined}
          groups={groups}
          migrateDns={migrateDns}
          onClose={() => setShowMigrateModal(false)}
        />
      )}

      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={clsx(
              'inline-flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              activeTab === tab.key
                ? 'border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200',
            )}
            data-testid={`tab-${tab.key}`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'routing' && <RoutingTab clientId={clientId!} domainId={domainId!} domainName={domain.domainName} dnsMode={domain.dnsMode} />}
      {activeTab === 'dns' && <DnsTab clientId={clientId!} domainId={domainId!} />}
      {activeTab === 'ssl' && <SslTlsTab clientId={clientId!} domainId={domainId!} sslAutoRenew={domain.sslAutoRenew} />}
    </div>
  );
}

// ─── Migrate DNS Modal ────────────────────────────────────────────────────────

function MigrateDnsModal({ domainId, currentGroupId, groups, migrateDns, onClose }: {
  readonly domainId: string;
  readonly currentGroupId: string | null | undefined;
  readonly groups: readonly import('@/hooks/use-domains').DnsProviderGroup[];
  readonly migrateDns: ReturnType<typeof useMigrateDomainDns>;
  readonly onClose: () => void;
}) {
  const [targetGroupId, setTargetGroupId] = useState('');

  const availableGroups = groups.filter((g) => g.id !== currentGroupId);
  const currentGroup = currentGroupId ? groups.find((g) => g.id === currentGroupId) : null;

  const handleMigrate = () => {
    if (!targetGroupId) return;
    migrateDns.mutate(
      { domainId, target_group_id: targetGroupId },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" data-testid="migrate-dns-modal">
      <div className="mx-4 w-full max-w-md rounded-xl bg-white dark:bg-gray-800 p-6 shadow-xl">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Migrate DNS</h3>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          Move this domain from <span className="font-medium text-gray-900 dark:text-gray-100">{currentGroup?.name ?? 'Default Group'}</span> to a different DNS provider group. All DNS records will be synced to the new group.
        </p>
        <div className="mt-4">
          <label htmlFor="target-group-select" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Target Group</label>
          <select
            id="target-group-select"
            value={targetGroupId}
            onChange={(e) => setTargetGroupId(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            data-testid="migrate-target-group-select"
          >
            <option value="">Select a group...</option>
            {availableGroups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}{g.isDefault ? ' (default)' : ''}</option>
            ))}
          </select>
        </div>
        {migrateDns.isError && (
          <div className="mt-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
            <AlertCircle size={14} />
            {migrateDns.error instanceof Error ? migrateDns.error.message : 'Migration failed'}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600"
            data-testid="migrate-cancel-button"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleMigrate}
            disabled={!targetGroupId || migrateDns.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            data-testid="migrate-confirm-button"
          >
            {migrateDns.isPending && <Loader2 size={14} className="animate-spin" />}
            Migrate
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Routing Tab ─────────────────────────────────────────────────────────────

function RoutingTab({ clientId, domainId, domainName, dnsMode }: {
  readonly clientId: string;
  readonly domainId: string;
  readonly domainName: string;
  readonly dnsMode: string;
}) {
  const navigate = useNavigate();
  const { data: routesData, isLoading } = useIngressRoutes(clientId, domainId);
  const { data: deploymentsData } = useDeployments(clientId);
  const createRoute = useCreateIngressRoute(clientId, domainId);
  const updateRoute = useUpdateIngressRoute(clientId, domainId);
  const deleteRoute = useDeleteIngressRoute(clientId, domainId);

  const [newHostname, setNewHostname] = useState('');
  // Round-4 Phase A: confirm-before-delete pattern for ingress routes.
  // Previously a single click deleted the route immediately, which
  // could drop live traffic. Now clicking the trash icon arms a
  // "Confirm" state and a second click performs the delete.
  const [deleteRouteConfirmId, setDeleteRouteConfirmId] = useState<string | null>(null);

  const routes = routesData?.data ?? [];
  const deployments = deploymentsData?.data ?? [];

  const handleAddRoute = (e: FormEvent) => {
    e.preventDefault();
    if (!newHostname) return;
    const form = e.target as HTMLFormElement;
    const pathValue = (form.elements.namedItem('path') as HTMLInputElement)?.value || '/';
    createRoute.mutate({ hostname: newHostname, path: pathValue }, {
      onSuccess: () => setNewHostname(''),
    });
  };

  const handleAssignDeployment = (routeId: string, deploymentId: string | null) => {
    updateRoute.mutate({ routeId, deployment_id: deploymentId });
  };

  const isCname = dnsMode === 'cname';

  return (
    <div className="space-y-6" data-testid="routing-tab">
      <div className="rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 px-4 py-3 text-sm text-blue-800 dark:text-blue-300">
        {isCname ? (
          <p>Add a route for your domain and assign it to a deployed workload. Point your DNS to the CNAME target shown below.</p>
        ) : dnsMode === 'primary' ? (
          <p>Add routes for your domain or subdomains. DNS records are created automatically for primary domains.</p>
        ) : (
          <p>Add routes for hostnames that resolve to the platform. Assign each to a deployed workload.</p>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-4">
          <Loader2 size={16} className="animate-spin text-blue-600" />
          <span className="text-sm text-gray-500">Loading routes...</span>
        </div>
      ) : routes.length === 0 ? (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          No routes configured yet. Add a hostname below to start routing traffic to your workloads.
        </div>
      ) : (() => {
        const showPathColumn = routes.some((r) => {
          const rPath = (r as Record<string, unknown>).path as string | undefined;
          return rPath && rPath !== '/';
        });
        return (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm" data-testid="routes-table">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                <th className="px-4 py-3">Hostname</th>
                {showPathColumn && <th className="px-4 py-3">Path</th>}
                {dnsMode !== 'primary' && <th className="px-4 py-3">CNAME Target</th>}
                <th className="px-4 py-3">Deployment</th>
                <th className="px-4 py-3">TLS</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {routes.map((route) => (
                <tr
                  key={route.id}
                  className="hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer"
                  onClick={() => navigate(`/domains/${domainId}/routes/${route.id}`)}
                  data-testid={`route-row-${route.id}`}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-blue-600 dark:text-blue-400">{route.hostname}</span>
                      {route.isApex ? (
                        <span className="inline-flex rounded bg-amber-50 dark:bg-amber-900/20 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300">apex</span>
                      ) : null}
                    </div>
                  </td>
                  {showPathColumn && (
                    <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">
                      {((route as Record<string, unknown>).path as string) || '/'}
                    </td>
                  )}
                  {dnsMode !== 'primary' && (
                    <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">{route.ingressCname}</td>
                  )}
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <select
                      value={route.deploymentId ?? ''}
                      onChange={(e) => handleAssignDeployment(route.id, e.target.value || null)}
                      className="rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1 text-xs text-gray-900 dark:text-gray-100 focus:border-blue-500 focus:outline-none"
                    >
                      <option value="">Not assigned</option>
                      {deployments.map((d) => (
                        <option key={d.id} value={d.id}>{d.name} ({d.status})</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={clsx(
                        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                        route.tlsMode === 'auto' ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300' :
                        route.tlsMode === 'custom' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' :
                        'bg-gray-100 dark:bg-gray-700 text-gray-500',
                      )}
                      data-testid={`route-tls-badge-${route.id}`}
                    >
                      {route.tlsMode !== 'none' && <Lock size={10} />}
                      {route.tlsMode === 'auto' ? 'Let\'s Encrypt' : route.tlsMode === 'custom' ? 'Custom Cert' : 'No TLS'}
                    </span>
                  </td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    {deleteRouteConfirmId === route.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            deleteRoute.mutate(route.id, {
                              onSuccess: () => setDeleteRouteConfirmId(null),
                            });
                          }}
                          disabled={deleteRoute.isPending}
                          className="rounded-md bg-red-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                          data-testid={`route-delete-confirm-${route.id}`}
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteRouteConfirmId(null)}
                          className="rounded-md border border-gray-200 dark:border-gray-600 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                          data-testid={`route-delete-cancel-${route.id}`}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDeleteRouteConfirmId(route.id)}
                        className="rounded-md p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400"
                        data-testid={`route-delete-${route.id}`}
                        aria-label="Delete route"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        );
      })()}

      <form onSubmit={handleAddRoute} className="flex items-end gap-3" data-testid="add-route-form">
        <div className="flex-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Add Hostname</label>
          <input
            type="text"
            value={newHostname}
            onChange={(e) => setNewHostname(e.target.value)}
            placeholder={isCname ? domainName : `subdomain.${domainName}`}
            className={INPUT_CLASS}
            data-testid="new-hostname-input"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            <span>Path</span>
          </label>
          <input type="text" name="path" defaultValue="/" placeholder="/" className={INPUT_CLASS} data-testid="new-route-path-input" />
          <p className="text-xs text-gray-500 dark:text-gray-400">
            URL path prefix for this route. Use "/" for all traffic, or "/api/" to route only API requests. Must start with "/".
          </p>
        </div>
        <button
          type="submit"
          disabled={!newHostname || createRoute.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {createRoute.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          Add Route
        </button>
      </form>

      {createRoute.error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          <AlertCircle size={16} />
          <span>{createRoute.error instanceof Error ? createRoute.error.message : 'Failed to create route'}</span>
        </div>
      )}
    </div>
  );
}

// ─── DNS Tab ──────────────────────────────────────────────────────────────────

function DnsTab({ clientId, domainId }: { readonly clientId: string; readonly domainId: string }) {
  const { data: response, isLoading, isError } = useDnsRecords(clientId, domainId);
  const createRecord = useCreateDnsRecord(clientId, domainId);
  const updateRecord = useUpdateDnsRecord(clientId, domainId);
  const deleteRecord = useDeleteDnsRecord(clientId, domainId);
  const [showForm, setShowForm] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<{ record_value: string; ttl: number; priority?: number }>({ record_value: '', ttl: 3600 });
  const recordsRaw = response?.data ?? [];
  const { sortedData: records, sortKey, sortDirection, onSort } = useSortable(recordsRaw, 'recordName');

  const [form, setForm] = useState({
    record_type: 'A' as const,
    record_name: '',
    record_value: '',
    ttl: '3600',
  });

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await createRecord.mutateAsync({
        record_type: form.record_type,
        record_name: form.record_name || undefined,
        record_value: form.record_value,
        ttl: Number(form.ttl) || 3600,
      });
      setForm({ record_type: 'A', record_name: '', record_value: '', ttl: '3600' });
      setShowForm(false);
    } catch { /* error via createRecord.error */ }
  };

  const handleDelete = async (id: string) => {
    try { await deleteRecord.mutateAsync(id); setDeleteConfirmId(null); }
    catch { /* error via deleteRecord.error */ }
  };

  const startEditing = (r: typeof recordsRaw[number]) => {
    setEditingRecordId(r.id);
    setEditValues({
      record_value: r.recordValue ?? '',
      ttl: r.ttl,
      priority: r.priority ?? undefined,
    });
  };

  const cancelEditing = () => {
    setEditingRecordId(null);
    setEditValues({ record_value: '', ttl: 3600 });
  };

  const handleSaveEdit = async () => {
    if (!editingRecordId) return;
    try {
      await updateRecord.mutateAsync({
        recordId: editingRecordId,
        record_value: editValues.record_value,
        ttl: editValues.ttl,
        priority: editValues.priority,
      });
      cancelEditing();
    } catch { /* error via updateRecord.error */ }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm" data-testid="dns-records-section">
      <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-4">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">DNS Records</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSyncModal(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-300 dark:border-indigo-700 bg-white dark:bg-gray-700 px-3 py-2 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/30"
            data-testid="sync-records-button"
          >
            <ArrowLeftRight size={14} />
            Sync Records
          </button>
          <button
            type="button"
            onClick={() => setShowForm((p) => !p)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
            data-testid="add-dns-record-button"
          >
            {showForm ? <X size={14} /> : <Plus size={14} />}
            {showForm ? 'Cancel' : 'Add Record'}
          </button>
        </div>
      </div>

      {/* Old sync-from-server modal removed — replaced by Sync Records diff modal */}

      {showForm && (
        <form onSubmit={handleCreate} className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4" data-testid="dns-record-form">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div>
              <label htmlFor="dns-type" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Type</label>
              <select id="dns-type" value={form.record_type} onChange={(e) => setForm({ ...form, record_type: e.target.value as 'A' })} className={INPUT_CLASS} data-testid="dns-type-select">
                {['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS', 'CAA', 'PTR', 'SOA', 'ALIAS', 'DNAME'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="dns-name" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Name</label>
              <input id="dns-name" type="text" className={INPUT_CLASS} placeholder="@" value={form.record_name} onChange={(e) => setForm({ ...form, record_name: e.target.value })} data-testid="dns-name-input" />
            </div>
            <div>
              <label htmlFor="dns-value" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Value</label>
              <input id="dns-value" type="text" className={INPUT_CLASS} placeholder="192.168.1.1" value={form.record_value} onChange={(e) => setForm({ ...form, record_value: e.target.value })} required data-testid="dns-value-input" />
            </div>
            <div className="flex items-end">
              <button type="submit" disabled={createRecord.isPending} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" data-testid="submit-dns-record">
                {createRecord.isPending && <Loader2 size={14} className="animate-spin" />}
                Add
              </button>
            </div>
          </div>
          {createRecord.error && (
            <div className="mt-3 flex items-center gap-2 text-sm text-red-600" data-testid="dns-create-error">
              <AlertCircle size={14} />
              {createRecord.error instanceof Error ? createRecord.error.message : 'Failed to create record'}
            </div>
          )}
        </form>
      )}

      {updateRecord.error && (
        <div className="border-b border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-5 py-3 text-sm text-red-600 dark:text-red-400 flex items-center gap-2" data-testid="dns-update-error">
          <AlertCircle size={14} />
          {updateRecord.error instanceof Error ? updateRecord.error.message : 'Failed to update record'}
        </div>
      )}

      {isLoading && <div className="flex items-center justify-center py-8"><Loader2 size={20} className="animate-spin text-blue-600" /></div>}
      {isError && <div className="px-5 py-6 text-center text-sm text-red-500" data-testid="dns-records-error">Failed to load DNS records.</div>}

      {!isLoading && !isError && (
        <table className="w-full" data-testid="dns-records-table">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
              <SortableHeader label="Type" sortKey="recordType" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
              <SortableHeader label="Name" sortKey="recordName" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
              <SortableHeader label="Value" sortKey="recordValue" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
              <SortableHeader label="TTL" sortKey="ttl" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
              <th className="px-5 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {records.map((r) => (
              <tr
                key={r.id}
                className="hover:bg-gray-50 dark:hover:bg-gray-700/50"
                onDoubleClick={() => { if (editingRecordId !== r.id) startEditing(r); }}
              >
                <td className="px-5 py-3 text-sm">
                  <span className="rounded bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs font-medium dark:text-gray-300">{r.recordType}</span>
                </td>
                <td className="px-5 py-3 text-sm text-gray-900 dark:text-gray-100">{r.recordName ?? '@'}</td>
                {editingRecordId === r.id ? (
                  <>
                    <td className="px-5 py-2">
                      <input
                        type="text"
                        value={editValues.record_value}
                        onChange={(e) => setEditValues({ ...editValues, record_value: e.target.value })}
                        className={INPUT_CLASS}
                        data-testid={`edit-value-${r.id}`}
                      />
                    </td>
                    <td className="px-5 py-2">
                      <input
                        type="number"
                        value={editValues.ttl}
                        onChange={(e) => setEditValues({ ...editValues, ttl: Number(e.target.value) || 3600 })}
                        className={INPUT_CLASS + ' w-24'}
                        min={60}
                        max={86400}
                        data-testid={`edit-ttl-${r.id}`}
                      />
                    </td>
                    <td className="px-5 py-2 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={handleSaveEdit}
                          disabled={updateRecord.isPending}
                          className="inline-flex items-center gap-1 rounded-md bg-green-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                          data-testid={`save-edit-dns-${r.id}`}
                        >
                          {updateRecord.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={cancelEditing}
                          className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                          data-testid={`cancel-edit-dns-${r.id}`}
                        >
                          Cancel
                        </button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-5 py-3 text-sm font-mono text-gray-600 dark:text-gray-400 max-w-xs truncate">{r.recordValue}</td>
                    <td className="px-5 py-3 text-sm text-gray-500 dark:text-gray-400">{r.ttl}</td>
                    <td className="px-5 py-3 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => startEditing(r)}
                          className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                          data-testid={`edit-dns-${r.id}`}
                        >
                          <Pencil size={12} /> Edit
                        </button>
                        {deleteConfirmId === r.id ? (
                          <>
                            <button type="button" onClick={() => handleDelete(r.id)} disabled={deleteRecord.isPending} className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50" data-testid={`confirm-delete-dns-${r.id}`}>Confirm</button>
                            <button type="button" onClick={() => setDeleteConfirmId(null)} className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>
                          </>
                        ) : (
                          <button type="button" onClick={() => setDeleteConfirmId(r.id)} className="inline-flex items-center gap-1 rounded-md border border-red-200 dark:border-red-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30" data-testid={`delete-dns-${r.id}`}>
                            <Trash2 size={12} /> Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </>
                )}
              </tr>
            ))}
            {records.length === 0 && (
              <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-gray-500">No DNS records configured.</td></tr>
            )}
          </tbody>
        </table>
      )}

      {showSyncModal && (
        <SyncRecordsModal clientId={clientId} domainId={domainId} onClose={() => setShowSyncModal(false)} />
      )}
    </div>
  );
}

// ─── Sync Records Modal ──────────────────────────────────────────────────────

function SyncRecordsModal({ clientId, domainId, onClose }: {
  readonly clientId: string;
  readonly domainId: string;
  readonly onClose: () => void;
}) {
  const { data: diffData, isLoading, isFetching, isError, refetch } = useDnsRecordDiff(clientId, domainId, true);
  const pullRecord = usePullDnsRecord(clientId, domainId);
  const pushRecord = usePushDnsRecord(clientId, domainId);
  const [completedActions, setCompletedActions] = useState<Set<string>>(new Set());

  const diff = diffData?.data ?? [];

  const markCompleted = (key: string) => {
    setCompletedActions((prev) => new Set([...prev, key]));
  };

  const entryKey = (entry: DnsRecordDiffEntry) => `${entry.type}|${entry.name}|${entry.local?.value ?? ''}|${entry.remote?.value ?? ''}`;

  const handlePull = async (entry: DnsRecordDiffEntry) => {
    if (!entry.remote) return;
    await pullRecord.mutateAsync({
      type: entry.type,
      name: entry.name,
      value: entry.remote.value,
      ttl: entry.remote.ttl,
      local_id: entry.local?.id,
    });
    markCompleted(entryKey(entry));
  };

  const handlePush = async (entry: DnsRecordDiffEntry) => {
    if (!entry.local) return;
    await pushRecord.mutateAsync({
      type: entry.type,
      name: entry.name,
      value: entry.local.value,
      ttl: entry.local.ttl,
    });
    markCompleted(entryKey(entry));
  };

  const handlePullAllMissing = async () => {
    const remoteOnly = diff.filter((e) => e.status === 'remote_only' && !completedActions.has(entryKey(e)));
    for (const entry of remoteOnly) {
      if (entry.remote) {
        await pullRecord.mutateAsync({
          type: entry.type,
          name: entry.name,
          value: entry.remote.value,
          ttl: entry.remote.ttl,
        });
        markCompleted(entryKey(entry));
      }
    }
  };

  const handlePushAllMissing = async () => {
    const localOnly = diff.filter((e) => e.status === 'local_only' && !completedActions.has(entryKey(e)));
    for (const entry of localOnly) {
      if (entry.local) {
        await pushRecord.mutateAsync({
          type: entry.type,
          name: entry.name,
          value: entry.local.value,
          ttl: entry.local.ttl,
        });
        markCompleted(entryKey(entry));
      }
    }
  };

  const handleRefresh = () => {
    setCompletedActions(new Set());
    refetch();
  };

  const statusIcon = (entry: DnsRecordDiffEntry) => {
    if (completedActions.has(entryKey(entry))) {
      return <CheckCircle2 size={16} className="text-green-500" />;
    }
    switch (entry.status) {
      case 'in_sync': return <CheckCircle2 size={16} className="text-green-500" />;
      case 'conflict': return <AlertCircle size={16} className="text-red-500" />;
      case 'remote_only': return <ArrowDownToLine size={16} className="text-blue-500" />;
      case 'local_only': return <ArrowUpFromLine size={16} className="text-amber-500" />;
    }
  };

  const statusBg = (entry: DnsRecordDiffEntry) => {
    if (completedActions.has(entryKey(entry))) return 'bg-green-50 dark:bg-green-900/10';
    switch (entry.status) {
      case 'in_sync': return 'bg-green-50 dark:bg-green-900/10';
      case 'conflict': return 'bg-red-50 dark:bg-red-900/10';
      case 'remote_only': return 'bg-blue-50 dark:bg-blue-900/10';
      case 'local_only': return 'bg-amber-50 dark:bg-amber-900/10';
    }
  };

  const remoteOnlyCount = diff.filter((e) => e.status === 'remote_only' && !completedActions.has(entryKey(e))).length;
  const localOnlyCount = diff.filter((e) => e.status === 'local_only' && !completedActions.has(entryKey(e))).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" data-testid="sync-records-modal">
      <div className="mx-4 w-full max-w-4xl max-h-[80vh] flex flex-col rounded-xl bg-white dark:bg-gray-800 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-6 py-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Sync Records</h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Consolidate DNS records between local DB and remote DNS server.</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isFetching}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50"
              data-testid="sync-refresh-button"
            >
              {isFetching ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              data-testid="sync-modal-close"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {isLoading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-blue-600" />
              <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">Comparing records...</span>
            </div>
          )}

          {isError && (
            <div className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300">
              <AlertCircle size={16} />
              Failed to fetch record diff from DNS server.
            </div>
          )}

          {!isLoading && !isError && diff.length === 0 && (
            <div className="py-12 text-center text-sm text-gray-500 dark:text-gray-400">
              <CheckCircle2 size={32} className="mx-auto mb-2 text-green-500" />
              All records are in sync.
            </div>
          )}

          {!isLoading && !isError && diff.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
              <table className="w-full text-sm" data-testid="sync-diff-table">
                <thead>
                  <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    <th className="px-3 py-2.5 w-10">Status</th>
                    <th className="px-3 py-2.5 w-16">Type</th>
                    <th className="px-3 py-2.5 w-32">Name</th>
                    <th className="px-3 py-2.5">Local Value</th>
                    <th className="px-3 py-2.5">Remote Value</th>
                    <th className="px-3 py-2.5 w-40 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {diff.map((entry) => {
                    const key = entryKey(entry);
                    const done = completedActions.has(key);
                    return (
                      <tr key={key} className={statusBg(entry)}>
                        <td className="px-3 py-2.5">{statusIcon(entry)}</td>
                        <td className="px-3 py-2.5">
                          <span className="rounded bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-xs font-medium dark:text-gray-300">{entry.type}</span>
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs text-gray-900 dark:text-gray-100">{entry.name}</td>
                        <td className="px-3 py-2.5 font-mono text-xs text-gray-600 dark:text-gray-400 max-w-[200px] truncate">
                          {entry.local ? (
                            <span title={entry.local.value}>{entry.local.value}<span className="ml-1 text-gray-400 dark:text-gray-500">(TTL:{entry.local.ttl})</span></span>
                          ) : (
                            <span className="italic text-gray-400 dark:text-gray-500">--</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs text-gray-600 dark:text-gray-400 max-w-[200px] truncate">
                          {entry.remote ? (
                            <span title={entry.remote.value}>{entry.remote.value}<span className="ml-1 text-gray-400 dark:text-gray-500">(TTL:{entry.remote.ttl})</span></span>
                          ) : (
                            <span className="italic text-gray-400 dark:text-gray-500">--</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {done ? (
                            <span className="text-xs text-green-600 dark:text-green-400 font-medium">Done</span>
                          ) : entry.status === 'in_sync' ? (
                            <span className="text-xs text-green-600 dark:text-green-400 font-medium">In Sync</span>
                          ) : entry.status === 'conflict' ? (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => handlePull(entry)}
                                disabled={pullRecord.isPending}
                                className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                                data-testid={`pull-${key}`}
                              >
                                <ArrowDownToLine size={10} /> Pull
                              </button>
                              <button
                                type="button"
                                onClick={() => handlePush(entry)}
                                disabled={pushRecord.isPending}
                                className="inline-flex items-center gap-1 rounded-md bg-green-600 px-2 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                                data-testid={`push-${key}`}
                              >
                                Push <ArrowUpFromLine size={10} />
                              </button>
                            </div>
                          ) : entry.status === 'remote_only' ? (
                            <button
                              type="button"
                              onClick={() => handlePull(entry)}
                              disabled={pullRecord.isPending}
                              className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                              data-testid={`pull-${key}`}
                            >
                              <ArrowDownToLine size={10} /> Pull
                            </button>
                          ) : entry.status === 'local_only' ? (
                            <button
                              type="button"
                              onClick={() => handlePush(entry)}
                              disabled={pushRecord.isPending}
                              className="inline-flex items-center gap-1 rounded-md bg-green-600 px-2 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                              data-testid={`push-${key}`}
                            >
                              Push <ArrowUpFromLine size={10} />
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {!isLoading && !isError && (remoteOnlyCount > 0 || localOnlyCount > 0) && (
          <div className="flex items-center justify-between border-t border-gray-200 dark:border-gray-700 px-6 py-4">
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {diff.filter((e) => e.status === 'conflict').length > 0 && (
                <span className="mr-3 text-red-600 dark:text-red-400 font-medium">{diff.filter((e) => e.status === 'conflict').length} conflicts</span>
              )}
              {remoteOnlyCount > 0 && <span className="mr-3">{remoteOnlyCount} remote only</span>}
              {localOnlyCount > 0 && <span>{localOnlyCount} local only</span>}
            </div>
            <div className="flex items-center gap-2">
              {remoteOnlyCount > 0 && (
                <button
                  type="button"
                  onClick={handlePullAllMissing}
                  disabled={pullRecord.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  data-testid="pull-all-missing"
                >
                  {pullRecord.isPending && <Loader2 size={12} className="animate-spin" />}
                  <ArrowDownToLine size={14} />
                  Pull All Missing
                </button>
              )}
              {localOnlyCount > 0 && (
                <button
                  type="button"
                  onClick={handlePushAllMissing}
                  disabled={pushRecord.isPending}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
                  data-testid="push-all-missing"
                >
                  {pushRecord.isPending && <Loader2 size={12} className="animate-spin" />}
                  <ArrowUpFromLine size={14} />
                  Push All Missing
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── SSL/TLS Tab ──────────────────────────────────────────────────────────────

const SSL_TEXTAREA_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm font-mono text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500';

function SslTlsTab({ clientId, domainId, sslAutoRenew }: {
  readonly clientId: string;
  readonly domainId: string;
  readonly sslAutoRenew: number;
}) {
  const { data: certData, isLoading, isError, error } = useSslCert(clientId, domainId);
  const uploadCert = useUploadSslCert(clientId, domainId);
  const deleteCert = useDeleteSslCert(clientId, domainId);

  const [showUploadForm, setShowUploadForm] = useState(false);
  const [certificate, setCertificate] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [caBundle, setCaBundle] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const cert = certData?.data ?? null;
  const hasCustomCert = Boolean(cert);
  const isAutoTls = sslAutoRenew === 1;

  const tlsMode = hasCustomCert ? 'custom' : isAutoTls ? 'auto' : 'none';

  const handleUpload = async (e: FormEvent) => {
    e.preventDefault();
    if (!certificate.trim() || !privateKey.trim()) return;
    try {
      await uploadCert.mutateAsync({
        certificate: certificate.trim(),
        private_key: privateKey.trim(),
        ca_bundle: caBundle.trim() || undefined,
      });
      setCertificate('');
      setPrivateKey('');
      setCaBundle('');
      setShowUploadForm(false);
    } catch {
      // error shown via uploadCert.error
    }
  };

  const handleDelete = async () => {
    try {
      await deleteCert.mutateAsync();
      setDeleteConfirm(false);
    } catch {
      // error shown via deleteCert.error
    }
  };

  return (
    <div className="space-y-6" data-testid="ssl-tls-tab">
      {/* TLS Mode Indicator */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        <div className="border-b border-gray-100 dark:border-gray-700 px-5 py-4">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">TLS Mode</h2>
        </div>
        <div className="px-5 py-4">
          <div className="flex items-center gap-3">
            <span className={clsx(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium',
              tlsMode === 'auto' && 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300',
              tlsMode === 'custom' && 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300',
              tlsMode === 'none' && 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
            )} data-testid="tls-mode-badge">
              <ShieldCheck size={14} />
              {tlsMode === 'auto' && 'Automatic (Let\'s Encrypt)'}
              {tlsMode === 'custom' && 'Custom Certificate'}
              {tlsMode === 'none' && 'No TLS'}
            </span>
          </div>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            {tlsMode === 'auto' && 'TLS certificates are automatically provisioned and renewed via Let\'s Encrypt. Upload a custom certificate to override.'}
            {tlsMode === 'custom' && 'A custom TLS certificate has been uploaded. Delete it to revert to automatic provisioning.'}
            {tlsMode === 'none' && 'TLS is not configured for this domain. Enable auto-TLS or upload a custom certificate.'}
          </p>
        </div>
      </div>

      {/* Current Certificate Status */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-4">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Certificate Status</h2>
          {!hasCustomCert && (
            <button
              type="button"
              onClick={() => setShowUploadForm((p) => !p)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
              data-testid="upload-cert-toggle"
            >
              {showUploadForm ? <X size={14} /> : <Upload size={14} />}
              {showUploadForm ? 'Cancel' : 'Upload Certificate'}
            </button>
          )}
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-blue-600" />
          </div>
        )}

        {isError && !(error instanceof Error && 'status' in error && (error as { status: number }).status === 404) && (
          <div className="px-5 py-6 text-center text-sm text-red-500 dark:text-red-400" data-testid="ssl-cert-error">
            Failed to load certificate status.
          </div>
        )}

        {!isLoading && hasCustomCert && cert && (
          <div className="px-5 py-4 space-y-3" data-testid="ssl-cert-details">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Subject</dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100 font-mono">{cert.subject ?? 'N/A'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Issuer</dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100 font-mono">{cert.issuer ?? 'N/A'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Expires</dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                  {cert.expiresAt ? new Date(cert.expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : 'N/A'}
                  {cert.expiresAt && new Date(cert.expiresAt) < new Date() && (
                    <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-red-50 dark:bg-red-900/20 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-300">
                      <AlertCircle size={10} />
                      Expired
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Uploaded</dt>
                <dd className="mt-1 text-sm text-gray-900 dark:text-gray-100">
                  {new Date(cert.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
                </dd>
              </div>
            </div>

            <div className="flex items-center gap-2 border-t border-gray-100 dark:border-gray-700 pt-4">
              <button
                type="button"
                onClick={() => setShowUploadForm((p) => !p)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 dark:border-blue-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30"
                data-testid="replace-cert-button"
              >
                <Upload size={14} />
                Replace Certificate
              </button>
              {deleteConfirm ? (
                <div className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={deleteCert.isPending}
                    className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    data-testid="confirm-delete-cert"
                  >
                    {deleteCert.isPending ? <Loader2 size={14} className="inline animate-spin" /> : 'Confirm Delete'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteConfirm(false)}
                    className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setDeleteConfirm(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 dark:border-red-800 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                  data-testid="delete-cert-button"
                >
                  <Trash2 size={14} />
                  Delete Certificate
                </button>
              )}
            </div>

            {deleteCert.error && (
              <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="delete-cert-error">
                <AlertCircle size={14} />
                {deleteCert.error instanceof Error ? deleteCert.error.message : 'Failed to delete certificate'}
              </div>
            )}
          </div>
        )}

        {!isLoading && !hasCustomCert && !isError && !showUploadForm && (
          <div className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400" data-testid="no-custom-cert">
            {isAutoTls
              ? 'Using automatic TLS via Let\'s Encrypt. Upload a custom certificate to override.'
              : 'No TLS certificate configured. Upload a custom certificate to enable HTTPS.'}
          </div>
        )}

        {/* Upload Form */}
        {showUploadForm && (
          <form onSubmit={handleUpload} className="border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-5 space-y-4" data-testid="ssl-upload-form">
            <div>
              <label htmlFor="ssl-certificate" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                PEM Certificate *
              </label>
              <textarea
                id="ssl-certificate"
                rows={6}
                value={certificate}
                onChange={(e) => setCertificate(e.target.value)}
                placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                className={SSL_TEXTAREA_CLASS}
                required
                data-testid="ssl-cert-input"
              />
            </div>
            <div>
              <label htmlFor="ssl-private-key" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Private Key *
              </label>
              <textarea
                id="ssl-private-key"
                rows={6}
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                className={SSL_TEXTAREA_CLASS}
                required
                data-testid="ssl-key-input"
              />
            </div>
            <div>
              <label htmlFor="ssl-ca-bundle" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                CA Bundle <span className="text-gray-400 dark:text-gray-500">(optional)</span>
              </label>
              <textarea
                id="ssl-ca-bundle"
                rows={4}
                value={caBundle}
                onChange={(e) => setCaBundle(e.target.value)}
                placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                className={SSL_TEXTAREA_CLASS}
                data-testid="ssl-ca-input"
              />
            </div>
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={uploadCert.isPending || !certificate.trim() || !privateKey.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                data-testid="submit-cert-upload"
              >
                {uploadCert.isPending ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                Upload Certificate
              </button>
              <button
                type="button"
                onClick={() => { setShowUploadForm(false); setCertificate(''); setPrivateKey(''); setCaBundle(''); }}
                className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              >
                Cancel
              </button>
            </div>
            {uploadCert.error && (
              <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="upload-cert-error">
                <AlertCircle size={14} />
                {uploadCert.error instanceof Error ? uploadCert.error.message : 'Failed to upload certificate'}
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
