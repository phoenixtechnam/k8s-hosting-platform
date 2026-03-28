import { useState } from 'react';
import { Mail, Globe, Server, Shield, Loader2, CheckCircle, XCircle, Plus, Trash2, TestTube, X } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import StatCard from '@/components/ui/StatCard';
import { useAdminEmailDomains, useSmtpRelays, useCreateSmtpRelay, useDeleteSmtpRelay, useTestSmtpRelay } from '@/hooks/use-email';
import type { FormEvent } from 'react';

const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

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
        <Mail size={28} className="text-gray-700" />
        <h1 className="text-2xl font-bold text-gray-900" data-testid="email-mgmt-heading">Email Management</h1>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Email Domains" value={domainsLoading ? '...' : domains.length} icon={Globe} accent="brand" />
        <StatCard title="Total Mailboxes" value={domainsLoading ? '...' : totalMailboxes} icon={Mail} accent="green" />
        <StatCard title="DKIM Configured" value={domainsLoading ? '...' : `${dkimOk}/${domains.length}`} icon={Shield} accent="amber" />
        <StatCard title="Mail Server" value="Stalwart" icon={Server} accent="green" />
      </div>

      <div className="flex gap-1 border-b border-gray-200">
        {[
          { key: 'domains' as Tab, label: 'Email Domains' },
          { key: 'relays' as Tab, label: 'SMTP Relays' },
        ].map(t => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)}
            className={`border-b-2 px-4 py-2.5 text-sm font-medium ${tab === t.key ? 'border-brand-500 text-brand-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            data-testid={`tab-${t.key}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'domains' && <EmailDomainsTable domains={domains} isLoading={domainsLoading} />}
      {tab === 'relays' && <SmtpRelaysSection />}
    </div>
  );
}

interface EmailDomainRow {
  readonly id: string;
  readonly domainName: string;
  readonly mailboxCount?: number;
  readonly mxProvisioned: number;
  readonly spfProvisioned: number;
  readonly dkimProvisioned: number;
  readonly dmarcProvisioned: number;
  readonly spamThresholdJunk: string;
  readonly enabled: number;
}

function EmailDomainsTable({ domains, isLoading }: { readonly domains: readonly EmailDomainRow[]; readonly isLoading: boolean }) {
  if (isLoading) return <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-brand-500" /></div>;

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="w-full" data-testid="email-domains-table">
        <thead>
          <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
            <th className="px-5 py-3">Domain</th>
            <th className="px-5 py-3">Mailboxes</th>
            <th className="px-5 py-3">DNS Status</th>
            <th className="px-5 py-3">Spam Filter</th>
            <th className="px-5 py-3">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {domains.map(d => (
            <tr key={d.id} className="hover:bg-gray-50">
              <td className="px-5 py-3.5 font-medium text-gray-900">{d.domainName}</td>
              <td className="px-5 py-3.5 text-sm text-gray-600">{d.mailboxCount ?? 0}</td>
              <td className="px-5 py-3.5">
                <div className="flex gap-1.5">
                  {['MX', 'SPF', 'DKIM', 'DMARC'].map((rec, i) => {
                    const provisioned = [d.mxProvisioned, d.spfProvisioned, d.dkimProvisioned, d.dmarcProvisioned][i];
                    return (
                      <span key={rec} className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs font-medium ${provisioned ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                        {provisioned ? <CheckCircle size={10} /> : <XCircle size={10} />} {rec}
                      </span>
                    );
                  })}
                </div>
              </td>
              <td className="px-5 py-3.5 text-xs text-gray-500">Junk: {d.spamThresholdJunk}</td>
              <td className="px-5 py-3.5"><StatusBadge status={d.enabled ? 'active' : 'suspended'} /></td>
            </tr>
          ))}
          {domains.length === 0 && (
            <tr><td colSpan={5} className="px-5 py-10 text-center text-sm text-gray-500">No email-enabled domains yet.</td></tr>
          )}
        </tbody>
      </table>
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
        <form onSubmit={handleCreate} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm space-y-4" data-testid="relay-form">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700">Name</label>
              <input className={INPUT_CLASS + ' mt-1'} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required data-testid="relay-name" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Provider</label>
              <div className="mt-1 flex gap-2">
                {(['mailgun', 'postmark', 'direct'] as const).map(p => (
                  <button key={p} type="button" onClick={() => setProvider(p)}
                    className={`rounded-lg px-4 py-2 text-sm font-medium border ${provider === p ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-gray-200 text-gray-600'}`}
                    data-testid={`relay-type-${p}`}>
                    {p === 'mailgun' ? 'Mailgun' : p === 'postmark' ? 'Postmark' : 'Direct'}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {provider === 'mailgun' && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div><label className="block text-sm font-medium text-gray-700">SMTP Host</label><input className={INPUT_CLASS + ' mt-1'} value={form.smtp_host} onChange={e => setForm({ ...form, smtp_host: e.target.value })} placeholder="smtp.eu.mailgun.org" /></div>
              <div><label className="block text-sm font-medium text-gray-700">Region</label>
                <select className={INPUT_CLASS + ' mt-1'} value={form.region} onChange={e => setForm({ ...form, region: e.target.value })}>
                  <option value="eu">EU</option><option value="us">US</option>
                </select>
              </div>
              <div><label className="block text-sm font-medium text-gray-700">Username</label><input className={INPUT_CLASS + ' mt-1 font-mono'} value={form.auth_username} onChange={e => setForm({ ...form, auth_username: e.target.value })} required /></div>
              <div><label className="block text-sm font-medium text-gray-700">Password</label><input className={INPUT_CLASS + ' mt-1 font-mono'} value={form.auth_password} onChange={e => setForm({ ...form, auth_password: e.target.value })} required /></div>
            </div>
          )}
          {provider === 'postmark' && (
            <div><label className="block text-sm font-medium text-gray-700">API Key / Server Token</label><input className={INPUT_CLASS + ' mt-1 font-mono'} value={form.api_key} onChange={e => setForm({ ...form, api_key: e.target.value })} required /></div>
          )}
          {provider === 'direct' && (
            <p className="text-sm text-gray-500">Direct delivery — Stalwart sends email without an external relay. Requires proper IP reputation and PTR record.</p>
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
        <div className="rounded-xl border border-gray-200 bg-white p-12 text-center shadow-sm">
          <Server size={40} className="mx-auto mb-3 text-gray-300" />
          <p className="text-sm text-gray-500">No SMTP relays configured. Stalwart will send email directly.</p>
        </div>
      )}

      {!isLoading && relays.map(r => (
        <div key={r.id} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm" data-testid={`relay-${r.id}`}>
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-gray-900">{r.name}</h3>
                <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">{r.providerType}</span>
                {r.isDefault ? <span className="rounded bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700">Default</span> : null}
              </div>
              <p className="text-xs text-gray-500 mt-1">{r.smtpHost ? `${r.smtpHost}:${r.smtpPort}` : 'Direct delivery'}{r.region ? ` (${r.region})` : ''}</p>
            </div>
            <StatusBadge status={r.enabled ? 'active' : 'suspended'} />
          </div>
          {testResult?.id === r.id && (
            <div className={`mt-2 text-xs ${testResult.status === 'ok' ? 'text-green-600' : 'text-red-600'}`}>
              Test: {testResult.status}{testResult.message ? ` — ${testResult.message}` : ''}
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => handleTest(r.id)} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
              <TestTube size={12} /> Test
            </button>
            <button type="button" onClick={() => deleteRelay.mutate(r.id)} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50">
              <Trash2 size={12} /> Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
