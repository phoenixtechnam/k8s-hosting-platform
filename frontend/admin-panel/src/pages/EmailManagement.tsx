import { useState } from 'react';
import { Mail, Globe, Server, Shield, Loader2, CheckCircle, XCircle, Plus, Trash2, TestTube, X, Key, RefreshCw, Copy } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import StatCard from '@/components/ui/StatCard';
import {
  useAdminEmailDomains,
  useSmtpRelays,
  useCreateSmtpRelay,
  useDeleteSmtpRelay,
  useTestSmtpRelay,
  useUpdateEmailDomain,
  useDkimKeys,
  useRotateDkimKey,
  useActivateDkimKey,
  type DkimKey,
  type DkimRotateResult,
} from '@/hooks/use-email';
import StalwartAdminPanel from '@/components/StalwartAdminPanel';
import MailServerSettings from '@/components/MailServerSettings';
import type { FormEvent } from 'react';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 placeholder:text-gray-400 dark:placeholder:text-gray-500 dark:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

type Tab = 'domains' | 'relays';

export default function EmailManagement() {
  const [tab, setTab] = useState<Tab>('domains');
  const { data: domainsRes, isLoading: domainsLoading } = useAdminEmailDomains();
  const domains = domainsRes?.data ?? [];

  const totalMailboxes = domains.reduce((sum, d) => sum + (d.mailboxCount ?? 0), 0);
  const dkimOk = domains.filter(d => d.dkimProvisioned).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Mail size={28} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="email-mgmt-heading">Email Management</h1>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Email Domains" value={domainsLoading ? '...' : domains.length} icon={Globe} accent="brand" />
        <StatCard title="Total Mailboxes" value={domainsLoading ? '...' : totalMailboxes} icon={Mail} accent="green" />
        <StatCard title="DKIM Configured" value={domainsLoading ? '...' : `${dkimOk}/${domains.length}`} icon={Shield} accent="amber" />
        <StatCard title="Mail Server" value="Stalwart" icon={Server} accent="green" />
      </div>

      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {[
          { key: 'domains' as Tab, label: 'Email Domains' },
          { key: 'relays' as Tab, label: 'SMTP Relays' },
        ].map(t => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)}
            className={`border-b-2 px-4 py-2.5 text-sm font-medium ${tab === t.key ? 'border-brand-500 text-brand-600 dark:text-brand-400' : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
            data-testid={`tab-${t.key}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'domains' && <EmailDomainsTable domains={domains} isLoading={domainsLoading} />}
      {tab === 'relays' && <SmtpRelaysSection />}

      <MailServerSettings />

      <StalwartAdminPanel />
    </div>
  );
}

interface EmailDomainRow {
  readonly id: string;
  readonly clientId: string;
  readonly domainId: string;
  readonly domainName: string;
  readonly mailboxCount?: number;
  readonly mxProvisioned: number;
  readonly spfProvisioned: number;
  readonly dkimProvisioned: number;
  readonly dmarcProvisioned: number;
  readonly spamThresholdJunk: string;
  readonly enabled: number;
  readonly webmailEnabled?: number;
}

function EmailDomainsTable({ domains, isLoading }: { readonly domains: readonly EmailDomainRow[]; readonly isLoading: boolean }) {
  const { sortedData: sortedDomains, sortKey, sortDirection, onSort } = useSortable(domains, 'domainName');
  const [dkimDomain, setDkimDomain] = useState<EmailDomainRow | null>(null);

  if (isLoading) return <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-brand-500" /></div>;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
      <table className="w-full" data-testid="email-domains-table">
        <thead>
          <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
            <SortableHeader label="Domain" sortKey="domainName" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
            <SortableHeader label="Mailboxes" sortKey="mailboxCount" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
            <th className="px-5 py-3">DNS Status</th>
            <SortableHeader label="Spam Filter" sortKey="spamThresholdJunk" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
            <th className="px-5 py-3">Webmail</th>
            <SortableHeader label="Status" sortKey="enabled" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
            <th className="px-5 py-3">DKIM</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
          {sortedDomains.map(d => (
            <EmailDomainRowView key={d.id} domain={d} onOpenDkim={() => setDkimDomain(d)} />
          ))}
          {domains.length === 0 && (
            <tr><td colSpan={7} className="px-5 py-10 text-center text-sm text-gray-500 dark:text-gray-400">No email-enabled domains yet.</td></tr>
          )}
        </tbody>
      </table>

      {dkimDomain && (
        <DkimRotationModal
          domain={dkimDomain}
          onClose={() => setDkimDomain(null)}
        />
      )}
    </div>
  );
}

