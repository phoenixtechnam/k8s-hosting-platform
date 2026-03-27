import { useState, type FormEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, Loader2, AlertCircle, Plus, Trash2, Globe, Settings, Shield, X,
  Users, Lock, ChevronDown, ChevronRight,
} from 'lucide-react';
import clsx from 'clsx';
import StatusBadge from '@/components/ui/StatusBadge';
import { useDomains } from '@/hooks/use-domains';
import { useDnsRecords, useCreateDnsRecord, useDeleteDnsRecord } from '@/hooks/use-dns-records';
import { useHostingSettings, useUpdateHostingSettings } from '@/hooks/use-hosting-settings';
import {
  useProtectedDirectories, useCreateProtectedDirectory, useDeleteProtectedDirectory,
  useDirectoryUsers, useCreateDirectoryUser, useDisableDirectoryUser, useDeleteDirectoryUser,
} from '@/hooks/use-protected-directories';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

type Tab = 'dns' | 'hosting' | 'protected';

export default function DomainDetail() {
  const { clientId, domainId } = useParams<{ clientId: string; domainId: string }>();
  const [activeTab, setActiveTab] = useState<Tab>('dns');

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
      <div className="py-20 text-center text-gray-500" data-testid="domain-not-found">
        <p>Domain not found.</p>
        <Link to="/domains" className="mt-2 text-brand-500 hover:underline">Back to Domains</Link>
      </div>
    );
  }

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'dns', label: 'DNS Records', icon: <Globe size={14} /> },
    { key: 'hosting', label: 'Hosting Settings', icon: <Settings size={14} /> },
    { key: 'protected', label: 'Protected Directories', icon: <Shield size={14} /> },
  ];

  return (
    <div className="space-y-6" data-testid="domain-detail-page">
      <div className="flex items-center gap-3">
        <Link
          to="/domains"
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
          data-testid="back-to-domains"
        >
          <ArrowLeft size={16} />
          Domains
        </Link>
        <span className="text-gray-300">/</span>
        <h1 className="text-xl font-bold text-gray-900" data-testid="domain-name-heading">
          {domain.domainName}
        </h1>
        <StatusBadge status={domain.status as 'active' | 'pending' | 'suspended'} />
      </div>

      <div className="flex gap-1 border-b border-gray-200">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={clsx(
              'inline-flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              activeTab === tab.key
                ? 'border-brand-500 text-brand-600'
                : 'border-transparent text-gray-500 hover:text-gray-700',
            )}
            data-testid={`tab-${tab.key}`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'dns' && <DnsRecordsTab clientId={clientId!} domainId={domainId!} />}
      {activeTab === 'hosting' && <HostingSettingsTab clientId={clientId!} domainId={domainId!} />}
      {activeTab === 'protected' && <ProtectedDirectoriesTab clientId={clientId!} domainId={domainId!} />}
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
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm" data-testid="dns-records-section">
      <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
        <h2 className="text-base font-semibold text-gray-900">DNS Records</h2>
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
        <form onSubmit={handleCreate} className="border-b border-gray-100 bg-gray-50 p-4" data-testid="dns-record-form">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
            <div>
              <label htmlFor="dns-type" className="block text-xs font-medium text-gray-700">Type</label>
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
              <label htmlFor="dns-name" className="block text-xs font-medium text-gray-700">Name</label>
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
              <label htmlFor="dns-value" className="block text-xs font-medium text-gray-700">Value</label>
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
              <label htmlFor="dns-ttl" className="block text-xs font-medium text-gray-700">TTL</label>
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
            <div className="mt-3 flex items-center gap-2 text-sm text-red-600" data-testid="dns-create-error">
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
        <div className="px-5 py-6 text-center text-sm text-red-500" data-testid="dns-records-error">
          Failed to load DNS records.
        </div>
      )}

      {!isLoading && !isError && (
        <table className="w-full" data-testid="dns-records-table">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
              <th className="px-5 py-3">Type</th>
              <th className="px-5 py-3">Name</th>
              <th className="px-5 py-3">Value</th>
              <th className="px-5 py-3">TTL</th>
              <th className="px-5 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {records.map((record) => (
              <tr key={record.id} className="hover:bg-gray-50">
                <td className="px-5 py-3 text-sm">
                  <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                    {record.recordType}
                  </span>
                </td>
                <td className="px-5 py-3 text-sm text-gray-900">{record.recordName ?? '@'}</td>
                <td className="px-5 py-3 text-sm font-mono text-gray-600 max-w-xs truncate">{record.recordValue}</td>
                <td className="px-5 py-3 text-sm text-gray-500">{record.ttl}</td>
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
                        className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDeleteConfirmId(record.id)}
                      className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
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
                <td colSpan={5} className="px-5 py-8 text-center text-sm text-gray-500">
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
      <div className="text-center text-sm text-red-500 py-8" data-testid="hosting-settings-error">
        Failed to load hosting settings.
      </div>
    );
  }

  if (!effective) return null;

  return (
    <form
      onSubmit={handleSave}
      className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm space-y-5"
      data-testid="hosting-settings-form"
    >
      <h2 className="text-base font-semibold text-gray-900">Hosting Settings</h2>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={effective.redirect_www}
            onChange={(e) => handleChange('redirect_www', e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-brand-500 focus:ring-brand-500"
            data-testid="redirect-www-toggle"
          />
          <span className="text-sm text-gray-700">Redirect WWW</span>
        </label>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={effective.redirect_https}
            onChange={(e) => handleChange('redirect_https', e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-brand-500 focus:ring-brand-500"
            data-testid="redirect-https-toggle"
          />
          <span className="text-sm text-gray-700">Force HTTPS</span>
        </label>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={effective.hosting_enabled}
            onChange={(e) => handleChange('hosting_enabled', e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-brand-500 focus:ring-brand-500"
            data-testid="hosting-enabled-toggle"
          />
          <span className="text-sm text-gray-700">Hosting Enabled</span>
        </label>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="webroot-path" className="block text-sm font-medium text-gray-700">Webroot Path</label>
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
          <label htmlFor="forward-external" className="block text-sm font-medium text-gray-700">
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
        <div className="flex items-center gap-2 text-sm text-red-600" data-testid="hosting-save-error">
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
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm" data-testid="protected-dirs-section">
      <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
        <h2 className="text-base font-semibold text-gray-900">Protected Directories</h2>
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
        <form onSubmit={handleCreate} className="border-b border-gray-100 bg-gray-50 p-4" data-testid="create-dir-form">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="dir-path" className="block text-xs font-medium text-gray-700">Path</label>
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
              <label htmlFor="dir-realm" className="block text-xs font-medium text-gray-700">Realm</label>
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
            <div className="mt-3 flex items-center gap-2 text-sm text-red-600" data-testid="dir-create-error">
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
        <div className="px-5 py-6 text-center text-sm text-red-500" data-testid="protected-dirs-error">
          Failed to load protected directories.
        </div>
      )}

      {!isLoading && !isError && (
        <div className="divide-y divide-gray-100">
          {dirs.map((dir) => (
            <div key={dir.id}>
              <div
                className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 cursor-pointer"
                onClick={() => setExpandedDirId(expandedDirId === dir.id ? null : dir.id)}
                data-testid={`dir-row-${dir.id}`}
              >
                <div className="flex items-center gap-2">
                  {expandedDirId === dir.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <Lock size={14} className="text-gray-400" />
                  <span className="text-sm font-medium text-gray-900 font-mono">{dir.path}</span>
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
                        className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(dir.id); }}
                      className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
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
            <div className="px-5 py-8 text-center text-sm text-gray-500">
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
    <div className="border-t border-gray-100 bg-gray-50 px-5 py-4" data-testid={`dir-users-${dirId}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5 text-sm font-medium text-gray-700">
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
            <label htmlFor={`user-name-${dirId}`} className="block text-xs font-medium text-gray-600">Username</label>
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
            <label htmlFor={`user-pass-${dirId}`} className="block text-xs font-medium text-gray-600">Password</label>
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
            <div key={u.id} className="flex items-center justify-between rounded-md bg-white px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-900">{u.username}</span>
                {!u.enabled && (
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-600">disabled</span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {u.enabled && (
                  <button
                    type="button"
                    onClick={() => disableUser.mutate(u.id)}
                    className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                    data-testid={`disable-user-${u.id}`}
                  >
                    Disable
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => deleteUser.mutate(u.id)}
                  className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
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
