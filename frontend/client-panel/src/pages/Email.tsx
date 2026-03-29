import { useState, type FormEvent } from 'react';
import { Mail, Plus, Trash2, Loader2, AlertCircle, X, ExternalLink, ArrowRight } from 'lucide-react';
import clsx from 'clsx';
import { useClientContext } from '@/hooks/use-client-context';

function StatusBadge({ status }: { readonly status: string }) {
  const styles: Record<string, string> = {
    active: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    disabled: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    suspended: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status] ?? 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'}`}>
      {status}
    </span>
  );
}
import { useEmailDomains, useMailboxes, useCreateMailbox, useDeleteMailbox, useEmailAliases, useCreateEmailAlias, useDeleteEmailAlias, useWebmailToken, useEnableEmailDomain } from '@/hooks/use-email';

const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

type Tab = 'mailboxes' | 'aliases';

export default function Email() {
  const { clientId } = useClientContext();
  const [tab, setTab] = useState<Tab>('mailboxes');
  const { data: domainsRes, isLoading: domainsLoading } = useEmailDomains(clientId ?? undefined);
  const emailDomains = domainsRes?.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Mail size={28} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="email-heading">Email</h1>
      </div>

      {domainsLoading && <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-brand-500" /></div>}

      {!domainsLoading && emailDomains.length === 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-12 text-center shadow-sm" data-testid="email-not-enabled">
          <Mail size={48} className="mx-auto text-gray-300 dark:text-gray-600" />
          <h2 className="mt-4 text-lg font-semibold text-gray-900 dark:text-gray-100">Email Not Enabled</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500 dark:text-gray-400">
            Email hosting has not been enabled for any of your domains yet. Contact your administrator to enable email.
          </p>
        </div>
      )}

      {!domainsLoading && emailDomains.length > 0 && (
        <>
          <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
            {[
              { key: 'mailboxes' as Tab, label: 'Mailboxes' },
              { key: 'aliases' as Tab, label: 'Aliases & Forwarding' },
            ].map(t => (
              <button key={t.key} type="button" onClick={() => setTab(t.key)}
                className={clsx('border-b-2 px-4 py-2.5 text-sm font-medium', tab === t.key ? 'border-brand-500 text-brand-600' : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200')}
                data-testid={`tab-${t.key}`}>
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'mailboxes' && <MailboxesTab clientId={clientId!} emailDomains={emailDomains} />}
          {tab === 'aliases' && <AliasesTab clientId={clientId!} emailDomains={emailDomains} />}
        </>
      )}
    </div>
  );
}

function MailboxesTab({ clientId, emailDomains }: { readonly clientId: string; readonly emailDomains: readonly { id: string; domainName: string }[] }) {
  const { data: res, isLoading } = useMailboxes(clientId);
  const deleteMailbox = useDeleteMailbox(clientId);
  const webmailToken = useWebmailToken();
  const [showForm, setShowForm] = useState(false);
  const [selectedDomain, setSelectedDomain] = useState(emailDomains[0]?.id ?? '');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [form, setForm] = useState({ local_part: '', password: '', display_name: '', quota_mb: '1024' });

  const mailboxes = res?.data ?? [];
  const createMailbox = useCreateMailbox(clientId, selectedDomain);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await createMailbox.mutateAsync({ local_part: form.local_part, password: form.password, display_name: form.display_name || undefined, quota_mb: Number(form.quota_mb) });
      setForm({ local_part: '', password: '', display_name: '', quota_mb: '1024' });
      setShowForm(false);
    } catch { /* error shown */ }
  };

  const handleOpenWebmail = async (mailboxId: string) => {
    try {
      const result = await webmailToken.mutateAsync(mailboxId);
      window.open(`${result.data.webmailUrl}/sso.php?token=${result.data.token}`, '_blank');
    } catch { /* will show error */ }
  };

  const domainName = emailDomains.find(d => d.id === selectedDomain)?.domainName ?? '';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">{mailboxes.length} mailbox{mailboxes.length !== 1 ? 'es' : ''}</p>
        <button type="button" onClick={() => setShowForm(p => !p)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600" data-testid="add-mailbox-button">
          {showForm ? <X size={14} /> : <Plus size={14} />} {showForm ? 'Cancel' : 'Create Mailbox'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4" data-testid="create-mailbox-form">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {emailDomains.length > 1 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Domain</label>
                <select className={INPUT_CLASS + ' mt-1'} value={selectedDomain} onChange={e => setSelectedDomain(e.target.value)} data-testid="mailbox-domain-select">
                  {emailDomains.map(d => <option key={d.id} value={d.id}>{d.domainName}</option>)}
                </select>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Username</label>
              <div className="mt-1 flex">
                <input className="flex-1 rounded-l-lg border border-r-0 border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100" value={form.local_part} onChange={e => setForm({ ...form, local_part: e.target.value })} required placeholder="john" data-testid="mailbox-local-part" />
                <span className="inline-flex items-center rounded-r-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 px-3 text-sm text-gray-500 dark:text-gray-400">@{domainName}</span>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Password</label>
              <input type="password" className={INPUT_CLASS + ' mt-1'} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required minLength={8} data-testid="mailbox-password" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Display Name</label>
              <input className={INPUT_CLASS + ' mt-1'} value={form.display_name} onChange={e => setForm({ ...form, display_name: e.target.value })} placeholder="John Doe" data-testid="mailbox-display-name" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Quota (MB)</label>
              <input type="number" className={INPUT_CLASS + ' mt-1'} value={form.quota_mb} onChange={e => setForm({ ...form, quota_mb: e.target.value })} data-testid="mailbox-quota" />
            </div>
          </div>
          {createMailbox.error && <div className="flex items-center gap-2 text-sm text-red-600"><AlertCircle size={14} />{createMailbox.error instanceof Error ? createMailbox.error.message : 'Failed'}</div>}
          <div className="flex justify-end">
            <button type="submit" disabled={createMailbox.isPending} className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="submit-mailbox">
              {createMailbox.isPending && <Loader2 size={14} className="animate-spin" />} Create Mailbox
            </button>
          </div>
        </form>
      )}

      {isLoading && <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-brand-500" /></div>}

      {!isLoading && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
          <table className="w-full" data-testid="mailboxes-table">
            <thead>
              <tr className="border-b border-gray-100 dark:border-gray-700 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                <th className="px-5 py-3">Email</th>
                <th className="px-5 py-3">Quota</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {mailboxes.map(mb => (
                <tr key={mb.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td className="px-5 py-3.5">
                    <div className="font-medium text-gray-900 dark:text-gray-100">{mb.fullAddress}</div>
                    {mb.displayName && <div className="text-xs text-gray-500 dark:text-gray-400">{mb.displayName}</div>}
                  </td>
                  <td className="px-5 py-3.5 text-sm text-gray-600 dark:text-gray-400">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-16 rounded-full bg-gray-200 dark:bg-gray-700">
                        <div className="h-1.5 rounded-full bg-brand-500" style={{ width: `${Math.min(100, (mb.usedMb / mb.quotaMb) * 100)}%` }} />
                      </div>
                      <span className="text-xs">{mb.usedMb}/{mb.quotaMb} MB</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5"><StatusBadge status={mb.status === 'active' ? 'active' : 'suspended'} /></td>
                  <td className="px-5 py-3.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button type="button" onClick={() => handleOpenWebmail(mb.id)} className="inline-flex items-center gap-1 rounded-md border border-brand-200 dark:border-brand-700 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-brand-600 hover:bg-brand-50 dark:hover:bg-brand-900/30" data-testid={`webmail-${mb.id}`}>
                        <ExternalLink size={12} /> Webmail
                      </button>
                      {deleteConfirmId === mb.id ? (
                        <div className="flex gap-1">
                          <button type="button" onClick={async () => { await deleteMailbox.mutateAsync(mb.id); setDeleteConfirmId(null); }} className="rounded-md bg-red-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-red-700">Confirm</button>
                          <button type="button" onClick={() => setDeleteConfirmId(null)} className="rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400">Cancel</button>
                        </div>
                      ) : (
                        <button type="button" onClick={() => setDeleteConfirmId(mb.id)} className="inline-flex items-center gap-1 rounded-md border border-red-200 dark:border-red-700 px-2.5 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30" data-testid={`delete-mailbox-${mb.id}`}>
                          <Trash2 size={12} /> Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {mailboxes.length === 0 && (
                <tr><td colSpan={4} className="px-5 py-10 text-center text-sm text-gray-500">No mailboxes yet. Create your first mailbox to get started.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AliasesTab({ clientId, emailDomains }: { readonly clientId: string; readonly emailDomains: readonly { id: string; domainName: string }[] }) {
  const { data: res, isLoading } = useEmailAliases(clientId);
  const deleteAlias = useDeleteEmailAlias(clientId);
  const [showForm, setShowForm] = useState(false);
  const [selectedDomain, setSelectedDomain] = useState(emailDomains[0]?.id ?? '');
  const [form, setForm] = useState({ source: '', destinations: '' });
  const createAlias = useCreateEmailAlias(clientId, selectedDomain);

  const aliases = res?.data ?? [];
  const domainName = emailDomains.find(d => d.id === selectedDomain)?.domainName ?? '';

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    const destinations = form.destinations.split(',').map(s => s.trim()).filter(Boolean);
    try {
      await createAlias.mutateAsync({ source_address: `${form.source}@${domainName}`, destination_addresses: destinations });
      setForm({ source: '', destinations: '' });
      setShowForm(false);
    } catch { /* error shown */ }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">{aliases.length} alias{aliases.length !== 1 ? 'es' : ''}</p>
        <button type="button" onClick={() => setShowForm(p => !p)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600" data-testid="add-alias-button">
          {showForm ? <X size={14} /> : <Plus size={14} />} {showForm ? 'Cancel' : 'Create Alias'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4" data-testid="create-alias-form">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Source</label>
              <div className="mt-1 flex">
                <input className="flex-1 rounded-l-lg border border-r-0 border-gray-300 dark:border-gray-600 px-3 py-2 text-sm dark:bg-gray-700 dark:text-gray-100" value={form.source} onChange={e => setForm({ ...form, source: e.target.value })} required placeholder="support" data-testid="alias-source" />
                <span className="inline-flex items-center rounded-r-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 px-3 text-sm text-gray-500 dark:text-gray-400">@{domainName}</span>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Forward to (comma-separated)</label>
              <input className={INPUT_CLASS + ' mt-1'} value={form.destinations} onChange={e => setForm({ ...form, destinations: e.target.value })} required placeholder="john@example.com, jane@example.com" data-testid="alias-destinations" />
            </div>
          </div>
          {createAlias.error && <div className="flex items-center gap-2 text-sm text-red-600"><AlertCircle size={14} />{createAlias.error instanceof Error ? createAlias.error.message : 'Failed'}</div>}
          <div className="flex justify-end">
            <button type="submit" disabled={createAlias.isPending} className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="submit-alias">
              {createAlias.isPending && <Loader2 size={14} className="animate-spin" />} Create Alias
            </button>
          </div>
        </form>
      )}

      {isLoading && <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-brand-500" /></div>}

      {!isLoading && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm divide-y divide-gray-100">
          {aliases.map(a => (
            <div key={a.id} className="flex items-center justify-between px-5 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50">
              <div className="flex items-center gap-2">
                <span className="font-medium text-gray-900 dark:text-gray-100 text-sm">{a.sourceAddress}</span>
                <ArrowRight size={14} className="text-gray-400 dark:text-gray-500" />
                <span className="text-sm text-gray-600 dark:text-gray-400">{a.destinationAddresses.join(', ')}</span>
              </div>
              <button type="button" onClick={() => deleteAlias.mutate(a.id)} className="inline-flex items-center gap-1 rounded-md border border-red-200 dark:border-red-700 px-2.5 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30" data-testid={`delete-alias-${a.id}`}>
                <Trash2 size={12} /> Delete
              </button>
            </div>
          ))}
          {aliases.length === 0 && (
            <div className="px-5 py-10 text-center text-sm text-gray-500">No aliases yet. Create one to forward emails.</div>
          )}
        </div>
      )}
    </div>
  );
}
