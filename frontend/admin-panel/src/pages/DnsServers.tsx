import { useState, type FormEvent } from 'react';
import { Globe, Plus, Loader2, AlertCircle, CheckCircle, Trash2, Plug, X, Edit, RefreshCw, Copy, Layers, Star } from 'lucide-react';
import clsx from 'clsx';
import {
  useDnsServers, useCreateDnsServer, useUpdateDnsServer, useDeleteDnsServer, useTestDnsServer,
  useDnsProviderGroups, useCreateDnsProviderGroup, useUpdateDnsProviderGroup, useDeleteDnsProviderGroup,
  type DnsServer, type DnsProviderGroup,
} from '@/hooks/use-dns-servers';

const INPUT_CLASS = 'mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2.5 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 placeholder:text-gray-400 dark:placeholder:text-gray-500 dark:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

const PROVIDERS = [
  { value: 'powerdns', label: 'PowerDNS (API v4/v5)' },
  { value: 'rndc', label: 'BIND9 (rndc)' },
  { value: 'cloudflare', label: 'Cloudflare' },
  { value: 'route53', label: 'AWS Route53' },
  { value: 'hetzner', label: 'Hetzner DNS' },
  { value: 'mock', label: 'Mock (Testing)' },
] as const;

function generateRndcSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function generateKeyName(): string {
  return `platform-key-${Math.random().toString(36).slice(2, 8)}`;
}

