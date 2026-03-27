import { useState, type FormEvent } from 'react';
import { Globe, Plus, Loader2, AlertCircle, CheckCircle, Trash2, Plug, X, Edit } from 'lucide-react';
import clsx from 'clsx';
import { useDnsServers, useCreateDnsServer, useUpdateDnsServer, useDeleteDnsServer, useTestDnsServer, type DnsServer } from '@/hooks/use-dns-servers';

const INPUT_CLASS = 'mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

const PROVIDERS = [
  { value: 'powerdns', label: 'PowerDNS (API v4/v5)' },
  { value: 'mock', label: 'Mock (Testing)' },
  { value: 'rndc', label: 'BIND9 (rndc) — Planned' },
  { value: 'cloudflare', label: 'Cloudflare — Planned' },
  { value: 'route53', label: 'AWS Route53 — Planned' },
  { value: 'hetzner', label: 'Hetzner DNS — Planned' },
] as const;

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

        {showAdd && <AddServerForm onClose={() => setShowAdd(false)} />}

        {servers.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-500">No DNS servers configured. Add one to enable external DNS management.</div>
        ) : (
          <div className="divide-y divide-gray-100">{servers.map((s) => <ServerRow key={s.id} server={s} />)}</div>
        )}
      </div>
    </div>
  );
}

function AddServerForm({ onClose }: { readonly onClose: () => void }) {
  const create = useCreateDnsServer();
  const [form, setForm] = useState({
    display_name: '', provider_type: 'powerdns', zone_default_kind: 'Native' as 'Native' | 'Master',
    api_url: '', api_key: '', server_id: 'localhost', api_version: 'v4',
  });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const connectionConfig = form.provider_type === 'mock' ? {} : {
      api_url: form.api_url, api_key: form.api_key, server_id: form.server_id, api_version: form.api_version,
    };
    try {
      await create.mutateAsync({ display_name: form.display_name, provider_type: form.provider_type, connection_config: connectionConfig, zone_default_kind: form.zone_default_kind });
      onClose();
    } catch {}
  };

  return (
    <form onSubmit={handleSubmit} className="border-b border-gray-100 bg-gray-50 p-4 space-y-3" data-testid="add-dns-server-form">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div><label className="block text-xs font-medium text-gray-700">Display Name</label><input type="text" className={INPUT_CLASS} placeholder="Primary DNS" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} required data-testid="dns-server-name-input" /></div>
        <div><label className="block text-xs font-medium text-gray-700">Provider</label>
          <select className={INPUT_CLASS} value={form.provider_type} onChange={(e) => setForm({ ...form, provider_type: e.target.value })} data-testid="dns-provider-select">
            {PROVIDERS.filter((p) => !p.label.includes('Planned')).map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        <div><label className="block text-xs font-medium text-gray-700">Zone Default Kind</label>
          <select className={INPUT_CLASS} value={form.zone_default_kind} onChange={(e) => setForm({ ...form, zone_default_kind: e.target.value as 'Native' | 'Master' })} data-testid="dns-zone-kind-select">
            <option value="Native">Native</option><option value="Master">Master</option>
          </select>
        </div>
      </div>
      {form.provider_type === 'powerdns' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label className="block text-xs font-medium text-gray-700">API URL</label><input type="url" className={INPUT_CLASS} placeholder="http://powerdns:8081" value={form.api_url} onChange={(e) => setForm({ ...form, api_url: e.target.value })} required data-testid="dns-api-url-input" /></div>
          <div><label className="block text-xs font-medium text-gray-700">API Key</label><input type="password" className={INPUT_CLASS} value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} required data-testid="dns-api-key-input" /></div>
          <div><label className="block text-xs font-medium text-gray-700">Server ID</label><input type="text" className={INPUT_CLASS} value={form.server_id} onChange={(e) => setForm({ ...form, server_id: e.target.value })} data-testid="dns-server-id-input" /></div>
          <div><label className="block text-xs font-medium text-gray-700">API Version</label>
            <select className={INPUT_CLASS} value={form.api_version} onChange={(e) => setForm({ ...form, api_version: e.target.value })}>
              <option value="v4">v4</option><option value="v5">v5</option>
            </select>
          </div>
        </div>
      )}
      {create.error && <div className="flex items-center gap-2 text-sm text-red-600"><AlertCircle size={14} />{create.error instanceof Error ? create.error.message : 'Failed'}</div>}
      <div className="flex justify-end">
        <button type="submit" disabled={create.isPending} className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="submit-dns-server">{create.isPending && <Loader2 size={14} className="animate-spin" />} Add Server</button>
      </div>
    </form>
  );
}

function ServerRow({ server }: { readonly server: DnsServer }) {
  const update = useUpdateDnsServer();
  const del = useDeleteDnsServer();
  const test = useTestDnsServer();
  const [confirmDel, setConfirmDel] = useState(false);

  const healthColor = server.lastHealthStatus === 'ok' ? 'bg-green-500' : server.lastHealthStatus === 'error' ? 'bg-red-500' : 'bg-gray-300';

  return (
    <div className="px-5 py-4" data-testid={`dns-server-${server.id}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={clsx('h-2.5 w-2.5 rounded-full', healthColor)} />
          <span className="text-sm font-medium text-gray-900">{server.displayName}</span>
          <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">{server.providerType}</span>
          <span className="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-600">{server.zoneDefaultKind}</span>
          {server.isDefault && <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-700">default</span>}
        </div>
        <div className="flex items-center gap-2">
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
