import { useState, type FormEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, Loader2, AlertCircle, Plus, Trash2, Globe, Settings, Shield, X,
  Users, Lock, ChevronDown, ChevronRight, CheckCircle, Network, Upload, ShieldCheck,
} from 'lucide-react';
import clsx from 'clsx';
import StatusBadge from '@/components/ui/StatusBadge';
import { useDomains, useVerifyDomain } from '@/hooks/use-domains';
import { useDnsRecords, useCreateDnsRecord, useDeleteDnsRecord } from '@/hooks/use-dns-records';
import { useIngressRoutes, useCreateIngressRoute, useUpdateIngressRoute, useDeleteIngressRoute } from '@/hooks/use-ingress-routes';
import { useDeployments } from '@/hooks/use-deployments';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';
import { useHostingSettings, useUpdateHostingSettings } from '@/hooks/use-hosting-settings';
import {
  useProtectedDirectories, useCreateProtectedDirectory, useDeleteProtectedDirectory,
  useDirectoryUsers, useCreateDirectoryUser, useDisableDirectoryUser, useDeleteDirectoryUser,
} from '@/hooks/use-protected-directories';
import { useSslCert, useUploadSslCert, useDeleteSslCert } from '@/hooks/use-ssl-certs';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 placeholder:text-gray-400 dark:placeholder:text-gray-500 dark:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

type Tab = 'routing' | 'dns' | 'hosting' | 'protected' | 'ssl';