export default function DnsServers() {
  const { data: response, isLoading } = useDnsServers();
  const { data: groupsResponse, isLoading: groupsLoading } = useDnsProviderGroups();
  const servers = response?.data ?? [];
  const groups = groupsResponse?.data ?? [];
  const [showAdd, setShowAdd] = useState(false);

  if (isLoading || groupsLoading) return <div className="flex items-center justify-center py-20"><Loader2 size={24} className="animate-spin text-brand-500" /></div>;

  return (
    <div className="space-y-6" data-testid="dns-servers-page">
      <div className="flex items-center gap-3">
        <Globe size={28} className="text-brand-500" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">DNS Servers</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">Manage DNS provider groups and servers for domain provisioning.</p>
        </div>
      </div>

      {/* Provider Groups Section */}
      <ProviderGroupsSection groups={groups} servers={servers} />

      {/* Servers Section */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm" data-testid="dns-servers-section">
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Servers</h2>
          <button type="button" onClick={() => setShowAdd((p) => !p)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600" data-testid="add-dns-server-button">
            {showAdd ? <X size={14} /> : <Plus size={14} />} {showAdd ? 'Cancel' : 'Add Server'}
          </button>
        </div>
        {showAdd && <DnsServerForm groups={groups} onClose={() => setShowAdd(false)} />}
        {servers.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">No DNS servers configured.</div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-700">{servers.map((s) => <ServerRow key={s.id} server={s} groups={groups} />)}</div>
        )}
      </div>
    </div>
  );
}

// ─── Provider Groups Section ────────────────────────────────────────────────

function ProviderGroupsSection({ groups, servers }: {
  readonly groups: readonly DnsProviderGroup[];
  readonly servers: readonly DnsServer[];
}) {
  const [showAdd, setShowAdd] = useState(false);

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm" data-testid="dns-provider-groups-section">
      <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-5 py-4">
        <div className="flex items-center gap-2">
          <Layers size={18} className="text-brand-500" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Provider Groups</h2>
        </div>
        <button type="button" onClick={() => setShowAdd((p) => !p)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600" data-testid="add-provider-group-button">
          {showAdd ? <X size={14} /> : <Plus size={14} />} {showAdd ? 'Cancel' : 'Add Group'}
        </button>
      </div>
      {showAdd && <ProviderGroupForm onClose={() => setShowAdd(false)} />}
      {groups.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          No provider groups configured. Create a group and assign servers to organize DNS provisioning.
        </div>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-700">
          {groups.map((g) => (
            <ProviderGroupRow key={g.id} group={g} servers={servers.filter((s) => s.groupId === g.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Provider Group Form ────────────────────────────────────────────────────

interface ProviderGroupFormProps {
  readonly onClose: () => void;
  readonly initial?: DnsProviderGroup;
}

function ProviderGroupForm({ onClose, initial }: ProviderGroupFormProps) {
  const create = useCreateDnsProviderGroup();
  const update = useUpdateDnsProviderGroup();
  const isEdit = Boolean(initial);

  const [form, setForm] = useState({
    name: initial?.name ?? '',
    is_default: initial?.isDefault ?? false,
    ns_hostnames: initial?.nsHostnames?.join(', ') ?? '',
  });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const nsHostnames = form.ns_hostnames
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const payload = {
      name: form.name,
      is_default: form.is_default,
      ns_hostnames: nsHostnames.length > 0 ? nsHostnames : undefined,
    };
    try {
      if (isEdit && initial) {
        await update.mutateAsync({ id: initial.id, ...payload });
      } else {
        await create.mutateAsync(payload);
      }
      onClose();
    } catch { /* error shown below */ }
  };

  const error = isEdit ? update.error : create.error;
  const isPending = isEdit ? update.isPending : create.isPending;

  return (
    <form onSubmit={handleSubmit} className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 space-y-3" data-testid={isEdit ? 'edit-provider-group-form' : 'add-provider-group-form'}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Group Name</label>
          <input type="text" className={INPUT_CLASS} placeholder="Primary Group" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required data-testid="provider-group-name-input" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">NS Hostnames (comma-separated)</label>
          <input type="text" className={INPUT_CLASS} placeholder="ns1.example.com, ns2.example.com" value={form.ns_hostnames} onChange={(e) => setForm({ ...form, ns_hostnames: e.target.value })} data-testid="provider-group-ns-input" />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input type="checkbox" checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} className="rounded border-gray-300 dark:border-gray-600 text-brand-500 focus:ring-brand-500" data-testid="provider-group-default-checkbox" />
        Set as default group (new domains will use this group)
      </label>
      {error && <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400"><AlertCircle size={14} />{error instanceof Error ? error.message : 'Failed'}</div>}
      <div className="flex gap-2 justify-end">
        {isEdit && <button type="button" onClick={onClose} className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>}
        <button type="submit" disabled={isPending} className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="submit-provider-group">
          {isPending && <Loader2 size={14} className="animate-spin" />} {isEdit ? 'Save' : 'Create Group'}
        </button>
      </div>
    </form>
  );
}

// ─── Provider Group Row ─────────────────────────────────────────────────────

function ProviderGroupRow({ group, servers }: {
  readonly group: DnsProviderGroup;
  readonly servers: readonly DnsServer[];
}) {
  const del = useDeleteDnsProviderGroup();
  const update = useUpdateDnsProviderGroup();
  const [confirmDel, setConfirmDel] = useState(false);
  const [editing, setEditing] = useState(false);

  if (editing) {
    return <ProviderGroupForm initial={group} onClose={() => setEditing(false)} />;
  }

  const primaryCount = servers.filter((s) => s.role === 'primary').length;
  const secondaryCount = servers.filter((s) => s.role === 'secondary').length;

  return (
    <div className="px-5 py-4" data-testid={`provider-group-${group.id}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Layers size={16} className="text-gray-400 dark:text-gray-500" />
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{group.name}</span>
          {group.isDefault && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
              <Star size={10} /> default
            </span>
          )}
          <span className="rounded bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-400">
            {primaryCount} primary, {secondaryCount} secondary
          </span>
          {(group.domainCount ?? 0) > 0 && (
            <span className="rounded bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400">
              {group.domainCount} domain{group.domainCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!group.isDefault && (
            <button type="button" onClick={() => update.mutate({ id: group.id, is_default: true })} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50" data-testid={`set-default-group-${group.id}`}>
              Set Default
            </button>
          )}
          <button type="button" onClick={() => setEditing(true)} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50" data-testid={`edit-group-${group.id}`}>
            <Edit size={12} />
          </button>
          {confirmDel ? (
            <>
              <button type="button" onClick={async () => { try { await del.mutateAsync(group.id); } catch { /* shown inline */ } setConfirmDel(false); }} className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700">Confirm</button>
              <button type="button" onClick={() => setConfirmDel(false)} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmDel(true)} className="rounded-md border border-red-200 dark:border-red-800 px-2.5 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20" data-testid={`delete-group-${group.id}`}>
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>
      {del.isError && <div className="mt-2 flex items-center gap-1 text-xs text-red-600 dark:text-red-400"><AlertCircle size={12} /> {del.error instanceof Error ? del.error.message : 'Failed to delete'}</div>}
      {group.nsHostnames && group.nsHostnames.length > 0 && (
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">NS: {group.nsHostnames.join(', ')}</p>
      )}
      {servers.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {servers.map((s) => (
            <span key={s.id} className={clsx(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs',
              s.enabled ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
            )}>
              <span className={clsx('h-1.5 w-1.5 rounded-full', s.enabled ? 'bg-green-500' : 'bg-gray-400')} />
              {s.displayName}
              <span className="text-[10px] opacity-70">({s.role})</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Shared Form for Add + Edit ──────────────────────────────────────────────

interface DnsServerFormProps {
  readonly onClose: () => void;
  readonly initial?: DnsServer;
  readonly groups?: readonly DnsProviderGroup[];
}

function DnsServerForm({ onClose, initial, groups = [] }: DnsServerFormProps) {
  const create = useCreateDnsServer();
  const update = useUpdateDnsServer();
  const isEdit = Boolean(initial);

  const [form, setForm] = useState({
    display_name: initial?.displayName ?? '',
    provider_type: initial?.providerType ?? 'powerdns',
    zone_default_kind: (initial?.zoneDefaultKind ?? 'Native') as 'Native' | 'Master',
    group_id: initial?.groupId ?? '',
    role: (initial?.role ?? 'primary') as 'primary' | 'secondary',
    // PowerDNS
    api_url: '', api_key: '', server_id: 'localhost', api_version: 'v4',
    // RNDC
    server_host: '', rndc_port: '953',
    rndc_key_name: generateKeyName(),
    rndc_key_algorithm: 'hmac-sha256',
    rndc_key_secret: generateRndcSecret(),
    // Cloudflare / Hetzner
    api_token: '',
    // Route53
    access_key_id: '', secret_access_key: '', region: 'us-east-1', hosted_zone_id: '',
  });

  const buildConfig = (): Record<string, unknown> => {
    switch (form.provider_type) {
      case 'powerdns': return { api_url: form.api_url, api_key: form.api_key, server_id: form.server_id, api_version: form.api_version };
      case 'rndc': return { server_host: form.server_host, rndc_port: Number(form.rndc_port), rndc_key_name: form.rndc_key_name, rndc_key_algorithm: form.rndc_key_algorithm, rndc_key_secret: form.rndc_key_secret };
      case 'cloudflare': return { api_token: form.api_token };
      case 'hetzner': return { api_token: form.api_token };
      case 'route53': return { access_key_id: form.access_key_id, secret_access_key: form.secret_access_key, region: form.region, hosted_zone_id: form.hosted_zone_id || undefined };
      default: return {};
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const payload = {
      display_name: form.display_name,
      provider_type: form.provider_type,
      connection_config: buildConfig(),
      zone_default_kind: form.provider_type === 'powerdns' ? form.zone_default_kind : 'Native' as const,
      group_id: form.group_id || undefined,
      role: form.role,
    };
    try {
      if (isEdit && initial) {
        await update.mutateAsync({ id: initial.id, ...payload });
      } else {
        await create.mutateAsync(payload);
      }
      onClose();
    } catch {}
  };

  const error = isEdit ? update.error : create.error;
  const isPending = isEdit ? update.isPending : create.isPending;

  const bindConfigSample = `# Add to /etc/bind/named.conf on your BIND9 server:

key "${form.rndc_key_name}" {
    algorithm ${form.rndc_key_algorithm};
    secret "${form.rndc_key_secret}";
};

controls {
    inet * port ${form.rndc_port} allow { any; } keys { "${form.rndc_key_name}"; };
};

# Add to options {} block to allow rndc to create new zones:
options {
    // ... existing options ...
    allow-new-zones yes;
};`;

  return (
    <form onSubmit={handleSubmit} className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 space-y-3" data-testid={isEdit ? 'edit-dns-server-form' : 'add-dns-server-form'}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Display Name</label><input type="text" className={INPUT_CLASS} placeholder="Primary DNS" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} required data-testid="dns-server-name-input" /></div>
        <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Provider</label>
          <select className={INPUT_CLASS} value={form.provider_type} onChange={(e) => setForm({ ...form, provider_type: e.target.value })} disabled={isEdit} data-testid="dns-provider-select">
            {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Provider Group</label>
          <select className={INPUT_CLASS} value={form.group_id} onChange={(e) => setForm({ ...form, group_id: e.target.value })} data-testid="dns-server-group-select">
            <option value="">No group</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}{g.isDefault ? ' (default)' : ''}</option>)}
          </select>
        </div>
        <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Role</label>
          <select className={INPUT_CLASS} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'primary' | 'secondary' })} data-testid="dns-server-role-select">
            <option value="primary">Primary</option>
            <option value="secondary">Secondary</option>
          </select>
        </div>
        {form.provider_type === 'powerdns' && (
          <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Zone Default Kind</label>
            <select className={INPUT_CLASS} value={form.zone_default_kind} onChange={(e) => setForm({ ...form, zone_default_kind: e.target.value as 'Native' | 'Master' })} data-testid="dns-zone-kind-select">
              <option value="Native">Native</option><option value="Master">Master</option>
            </select>
          </div>
        )}
      </div>

      {/* PowerDNS fields */}
      {form.provider_type === 'powerdns' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">API URL</label><input type="url" className={INPUT_CLASS} placeholder="http://powerdns:8081" value={form.api_url} onChange={(e) => setForm({ ...form, api_url: e.target.value })} required /></div>
          <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">API Key</label><input type="text" className={INPUT_CLASS} value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} required /></div>
          <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Server ID</label><input type="text" className={INPUT_CLASS} value={form.server_id} onChange={(e) => setForm({ ...form, server_id: e.target.value })} /></div>
          <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">API Version</label>
            <select className={INPUT_CLASS} value={form.api_version} onChange={(e) => setForm({ ...form, api_version: e.target.value })}><option value="v4">v4</option><option value="v5">v5</option></select>
          </div>
        </div>
      )}

      {/* RNDC/BIND fields */}
      {form.provider_type === 'rndc' && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">BIND Server Host</label><input type="text" className={INPUT_CLASS} placeholder="dns.example.com" value={form.server_host} onChange={(e) => setForm({ ...form, server_host: e.target.value })} required /></div>
            <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">rndc Port</label><input type="number" className={INPUT_CLASS} value={form.rndc_port} onChange={(e) => setForm({ ...form, rndc_port: e.target.value })} /></div>
            <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Key Algorithm</label>
              <select className={INPUT_CLASS} value={form.rndc_key_algorithm} onChange={(e) => {
                setForm({ ...form, rndc_key_algorithm: e.target.value, rndc_key_secret: generateRndcSecret() });
              }}>
                <option value="hmac-sha256">HMAC-SHA256</option><option value="hmac-sha512">HMAC-SHA512</option><option value="hmac-md5">HMAC-MD5</option>
              </select>
            </div>
            <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Key Name</label><input type="text" className={INPUT_CLASS} value={form.rndc_key_name} onChange={(e) => setForm({ ...form, rndc_key_name: e.target.value })} required /></div>
            <div className="sm:col-span-2">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Key Secret (Base64)</label>
                <button type="button" onClick={() => setForm({ ...form, rndc_key_secret: generateRndcSecret() })} className="inline-flex items-center gap-1 text-xs text-brand-600 dark:text-brand-400 hover:text-brand-700 dark:text-brand-300" data-testid="regenerate-rndc-secret">
                  <RefreshCw size={12} /> Regenerate
                </button>
              </div>
              <input type="text" className={INPUT_CLASS + ' font-mono text-xs'} value={form.rndc_key_secret} onChange={(e) => setForm({ ...form, rndc_key_secret: e.target.value })} required />
            </div>
          </div>

          {/* BIND configuration code sample */}
          <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-blue-800 dark:text-blue-300">Add this to your BIND9 configuration:</p>
              <button type="button" onClick={() => navigator.clipboard.writeText(bindConfigSample)} className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:text-blue-400">
                <Copy size={12} /> Copy
              </button>
            </div>
            <pre className="overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-green-400 whitespace-pre-wrap" data-testid="bind-config-sample">{bindConfigSample}</pre>
          </div>
        </>
      )}

      {/* Cloudflare / Hetzner — single token */}
      {(form.provider_type === 'cloudflare' || form.provider_type === 'hetzner') && (
        <div>
          <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">API Token</label>
          <input type="text" className={INPUT_CLASS + ' font-mono'} placeholder="Bearer token" value={form.api_token} onChange={(e) => setForm({ ...form, api_token: e.target.value })} required />
        </div>
      )}

      {/* Route53 — AWS credentials */}
      {form.provider_type === 'route53' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Access Key ID</label><input type="text" className={INPUT_CLASS + ' font-mono'} value={form.access_key_id} onChange={(e) => setForm({ ...form, access_key_id: e.target.value })} required /></div>
          <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Secret Access Key</label><input type="text" className={INPUT_CLASS + ' font-mono'} value={form.secret_access_key} onChange={(e) => setForm({ ...form, secret_access_key: e.target.value })} required /></div>
          <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Region</label><input type="text" className={INPUT_CLASS} value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} /></div>
          <div><label className="block text-xs font-medium text-gray-700 dark:text-gray-300">Hosted Zone ID (optional)</label><input type="text" className={INPUT_CLASS + ' font-mono'} value={form.hosted_zone_id} onChange={(e) => setForm({ ...form, hosted_zone_id: e.target.value })} /></div>
        </div>
      )}

      {error && <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400"><AlertCircle size={14} />{error instanceof Error ? error.message : 'Failed'}</div>}
      <div className="flex gap-2 justify-end">
        {isEdit && <button type="button" onClick={onClose} className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>}
        <button type="submit" disabled={isPending} className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="submit-dns-server">{isPending && <Loader2 size={14} className="animate-spin" />} {isEdit ? 'Save' : 'Add Server'}</button>
      </div>
    </form>
  );
}

// ─── Server Row (with edit toggle) ───────────────────────────────────────────

function ServerRow({ server, groups }: { readonly server: DnsServer; readonly groups: readonly DnsProviderGroup[] }) {
  const update = useUpdateDnsServer();
  const del = useDeleteDnsServer();
  const test = useTestDnsServer();
  const [confirmDel, setConfirmDel] = useState(false);
  const [editing, setEditing] = useState(false);

  if (editing) {
    return <DnsServerForm initial={server} groups={groups} onClose={() => setEditing(false)} />;
  }

  const healthColor = server.lastHealthStatus === 'ok' ? 'bg-green-500' : server.lastHealthStatus === 'error' ? 'bg-red-500' : 'bg-gray-300';
  const groupName = server.groupId ? groups.find((g) => g.id === server.groupId)?.name : null;

  return (
    <div className="px-5 py-4" data-testid={`dns-server-${server.id}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 flex-wrap">
          <div className={clsx('h-2.5 w-2.5 rounded-full', healthColor)} />
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{server.displayName}</span>
          <span className="rounded bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-400">{server.providerType}</span>
          <span className={clsx(
            'rounded px-2 py-0.5 text-xs',
            server.role === 'primary' ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400' : 'bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400',
          )}>{server.role}</span>
          {server.providerType === 'powerdns' && <span className="rounded bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400">{server.zoneDefaultKind}</span>}
          {server.isDefault && <span className="rounded bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">default</span>}
          {groupName && <span className="rounded bg-indigo-50 dark:bg-indigo-900/20 px-2 py-0.5 text-xs text-indigo-600 dark:text-indigo-400">{groupName}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setEditing(true)} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50" data-testid={`edit-dns-${server.id}`}><Edit size={12} /></button>
          <button type="button" onClick={() => update.mutate({ id: server.id, enabled: !server.enabled })} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50" data-testid={`toggle-dns-${server.id}`}>{server.enabled ? 'Disable' : 'Enable'}</button>
          <button type="button" onClick={() => test.mutate(server.id)} disabled={test.isPending} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-50" data-testid={`test-dns-${server.id}`}>{test.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}</button>
          {confirmDel ? (
            <><button type="button" onClick={async () => { await del.mutateAsync(server.id); setConfirmDel(false); }} className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700">Confirm</button><button type="button" onClick={() => setConfirmDel(false)} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button></>
          ) : (
            <button type="button" onClick={() => setConfirmDel(true)} className="rounded-md border border-red-200 dark:border-red-800 px-2.5 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20" data-testid={`delete-dns-${server.id}`}><Trash2 size={12} /></button>
          )}
        </div>
      </div>
      {server.lastHealthCheck && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Last check: {new Date(server.lastHealthCheck).toLocaleString()} — {server.lastHealthStatus}</p>}
      {test.isSuccess && <div className="mt-2 flex items-center gap-1 text-xs text-green-600 dark:text-green-400"><CheckCircle size={12} /> {(test.data as { data?: { message?: string; version?: string } })?.data?.message ?? 'Connected'} {(test.data as { data?: { message?: string; version?: string } })?.data?.version ? `(${(test.data as { data?: { message?: string; version?: string } }).data?.version})` : ''}</div>}
      {test.isError && <div className="mt-2 flex items-center gap-1 text-xs text-red-600 dark:text-red-400"><AlertCircle size={12} /> {test.error instanceof Error ? test.error.message : 'Failed'}</div>}
    </div>
  );
}