function EmailDomainRowView({ domain: d, onOpenDkim }: { readonly domain: EmailDomainRow; readonly onOpenDkim: () => void }) {
  const updateDomain = useUpdateEmailDomain(d.clientId);
  const webmailOn = d.webmailEnabled !== 0 && d.webmailEnabled !== undefined ? d.webmailEnabled === 1 : true;

  const toggleWebmail = () => {
    updateDomain.mutate({ domainId: d.domainId, input: { webmail_enabled: !webmailOn } });
  };

  return (
    <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
      <td className="px-5 py-3.5 font-medium text-gray-900 dark:text-gray-100">{d.domainName}</td>
      <td className="px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400">{d.mailboxCount ?? 0}</td>
      <td className="px-5 py-3.5">
        <div className="flex gap-1.5">
          {['MX', 'SPF', 'DKIM', 'DMARC'].map((rec, i) => {
            const provisioned = [d.mxProvisioned, d.spfProvisioned, d.dkimProvisioned, d.dmarcProvisioned][i];
            return (
              <span key={rec} className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-medium ${provisioned ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'}`}>
                {provisioned ? <CheckCircle size={10} /> : <XCircle size={10} />} {rec}
              </span>
            );
          })}
        </div>
      </td>
      <td className="px-5 py-3.5 text-xs text-gray-500 dark:text-gray-400">Junk: {d.spamThresholdJunk}</td>
      <td className="px-5 py-3.5">
        <button
          type="button"
          onClick={toggleWebmail}
          disabled={updateDomain.isPending}
          title={`webmail.${d.domainName} — ${webmailOn ? 'enabled' : 'disabled'}`}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 ${
            webmailOn ? 'bg-brand-500' : 'bg-gray-200 dark:bg-gray-600'
          }`}
          data-testid={`webmail-toggle-${d.id}`}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
              webmailOn ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
      </td>
      <td className="px-5 py-3.5"><StatusBadge status={d.enabled ? 'active' : 'suspended'} /></td>
      <td className="px-5 py-3.5">
        <button
          type="button"
          onClick={onOpenDkim}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-600 px-2 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          data-testid={`dkim-button-${d.id}`}
          title="Manage DKIM keys"
        >
          <Key size={12} /> DKIM
        </button>
      </td>
    </tr>
  );
}

// ─── DKIM Rotation Modal ──────────────────────────────────────────────────

function DkimRotationModal({ domain: d, onClose }: { readonly domain: EmailDomainRow; readonly onClose: () => void }) {
  const { data: keysRes, isLoading } = useDkimKeys(d.clientId, d.domainId);
  const keys = keysRes?.data ?? [];
  const rotate = useRotateDkimKey(d.clientId, d.domainId);
  const activate = useActivateDkimKey(d.clientId, d.domainId);
  const [lastRotation, setLastRotation] = useState<DkimRotateResult | null>(null);

  const handleRotate = async () => {
    setLastRotation(null);
    const res = await rotate.mutateAsync();
    setLastRotation(res.data);
  };

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-3xl rounded-xl bg-white dark:bg-gray-800 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-6 py-4">
          <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            <Key size={18} className="text-amber-500" />
            DKIM keys — {d.domainName}
          </h3>
          <button onClick={onClose} className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700" data-testid="dkim-modal-close">
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-6 py-4 space-y-4">
          {/* Rotation banner — primary mode auto-publishes, cname/secondary returns the record */}
          {lastRotation && (
            <div className={`rounded-lg border p-4 ${lastRotation.manualDnsRequired ? 'border-amber-200 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20' : 'border-green-200 bg-green-50 dark:border-green-700 dark:bg-green-900/20'}`}>
              <div className="flex items-start gap-2">
                {lastRotation.manualDnsRequired
                  ? <Shield size={16} className="mt-0.5 text-amber-600 dark:text-amber-400" />
                  : <CheckCircle size={16} className="mt-0.5 text-green-600 dark:text-green-400" />}
                <div className="flex-1 text-sm">
                  <p className="font-medium text-gray-900 dark:text-gray-100">
                    {lastRotation.manualDnsRequired
                      ? `New key generated. The platform does NOT manage DNS for this domain (${lastRotation.mode} mode) — publish the record below at your DNS provider, then click Activate.`
                      : `New key rotated and DNS published automatically (${lastRotation.mode} mode).`}
                  </p>
                  <DnsRecordCard
                    name={lastRotation.dnsRecordName}
                    value={lastRotation.dnsRecordValue}
                  />
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {keys.length} historical {keys.length === 1 ? 'key' : 'keys'}
            </p>
            <button
              type="button"
              onClick={handleRotate}
              disabled={rotate.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="dkim-rotate-button"
            >
              {rotate.isPending ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Rotate key
            </button>
          </div>

          {isLoading && <div className="flex justify-center py-6"><Loader2 size={20} className="animate-spin text-brand-500" /></div>}

          {!isLoading && keys.length === 0 && (
            <div className="rounded-lg border border-dashed border-gray-200 dark:border-gray-700 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
              No DKIM keys yet. Click <strong>Rotate key</strong> to generate the first one.
            </div>
          )}

          {keys.map(k => (
            <DkimKeyRow key={k.id} k={k} onActivate={() => activate.mutate(k.id)} activatePending={activate.isPending} />
          ))}
        </div>
      </div>
    </div>
  );
}

function DkimKeyRow({ k, onActivate, activatePending }: { readonly k: DkimKey; readonly onActivate: () => void; readonly activatePending: boolean }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <code className="text-sm font-mono text-gray-900 dark:text-gray-100">{k.selector}</code>
          <DkimStatusBadge status={k.status} />
        </div>
        {k.status === 'pending' && (
          <button
            type="button"
            onClick={onActivate}
            disabled={activatePending}
            className="inline-flex items-center gap-1 rounded-md border border-green-200 bg-green-50 dark:border-green-700 dark:bg-green-900/20 px-2 py-1 text-xs font-medium text-green-700 dark:text-green-400 hover:bg-green-100 disabled:opacity-50"
            data-testid={`dkim-activate-${k.id}`}
          >
            {activatePending && <Loader2 size={10} className="animate-spin" />}
            Activate
          </button>
        )}
      </div>
      <div className="text-xs text-gray-500 dark:text-gray-400">
        Created {new Date(k.createdAt).toLocaleString()}
        {k.activatedAt && ` · Activated ${new Date(k.activatedAt).toLocaleString()}`}
        {k.retiredAt && ` · Retired ${new Date(k.retiredAt).toLocaleString()}`}
      </div>
      {(k.status === 'pending' || k.status === 'active') && (
        <DnsRecordCard name={`${k.selector}._domainkey`} value={k.dnsRecordValue} compact />
      )}
    </div>
  );
}

function DkimStatusBadge({ status }: { readonly status: 'pending' | 'active' | 'retired' }) {
  const styles = {
    active: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
    pending: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
    retired: 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400',
  } as const;
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${styles[status]}`}>
      {status}
    </span>
  );
}

