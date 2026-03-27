import { useState, type FormEvent } from 'react';
import { Globe, Plus, Loader2, AlertCircle, CheckCircle, Trash2, Plug, X, Edit, RefreshCw, Copy } from 'lucide-react';
import clsx from 'clsx';
import { useDnsServers, useCreateDnsServer, useUpdateDnsServer, useDeleteDnsServer, useTestDnsServer, type DnsServer } from '@/hooks/use-dns-servers';

const INPUT_CLASS = 'mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

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
  const servers = response?.data ?? [];
  const [showAdd, setShowAdd] = useState(false);

  if (isLoading) return <div className="flex items-center justify-center py-20"><Loader2 size={24} className="animate-spin text-brand-500" /></div>;

  return (
    <div className="space-y-6" data-testid="dns-servers-page">
      <div className="flex items-center gap-3">
        <Globe size={28} className="text-brand-500" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">DNS Servers</h1>
          <p className="text-sm text-gray-500">Manage external DNS servers for domain provisioning.</p>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm" data-testid="dns-servers-section">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h2 className="text-lg font-semibold text-gray-900">Servers</h2>
          <button type="button" onClick={() => setShowAdd((p) => !p)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600" data-testid="add-dns-server-button">
            {showAdd ? <X size={14} /> : <Plus size={14} />} {showAdd ? 'Cancel' : 'Add Server'}
          </button>
        </div>
        {showAdd && <DnsServerForm onClose={() => setShowAdd(false)} />}
        {servers.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-500">No DNS servers configured.</div>
        ) : (
          <div className="divide-y divide-gray-100">{servers.map((s) => <ServerRow key={s.id} server={s} />)}</div>
        )}
      </div>
    </div>
  );
}

// ─── Shared Form for Add + Edit ──────────────────────────────────────────────

interface DnsServerFormProps {
  readonly onClose: () => void;
  readonly initial?: DnsServer;
}