export default function DomainDetail() {
  const { clientId, domainId } = useParams<{ clientId: string; domainId: string }>();
  const [activeTab, setActiveTab] = useState<Tab>('routing');
  const verifyDomain = useVerifyDomain(clientId);

  const { data: domainsData, isLoading: domainLoading } = useDomains(clientId, { limit: 100 });
  const domain = domainsData?.data?.find((d) => d.id === domainId);

  if (domainLoading) {
    return (
      <div className="flex items-center justify-center py-20" data-testid="domain-detail-loading">
        <Loader2 size={24} className="animate-spin text-brand-500" />
      </div>
    );
  }

  if (!domain) {
    return (
      <div className="py-20 text-center text-gray-500 dark:text-gray-400" data-testid="domain-not-found">
        <p>Domain not found.</p>
        <Link to="/domains" className="mt-2 text-brand-500 hover:underline">Back to Domains</Link>
      </div>
    );
  }

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'routing', label: 'Routing', icon: <Network size={14} /> },
    { key: 'dns', label: 'DNS Records', icon: <Globe size={14} /> },
    { key: 'hosting', label: 'Hosting Settings', icon: <Settings size={14} /> },
    { key: 'protected', label: 'Protected Directories', icon: <Shield size={14} /> },
    { key: 'ssl', label: 'SSL/TLS', icon: <ShieldCheck size={14} /> },
  ];

  return (
    <div className="space-y-6" data-testid="domain-detail-page">
      <div className="flex items-center gap-3">
        <Link
          to="/domains"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          data-testid="back-to-domains"
        >
          <ArrowLeft size={16} />
          Domains
        </Link>
        <span className="text-gray-300">/</span>
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100" data-testid="domain-name-heading">
          {domain.domainName}
        </h1>
        <StatusBadge status={domain.status as 'active' | 'pending' | 'suspended'} />
        <button
          type="button"
          onClick={() => verifyDomain.mutate(domainId!)}
          disabled={verifyDomain.isPending}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-brand-300 dark:border-brand-700 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm font-medium text-brand-600 dark:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/30 disabled:opacity-50"
          data-testid="verify-dns-button"
        >
          {verifyDomain.isPending ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
          Verify DNS
        </button>
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

      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={clsx(
              'inline-flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              activeTab === tab.key
                ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300',
            )}
            data-testid={`tab-${tab.key}`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'routing' && <RoutingTab clientId={clientId!} domainId={domainId!} domainName={domain.domainName} dnsMode={domain.dnsMode} />}
      {activeTab === 'dns' && <DnsRecordsTab clientId={clientId!} domainId={domainId!} />}
      {activeTab === 'hosting' && <HostingSettingsTab clientId={clientId!} domainId={domainId!} />}
      {activeTab === 'protected' && <ProtectedDirectoriesTab clientId={clientId!} domainId={domainId!} />}
      {activeTab === 'ssl' && <SslTlsTab clientId={clientId!} domainId={domainId!} sslAutoRenew={domain.sslAutoRenew} />}
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
  const { data: routesData, isLoading } = useIngressRoutes(clientId, domainId);
  const { data: deploymentsData } = useDeployments(clientId);
  const createRoute = useCreateIngressRoute(clientId, domainId);
  const updateRoute = useUpdateIngressRoute(clientId, domainId);
  const deleteRoute = useDeleteIngressRoute(clientId, domainId);

  const [newHostname, setNewHostname] = useState('');

  const routes = routesData?.data ?? [];
  const deployments = deploymentsData?.data ?? [];

  const handleAddRoute = (e: FormEvent) => {
    e.preventDefault();
    if (!newHostname) return;
    createRoute.mutate({ hostname: newHostname }, {
      onSuccess: () => setNewHostname(''),
    });
  };

  const handleAssignDeployment = (routeId: string, deploymentId: string | null) => {
    updateRoute.mutate({ routeId, deployment_id: deploymentId });
  };

  const isCname = dnsMode === 'cname';
  const isSecondary = dnsMode === 'secondary';

  return (
    <div className="space-y-6" data-testid="routing-tab">
      {/* Explanation */}
      <div className="rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 px-4 py-3 text-sm text-blue-800 dark:text-blue-300">
        {isCname && (
          <p>This is a <strong>CNAME domain</strong>. Add a route and assign a deployment. The client points their DNS to the platform's ingress hostname.</p>
        )}
        {dnsMode === 'primary' && (
          <p>This is a <strong>Primary DNS domain</strong>. Add routes for hostnames (apex or subdomains). For subdomains, a CNAME record is auto-created. For the apex, A/AAAA records point to the platform ingress.</p>
        )}
        {isSecondary && (
          <p>This is a <strong>Secondary DNS domain</strong> (read-only zone). Add routes for hostnames that resolve to the platform ingress, then assign deployments.</p>
        )}
      </div>

      {/* Existing Routes */}
      {isLoading ? (
        <div className="flex items-center gap-2 py-4">
          <Loader2 size={16} className="animate-spin text-brand-500" />
          <span className="text-sm text-gray-500">Loading routes...</span>
        </div>
      ) : routes.length === 0 ? (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          No ingress routes configured. Add a hostname to start routing traffic.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full text-sm" data-testid="routes-table">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                <th className="px-4 py-3">Hostname</th>
                <th className="px-4 py-3">CNAME Target</th>
                <th className="px-4 py-3">Deployment</th>
                <th className="px-4 py-3">TLS</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {routes.map((route) => (
                <tr key={route.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-900 dark:text-gray-100">{route.hostname}</span>
                      {route.isApex ? (
                        <span className="inline-flex rounded bg-amber-50 dark:bg-amber-900/20 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300">apex</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">
                    {route.ingressCname}
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={route.deploymentId ?? ''}
                      onChange={(e) => handleAssignDeployment(route.id, e.target.value || null)}
                      className="rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1 text-xs text-gray-900 dark:text-gray-100 focus:border-brand-500 focus:outline-none"
                      data-testid={`route-deployment-${route.id}`}
                    >
                      <option value="">Not assigned</option>
                      {deployments.map((d) => (
                        <option key={d.id} value={d.id}>{d.name} ({d.status})</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <span className={clsx(
                      'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
                      route.tlsMode === 'auto' ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300' :
                      route.tlsMode === 'custom' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' :
                      'bg-gray-100 dark:bg-gray-700 text-gray-500',
                    )}>
                      {route.tlsMode}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={route.status as 'active' | 'pending' | 'error'} />
                  </td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => deleteRoute.mutate(route.id)}
                      className="rounded-md p-1 text-gray-400 hover:text-red-500 dark:hover:text-red-400"
                      title="Delete route"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add Route Form */}
      <form onSubmit={handleAddRoute} className="flex items-end gap-3" data-testid="add-route-form">
        <div className="flex-1">
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Add Hostname
          </label>
          <input
            type="text"
            value={newHostname}
            onChange={(e) => setNewHostname(e.target.value)}
            placeholder={isCname ? domainName : `subdomain.${domainName}`}
            className={INPUT_CLASS}
            data-testid="new-hostname-input"
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {isCname
              ? 'For CNAME domains, use the domain name itself.'
              : `Enter the full hostname (e.g., ${domainName} for apex, or blog.${domainName} for a subdomain).`
            }
          </p>
        </div>
        <button
          type="submit"
          disabled={!newHostname || createRoute.isPending}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="add-route-button"
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

// ─── DNS Records Tab ──────────────────────────────────────────────────────────

function DnsRecordsTab({ clientId, domainId }: { readonly clientId: string; readonly domainId: string }) {
  const { data: response, isLoading, isError } = useDnsRecords(clientId, domainId);
  const createRecord = useCreateDnsRecord(clientId, domainId);
  const deleteRecord = useDeleteDnsRecord(clientId, domainId);
  const [showForm, setShowForm] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const records = response?.data ?? [];
  const { sortedData: sortedRecords, sortKey, sortDirection, onSort } = useSortable(records, 'recordName');

  const [form, setForm] = useState({
    record_type: 'A' as const,
    record_name: '',
    record_value: '',
    ttl: '3600',
    priority: '',
  });

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await createRecord.mutateAsync({
        record_type: form.record_type,
        record_name: form.record_name || undefined,
        record_value: form.record_value,
        ttl: Number(form.ttl) || 3600,
        priority: form.priority ? Number(form.priority) : undefined,
      });
      setForm({ record_type: 'A', record_name: '', record_value: '', ttl: '3600', priority: '' });
      setShowForm(false);
    } catch { /* error available via createRecord.error */ }
  };

  const handleDelete = async (recordId: string) => {
    try {
      await deleteRecord.mutateAsync(recordId);
      setDeleteConfirmId(null);
    } catch { /* error available via deleteRecord.error */ }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm" data-testid="dns-records-section">
      <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-4">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">DNS Records</h2>
        <button
          type="button"
          onClick={() => setShowForm((p) => !p)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600"
          data-testid="add-dns-record-button"
        >
          {showForm ? <X size={14} /> : <Plus size={14} />}
          {showForm ? 'Cancel' : 'Add Record'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4" data-testid="dns-record-form">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
            <div>
              <label htmlFor="dns-type" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Type</label>
              <select
                id="dns-type"
                value={form.record_type}
                onChange={(e) => setForm({ ...form, record_type: e.target.value as 'A' })}
                className={INPUT_CLASS}
                data-testid="dns-type-select"
              >
                {['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS'].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="dns-name" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Name</label>
              <input
                id="dns-name"
                type="text"
                className={INPUT_CLASS}
                placeholder="@"
                value={form.record_name}
                onChange={(e) => setForm({ ...form, record_name: e.target.value })}
                data-testid="dns-name-input"
              />
            </div>
            <div>
              <label htmlFor="dns-value" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Value</label>
              <input
                id="dns-value"
                type="text"
                className={INPUT_CLASS}
                placeholder="192.168.1.1"
                value={form.record_value}
                onChange={(e) => setForm({ ...form, record_value: e.target.value })}
                required
                data-testid="dns-value-input"
              />
            </div>
            <div>
              <label htmlFor="dns-ttl" className="block text-xs font-medium text-gray-700 dark:text-gray-300">TTL</label>
              <input
                id="dns-ttl"
                type="number"
                className={INPUT_CLASS}
                placeholder="3600"
                value={form.ttl}
                onChange={(e) => setForm({ ...form, ttl: e.target.value })}
                data-testid="dns-ttl-input"
              />
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={createRecord.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
                data-testid="submit-dns-record"
              >
                {createRecord.isPending && <Loader2 size={14} className="animate-spin" />}
                Add
              </button>
            </div>
          </div>
          {createRecord.error && (
            <div className="mt-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="dns-create-error">
              <AlertCircle size={14} />
              {createRecord.error instanceof Error ? createRecord.error.message : 'Failed to create record'}
            </div>
          )}
        </form>
      )}

      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={20} className="animate-spin text-brand-500" />
        </div>
      )}

      {isError && (
        <div className="px-5 py-6 text-center text-sm text-red-500 dark:text-red-400" data-testid="dns-records-error">
          Failed to load DNS records.
        </div>
      )}

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
            {sortedRecords.map((record) => (
              <tr key={record.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td className="px-5 py-3 text-sm">
                  <span className="rounded bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs font-medium text-gray-700 dark:text-gray-300">
                    {record.recordType}
                  </span>
                </td>
                <td className="px-5 py-3 text-sm text-gray-900 dark:text-gray-100">{record.recordName ?? '@'}</td>
                <td className="px-5 py-3 text-sm font-mono text-gray-600 dark:text-gray-400 max-w-xs truncate">{record.recordValue}</td>
                <td className="px-5 py-3 text-sm text-gray-500 dark:text-gray-400">{record.ttl}</td>
                <td className="px-5 py-3 text-right">
                  {deleteConfirmId === record.id ? (
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleDelete(record.id)}
                        disabled={deleteRecord.isPending}
                        className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                        data-testid={`confirm-delete-dns-${record.id}`}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteConfirmId(null)}
                        className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDeleteConfirmId(record.id)}
                      className="inline-flex items-center gap-1 rounded-md border border-red-200 dark:border-red-800 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                      data-testid={`delete-dns-${record.id}`}
                    >
                      <Trash2 size={12} />
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {records.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                  No DNS records. Click "Add Record" to create one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Hosting Settings Tab ─────────────────────────────────────────────────────

function HostingSettingsTab({ clientId, domainId }: { readonly clientId: string; readonly domainId: string }) {
  const { data: response, isLoading, isError } = useHostingSettings(clientId, domainId);
  const updateSettings = useUpdateHostingSettings(clientId, domainId);
  const settings = response?.data;

  const [dirty, setDirty] = useState(false);
  const [local, setLocal] = useState<{
    redirect_www: boolean;
    redirect_https: boolean;
    hosting_enabled: boolean;
    webroot_path: string;
    forward_external: string;
  } | null>(null);

  // Sync local state from server
  const effective = local ?? (settings ? {
    redirect_www: settings.redirectWww,
    redirect_https: settings.redirectHttps,
    hosting_enabled: settings.hostingEnabled,
    webroot_path: settings.webrootPath,
    forward_external: settings.forwardExternal ?? '',
  } : null);

  const handleChange = (field: string, value: boolean | string) => {
    if (!effective) return;
    setLocal({ ...effective, [field]: value });
    setDirty(true);
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!effective) return;
    try {
      await updateSettings.mutateAsync({
        redirect_www: effective.redirect_www,
        redirect_https: effective.redirect_https,
        hosting_enabled: effective.hosting_enabled,
        webroot_path: effective.webroot_path,
        forward_external: effective.forward_external || null,
      });
      setDirty(false);
      setLocal(null);
    } catch { /* error available via updateSettings.error */ }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={20} className="animate-spin text-brand-500" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-center text-sm text-red-500 dark:text-red-400 py-8" data-testid="hosting-settings-error">
        Failed to load hosting settings.
      </div>
    );
  }

  if (!effective) return null;

  return (
    <form
      onSubmit={handleSave}
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-5"
      data-testid="hosting-settings-form"
    >
      <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Hosting Settings</h2>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={effective.redirect_www}
            onChange={(e) => handleChange('redirect_www', e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-500 focus:ring-brand-500"
            data-testid="redirect-www-toggle"
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">Redirect WWW</span>
        </label>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={effective.redirect_https}
            onChange={(e) => handleChange('redirect_https', e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-500 focus:ring-brand-500"
            data-testid="redirect-https-toggle"
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">Force HTTPS</span>
        </label>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={effective.hosting_enabled}
            onChange={(e) => handleChange('hosting_enabled', e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-500 focus:ring-brand-500"
            data-testid="hosting-enabled-toggle"
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">Hosting Enabled</span>
        </label>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="webroot-path" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Webroot Path</label>
          <input
            id="webroot-path"
            type="text"
            className={INPUT_CLASS + ' mt-1'}
            value={effective.webroot_path}
            onChange={(e) => handleChange('webroot_path', e.target.value)}
            data-testid="webroot-path-input"
          />
        </div>
        <div>
          <label htmlFor="forward-external" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Forward to External URL <span className="text-xs text-gray-400">(optional)</span>
          </label>
          <input
            id="forward-external"
            type="text"
            className={INPUT_CLASS + ' mt-1'}
            placeholder="https://example.com"
            value={effective.forward_external}
            onChange={(e) => handleChange('forward_external', e.target.value)}
            data-testid="forward-external-input"
          />
        </div>
      </div>

      {updateSettings.error && (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="hosting-save-error">
          <AlertCircle size={14} />
          {updateSettings.error instanceof Error ? updateSettings.error.message : 'Failed to save settings'}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!dirty || updateSettings.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="save-hosting-settings"
        >
          {updateSettings.isPending && <Loader2 size={14} className="animate-spin" />}
          Save Settings
        </button>
      </div>
    </form>
  );
}

// ─── Protected Directories Tab ────────────────────────────────────────────────

function ProtectedDirectoriesTab({ clientId, domainId }: { readonly clientId: string; readonly domainId: string }) {
  const { data: response, isLoading, isError } = useProtectedDirectories(clientId, domainId);
  const createDir = useCreateProtectedDirectory(clientId, domainId);
  const deleteDir = useDeleteProtectedDirectory(clientId, domainId);

  const [showForm, setShowForm] = useState(false);
  const [path, setPath] = useState('');
  const [realm, setRealm] = useState('Restricted Area');
  const [expandedDirId, setExpandedDirId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const dirs = response?.data ?? [];

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!path.trim()) return;
    try {
      await createDir.mutateAsync({ path: path.trim(), realm: realm.trim() || undefined });
      setPath('');
      setRealm('Restricted Area');
      setShowForm(false);
    } catch { /* error available via createDir.error */ }
  };

  const handleDelete = async (dirId: string) => {
    try {
      await deleteDir.mutateAsync(dirId);
      setDeleteConfirmId(null);
      if (expandedDirId === dirId) setExpandedDirId(null);
    } catch { /* error available via deleteDir.error */ }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm" data-testid="protected-dirs-section">
      <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-4">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Protected Directories</h2>
        <button
          type="button"
          onClick={() => setShowForm((p) => !p)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600"
          data-testid="add-protected-dir-button"
        >
          {showForm ? <X size={14} /> : <Plus size={14} />}
          {showForm ? 'Cancel' : 'Add Directory'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4" data-testid="create-dir-form">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="dir-path" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Path</label>
              <input
                id="dir-path"
                type="text"
                className={INPUT_CLASS}
                placeholder="/admin"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                required
                data-testid="dir-path-input"
              />
            </div>
            <div>
              <label htmlFor="dir-realm" className="block text-xs font-medium text-gray-700 dark:text-gray-300">Realm</label>
              <input
                id="dir-realm"
                type="text"
                className={INPUT_CLASS}
                placeholder="Restricted Area"
                value={realm}
                onChange={(e) => setRealm(e.target.value)}
                data-testid="dir-realm-input"
              />
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={createDir.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
                data-testid="submit-dir"
              >
                {createDir.isPending && <Loader2 size={14} className="animate-spin" />}
                Add
              </button>
            </div>
          </div>
          {createDir.error && (
            <div className="mt-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400" data-testid="dir-create-error">
              <AlertCircle size={14} />
              {createDir.error instanceof Error ? createDir.error.message : 'Failed to create directory'}
            </div>
          )}
        </form>
      )}

      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={20} className="animate-spin text-brand-500" />
        </div>
      )}

      {isError && (
        <div className="px-5 py-6 text-center text-sm text-red-500 dark:text-red-400" data-testid="protected-dirs-error">
          Failed to load protected directories.
        </div>
      )}

      {!isLoading && !isError && (
        <div className="divide-y divide-gray-100 dark:divide-gray-700">
          {dirs.map((dir) => (
            <div key={dir.id}>
              <div
                className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer"
                onClick={() => setExpandedDirId(expandedDirId === dir.id ? null : dir.id)}
                data-testid={`dir-row-${dir.id}`}
              >
                <div className="flex items-center gap-2">
                  {expandedDirId === dir.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Lock size={14} className="text-gray-400" />
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100 font-mono">{dir.path}</span>
                  <span className="text-xs text-gray-400">({dir.realm})</span>
                </div>
                <div className="flex items-center gap-2">
                  {deleteConfirmId === dir.id ? (
                    <div className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleDelete(dir.id); }}
                        disabled={deleteDir.isPending}
                        className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                        data-testid={`confirm-delete-dir-${dir.id}`}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(null); }}
                        className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(dir.id); }}
                      className="inline-flex items-center gap-1 rounded-md border border-red-200 dark:border-red-800 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                      data-testid={`delete-dir-${dir.id}`}
                    >
                      <Trash2 size={12} />
                      Delete
                    </button>
                  )}
                </div>
              </div>
              {expandedDirId === dir.id && (
                <DirectoryUsersPanel clientId={clientId} domainId={domainId} dirId={dir.id} />
              )}
            </div>
          ))}
          {dirs.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
              No protected directories. Click "Add Directory" to create one.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Directory Users Panel ────────────────────────────────────────────────────

function DirectoryUsersPanel({
  clientId, domainId, dirId,
}: { readonly clientId: string; readonly domainId: string; readonly dirId: string }) {
  const { data: response, isLoading } = useDirectoryUsers(clientId, domainId, dirId);
  const createUser = useCreateDirectoryUser(clientId, domainId, dirId);
  const disableUser = useDisableDirectoryUser(clientId, domainId, dirId);
  const deleteUser = useDeleteDirectoryUser(clientId, domainId, dirId);

  const [showForm, setShowForm] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const users = response?.data ?? [];

  const handleCreateUser = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) return;
    try {
      await createUser.mutateAsync({ username: username.trim(), password: password.trim() });
      setUsername('');
      setPassword('');
      setShowForm(false);
    } catch { /* error available via createUser.error */ }
  };

  return (
    <div className="border-t border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 px-5 py-4" data-testid={`dir-users-${dirId}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5 text-sm font-medium text-gray-700 dark:text-gray-300">
          <Users size={14} />
          Users
        </div>
        <button
          type="button"
          onClick={() => setShowForm((p) => !p)}
          className="inline-flex items-center gap-1 rounded-md bg-brand-500 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-600"
          data-testid={`add-dir-user-${dirId}`}
        >
          {showForm ? <X size={12} /> : <Plus size={12} />}
          {showForm ? 'Cancel' : 'Add User'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreateUser} className="mb-3 flex items-end gap-2" data-testid={`create-user-form-${dirId}`}>
          <div>
            <label htmlFor={`user-name-${dirId}`} className="block text-xs font-medium text-gray-600 dark:text-gray-400">Username</label>
            <input
              id={`user-name-${dirId}`}
              type="text"
              className={INPUT_CLASS + ' mt-0.5'}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              data-testid={`user-name-input-${dirId}`}
            />
          </div>
          <div>
            <label htmlFor={`user-pass-${dirId}`} className="block text-xs font-medium text-gray-600 dark:text-gray-400">Password</label>
            <input
              id={`user-pass-${dirId}`}
              type="password"
              className={INPUT_CLASS + ' mt-0.5'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              data-testid={`user-pass-input-${dirId}`}
            />
          </div>
          <button
            type="submit"
            disabled={createUser.isPending}
            className="rounded-md bg-brand-500 px-3 py-2 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            data-testid={`submit-user-${dirId}`}
          >
            Add
          </button>
        </form>
      )}

      {isLoading ? (
        <div className="py-2"><Loader2 size={16} className="animate-spin text-brand-500" /></div>
      ) : users.length === 0 ? (
        <p className="text-xs text-gray-400">No users yet.</p>
      ) : (
        <div className="space-y-1">
          {users.map((u) => (
            <div key={u.id} className="flex items-center justify-between rounded-md bg-white dark:bg-gray-800 px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-900 dark:text-gray-100">{u.username}</span>
                {!u.enabled && (
                  <span className="rounded bg-red-100 dark:bg-red-900/20 px-1.5 py-0.5 text-xs text-red-600 dark:text-red-400">disabled</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {u.enabled && (
                  <button
                    type="button"
                    onClick={() => disableUser.mutate(u.id)}
                    className="rounded-md border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                    data-testid={`disable-user-${u.id}`}
                  >
                    Disable
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => deleteUser.mutate(u.id)}
                  className="rounded-md border border-red-200 dark:border-red-800 px-2 py-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                  data-testid={`delete-user-${u.id}`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── SSL/TLS Tab ──────────────────────────────────────────────────────────────

const TEXTAREA_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm font-mono text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

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
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600"
              data-testid="upload-cert-toggle"
            >
              {showUploadForm ? <X size={14} /> : <Upload size={14} />}
              {showUploadForm ? 'Cancel' : 'Upload Certificate'}
            </button>
          )}
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-brand-500" />
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
                className="inline-flex items-center gap-1.5 rounded-lg border border-brand-300 dark:border-brand-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-brand-600 dark:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/30"
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
                className={TEXTAREA_CLASS}
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
                className={TEXTAREA_CLASS}
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
                className={TEXTAREA_CLASS}
                data-testid="ssl-ca-input"
              />
            </div>
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={uploadCert.isPending || !certificate.trim() || !privateKey.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
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