function DnsRecordCard({ name, value, compact }: { readonly name: string; readonly value: string; readonly compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copyValue = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Browsers without clipboard API — silently ignore
    }
  };
  return (
    <div className={`mt-2 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 ${compact ? 'p-2' : 'p-3'}`}>
      <div className={`grid grid-cols-[80px_1fr] gap-2 ${compact ? 'text-xs' : 'text-sm'}`}>
        <span className="font-medium text-gray-500 dark:text-gray-400">Type</span>
        <span className="font-mono text-gray-900 dark:text-gray-100">TXT</span>
        <span className="font-medium text-gray-500 dark:text-gray-400">Name</span>
        <code className="break-all font-mono text-gray-900 dark:text-gray-100">{name}</code>
        <span className="font-medium text-gray-500 dark:text-gray-400">Value</span>
        <div className="flex items-start gap-1">
          <code className="flex-1 break-all font-mono text-gray-900 dark:text-gray-100">{value}</code>
          <button
            type="button"
            onClick={copyValue}
            className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
            title="Copy value to clipboard"
          >
            {copied ? <CheckCircle size={12} className="text-green-500" /> : <Copy size={12} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function SmtpRelaysSection() {
  const { data: res, isLoading } = useSmtpRelays();
  const createRelay = useCreateSmtpRelay();
  const deleteRelay = useDeleteSmtpRelay();
  const testRelay = useTestSmtpRelay();
  const [showForm, setShowForm] = useState(false);
  const [provider, setProvider] = useState<'direct' | 'mailgun' | 'postmark'>('mailgun');
  const [testResult, setTestResult] = useState<{ id: string; status: string; message?: string } | null>(null);
  const [form, setForm] = useState({ name: '', smtp_host: '', smtp_port: '587', auth_username: '', auth_password: '', api_key: '', region: 'eu' });

  const relays = res?.data ?? [];

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    const base = { name: form.name, enabled: true };
    let input: Record<string, unknown>;
    if (provider === 'mailgun') {
      input = { ...base, provider_type: 'mailgun', smtp_host: form.smtp_host || 'smtp.eu.mailgun.org', smtp_port: Number(form.smtp_port), auth_username: form.auth_username, auth_password: form.auth_password, region: form.region };
    } else if (provider === 'postmark') {
      input = { ...base, provider_type: 'postmark', smtp_host: 'smtp.postmarkapp.com', smtp_port: 587, api_key: form.api_key };
    } else {
      input = { ...base, provider_type: 'direct' };
    }
    try {
      await createRelay.mutateAsync(input);
      setShowForm(false);
      setForm({ name: '', smtp_host: '', smtp_port: '587', auth_username: '', auth_password: '', api_key: '', region: 'eu' });
    } catch { /* error shown */ }
  };

  const handleTest = async (id: string) => {
    try {
      const r = await testRelay.mutateAsync(id);
      setTestResult({ id, ...r.data });
    } catch { setTestResult({ id, status: 'error', message: 'Test failed' }); }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button type="button" onClick={() => setShowForm(p => !p)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600" data-testid="add-relay-button">
          {showForm ? <X size={14} /> : <Plus size={14} />} {showForm ? 'Cancel' : 'Add SMTP Relay'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4" data-testid="relay-form">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Name</label>
              <input className={INPUT_CLASS + ' mt-1'} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required data-testid="relay-name" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Provider</label>
              <div className="mt-1 flex gap-2">
                {(['mailgun', 'postmark', 'direct'] as const).map(p => (
                  <button key={p} type="button" onClick={() => setProvider(p)}
                    className={`rounded-lg px-4 py-2 text-sm font-medium border ${provider === p ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20 text-brand-700 dark:text-brand-300' : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400'}`}
                    data-testid={`relay-type-${p}`}>
                    {p === 'mailgun' ? 'Mailgun' : p === 'postmark' ? 'Postmark' : 'Direct'}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {provider === 'mailgun' && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300">SMTP Host</label><input className={INPUT_CLASS + ' mt-1'} value={form.smtp_host} onChange={e => setForm({ ...form, smtp_host: e.target.value })} placeholder="smtp.eu.mailgun.org" /></div>
              <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Region</label>
                <select className={INPUT_CLASS + ' mt-1'} value={form.region} onChange={e => setForm({ ...form, region: e.target.value })}>
                  <option value="eu">EU</option><option value="us">US</option>
                </select>
              </div>
              <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Username</label><input className={INPUT_CLASS + ' mt-1 font-mono'} value={form.auth_username} onChange={e => setForm({ ...form, auth_username: e.target.value })} required /></div>
              <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Password</label><input className={INPUT_CLASS + ' mt-1 font-mono'} value={form.auth_password} onChange={e => setForm({ ...form, auth_password: e.target.value })} required /></div>
            </div>
          )}
          {provider === 'postmark' && (
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300">API Key / Server Token</label><input className={INPUT_CLASS + ' mt-1 font-mono'} value={form.api_key} onChange={e => setForm({ ...form, api_key: e.target.value })} required /></div>
          )}
          {provider === 'direct' && (
            <p className="text-sm text-gray-500 dark:text-gray-400">Direct delivery — Stalwart sends email without an external relay. Requires proper IP reputation and PTR record.</p>
          )}
          <div className="flex justify-end">
            <button type="submit" disabled={createRelay.isPending} className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">
              {createRelay.isPending && <Loader2 size={14} className="animate-spin" />} Create Relay
            </button>
          </div>
        </form>
      )}

      {isLoading && <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-brand-500" /></div>}

      {!isLoading && relays.length === 0 && !showForm && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-12 text-center shadow-sm">
          <Server size={40} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm text-gray-500 dark:text-gray-400">No SMTP relays configured. Stalwart will send email directly.</p>
        </div>
      )}

      {!isLoading && relays.map(r => (
        <div key={r.id} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm" data-testid={`relay-${r.id}`}>
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-gray-900 dark:text-gray-100">{r.name}</h3>
                <span className="rounded bg-gray-100 dark:bg-gray-700 px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-400">{r.providerType}</span>
                {r.isDefault ? <span className="rounded bg-brand-100 dark:bg-brand-900/20 px-2 py-0.5 text-xs font-medium text-brand-700 dark:text-brand-300">Default</span> : null}
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{r.smtpHost ? `${r.smtpHost}:${r.smtpPort}` : 'Direct delivery'}{r.region ? ` (${r.region})` : ''}</p>
            </div>
            <StatusBadge status={r.enabled ? 'active' : 'suspended'} />
          </div>
          {testResult?.id === r.id && (
            <div className={`mt-2 text-xs ${testResult.status === 'ok' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              Test: {testResult.status}{testResult.message ? ` — ${testResult.message}` : ''}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => handleTest(r.id)} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50">
              <TestTube size={12} /> Test
            </button>
            <button type="button" onClick={() => deleteRelay.mutate(r.id)} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 dark:border-red-800 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">
              <Trash2 size={12} /> Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