function DnsServerForm({ onClose, initial }: DnsServerFormProps) {
  const create = useCreateDnsServer();
  const update = useUpdateDnsServer();
  const isEdit = Boolean(initial);

  const [form, setForm] = useState({
    display_name: initial?.displayName ?? '',
    provider_type: initial?.providerType ?? 'powerdns',
    zone_default_kind: (initial?.zoneDefaultKind ?? 'Native') as 'Native' | 'Master',
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
    inet 0.0.0.0 port ${form.rndc_port} allow { PLATFORM_IP; } keys { "${form.rndc_key_name}"; };
};

# Add to options {} block to allow rndc to create new zones:
options {
    // ... existing options ...
    allow-new-zones yes;
};`;

  return (
    <form onSubmit={handleSubmit} className="border-b border-gray-100 bg-gray-50 p-4 space-y-3" data-testid={isEdit ? 'edit-dns-server-form' : 'add-dns-server-form'}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div><label className="block text-xs font-medium text-gray-700">Display Name</label><input type="text" className={INPUT_CLASS} placeholder="Primary DNS" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} required data-testid="dns-server-name-input" /></div>
        <div><label className="block text-xs font-medium text-gray-700">Provider</label>
          <select className={INPUT_CLASS} value={form.provider_type} onChange={(e) => setForm({ ...form, provider_type: e.target.value })} disabled={isEdit} data-testid="dns-provider-select">
            {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        {form.provider_type === 'powerdns' && (
          <div><label className="block text-xs font-medium text-gray-700">Zone Default Kind</label>
            <select className={INPUT_CLASS} value={form.zone_default_kind} onChange={(e) => setForm({ ...form, zone_default_kind: e.target.value as 'Native' | 'Master' })} data-testid="dns-zone-kind-select">
              <option value="Native">Native</option><option value="Master">Master</option>
            </select>
          </div>
        )}
      </div>

      {/* PowerDNS fields */}
      {form.provider_type === 'powerdns' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label className="block text-xs font-medium text-gray-700">API URL</label><input type="url" className={INPUT_CLASS} placeholder="http://powerdns:8081" value={form.api_url} onChange={(e) => setForm({ ...form, api_url: e.target.value })} required /></div>
          <div><label className="block text-xs font-medium text-gray-700">API Key</label><input type="text" className={INPUT_CLASS} value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} required /></div>
          <div><label className="block text-xs font-medium text-gray-700">Server ID</label><input type="text" className={INPUT_CLASS} value={form.server_id} onChange={(e) => setForm({ ...form, server_id: e.target.value })} /></div>
          <div><label className="block text-xs font-medium text-gray-700">API Version</label>
            <select className={INPUT_CLASS} value={form.api_version} onChange={(e) => setForm({ ...form, api_version: e.target.value })}><option value="v4">v4</option><option value="v5">v5</option></select>
          </div>
        </div>
      )}

      {/* RNDC/BIND fields */}
      {form.provider_type === 'rndc' && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div><label className="block text-xs font-medium text-gray-700">BIND Server Host</label><input type="text" className={INPUT_CLASS} placeholder="dns.example.com" value={form.server_host} onChange={(e) => setForm({ ...form, server_host: e.target.value })} required /></div>
            <div><label className="block text-xs font-medium text-gray-700">rndc Port</label><input type="number" className={INPUT_CLASS} value={form.rndc_port} onChange={(e) => setForm({ ...form, rndc_port: e.target.value })} /></div>
            <div><label className="block text-xs font-medium text-gray-700">Key Algorithm</label>
              <select className={INPUT_CLASS} value={form.rndc_key_algorithm} onChange={(e) => {
                setForm({ ...form, rndc_key_algorithm: e.target.value, rndc_key_secret: generateRndcSecret() });
              }}>
                <option value="hmac-sha256">HMAC-SHA256</option><option value="hmac-sha512">HMAC-SHA512</option><option value="hmac-md5">HMAC-MD5</option>
              </select>
            </div>
            <div><label className="block text-xs font-medium text-gray-700">Key Name</label><input type="text" className={INPUT_CLASS} value={form.rndc_key_name} onChange={(e) => setForm({ ...form, rndc_key_name: e.target.value })} required /></div>
            <div className="sm:col-span-2">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-medium text-gray-700">Key Secret (Base64)</label>
                <button type="button" onClick={() => setForm({ ...form, rndc_key_secret: generateRndcSecret() })} className="inline-flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700" data-testid="regenerate-rndc-secret">
                  <RefreshCw size={12} /> Regenerate
                </button>
              </div>
              <input type="text" className={INPUT_CLASS + ' font-mono text-xs'} value={form.rndc_key_secret} onChange={(e) => setForm({ ...form, rndc_key_secret: e.target.value })} required />
            </div>
          </div>

          {/* BIND configuration code sample */}
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-blue-800">Add this to your BIND9 configuration:</p>
              <button type="button" onClick={() => navigator.clipboard.writeText(bindConfigSample)} className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700">
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
          <label className="block text-xs font-medium text-gray-700">API Token</label>
          <input type="text" className={INPUT_CLASS + ' font-mono'} placeholder="Bearer token" value={form.api_token} onChange={(e) => setForm({ ...form, api_token: e.target.value })} required />
        </div>
      )}

      {/* Route53 — AWS credentials */}
      {form.provider_type === 'route53' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label className="block text-xs font-medium text-gray-700">Access Key ID</label><input type="text" className={INPUT_CLASS + ' font-mono'} value={form.access_key_id} onChange={(e) => setForm({ ...form, access_key_id: e.target.value })} required /></div>
          <div><label className="block text-xs font-medium text-gray-700">Secret Access Key</label><input type="text" className={INPUT_CLASS + ' font-mono'} value={form.secret_access_key} onChange={(e) => setForm({ ...form, secret_access_key: e.target.value })} required /></div>
          <div><label className="block text-xs font-medium text-gray-700">Region</label><input type="text" className={INPUT_CLASS} value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} /></div>
          <div><label className="block text-xs font-medium text-gray-700">Hosted Zone ID (optional)</label><input type="text" className={INPUT_CLASS + ' font-mono'} value={form.hosted_zone_id} onChange={(e) => setForm({ ...form, hosted_zone_id: e.target.value })} /></div>
        </div>
      )}

      {error && <div className="flex items-center gap-2 text-sm text-red-600"><AlertCircle size={14} />{error instanceof Error ? error.message : 'Failed'}</div>}
      <div className="flex gap-2 justify-end">
        {isEdit && <button type="button" onClick={onClose} className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>}
        <button type="submit" disabled={isPending} className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="submit-dns-server">{isPending && <Loader2 size={14} className="animate-spin" />} {isEdit ? 'Save' : 'Add Server'}</button>
      </div>
    </form>
  );
}

// ─── Server Row (with edit toggle) ───────────────────────────────────────────

function ServerRow({ server }: { readonly server: DnsServer }) {
  const update = useUpdateDnsServer();
  const del = useDeleteDnsServer();
  const test = useTestDnsServer();
  const [confirmDel, setConfirmDel] = useState(false);
  const [editing, setEditing] = useState(false);

  if (editing) {
    return <DnsServerForm initial={server} onClose={() => setEditing(false)} />;
  }

  const healthColor = server.lastHealthStatus === 'ok' ? 'bg-green-500' : server.lastHealthStatus === 'error' ? 'bg-red-500' : 'bg-gray-300';

  return (
    <div className="px-5 py-4" data-testid={`dns-server-${server.id}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={clsx('h-2.5 w-2.5 rounded-full', healthColor)} />
          <span className="text-sm font-medium text-gray-900">{server.displayName}</span>
          <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">{server.providerType}</span>
          {server.providerType === 'powerdns' && <span className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-600">{server.zoneDefaultKind}</span>}
          {server.isDefault && <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-700">default</span>}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setEditing(true)} className="rounded-md border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50" data-testid={`edit-dns-${server.id}`}><Edit size={12} /></button>
          <button type="button" onClick={() => update.mutate({ id: server.id, enabled: !server.enabled })} className="rounded-md border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50" data-testid={`toggle-dns-${server.id}`}>{server.enabled ? 'Disable' : 'Enable'}</button>
          <button type="button" onClick={() => test.mutate(server.id)} disabled={test.isPending} className="rounded-md border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50" data-testid={`test-dns-${server.id}`}>{test.isPending ? <Loader2 size={12} className="animate-spin" /> : <Plug size={12} />}</button>
          {confirmDel ? (
            <><button type="button" onClick={async () => { await del.mutateAsync(server.id); setConfirmDel(false); }} className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700">Confirm</button><button type="button" onClick={() => setConfirmDel(false)} className="rounded-md border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50">Cancel</button></>
          ) : (
            <button type="button" onClick={() => setConfirmDel(true)} className="rounded-md border border-red-200 px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50" data-testid={`delete-dns-${server.id}`}><Trash2 size={12} /></button>
          )}
        </div>
      </div>
      {server.lastHealthCheck && <p className="mt-1 text-xs text-gray-500">Last check: {new Date(server.lastHealthCheck).toLocaleString()} — {server.lastHealthStatus}</p>}
      {test.isSuccess && <div className="mt-2 flex items-center gap-1 text-xs text-green-600"><CheckCircle size={12} /> {(test.data as any)?.data?.message ?? 'Connected'} {(test.data as any)?.data?.version ? `(${(test.data as any).data.version})` : ''}</div>}
      {test.isError && <div className="mt-2 flex items-center gap-1 text-xs text-red-600"><AlertCircle size={12} /> {test.error instanceof Error ? test.error.message : 'Failed'}</div>}
    </div>
  );
}
