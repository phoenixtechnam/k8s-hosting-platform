import { useState, type FormEvent } from 'react';
import { Mail, Plus, Trash2, Loader2, AlertCircle, X, ExternalLink, ArrowRight, Edit2, Settings, Copy, CheckCircle, Shield } from 'lucide-react';
import clsx from 'clsx';
import { useClientContext } from '@/hooks/use-client-context';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

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
import {
  useEmailDomains,
  useMailboxes,
  useCreateMailbox,
  useDeleteMailbox,
  useUpdateMailbox,
  useEmailAliases,
  useCreateEmailAlias,
  useDeleteEmailAlias,
  useWebmailToken,
  useEnableEmailDomain,
  useUpdateEmailDomain,
  useEmailDomainDnsRecords,
  type Mailbox,
  type EmailDomain,
  type DnsRecordDisplay,
} from '@/hooks/use-email';

const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

type Tab = 'mailboxes' | 'aliases' | 'settings';

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
              { key: 'settings' as Tab, label: 'Settings & DNS' },
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
          {tab === 'settings' && <SettingsTab clientId={clientId!} emailDomains={emailDomains} />}
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
  const [editingMailbox, setEditingMailbox] = useState<Mailbox | null>(null);
  const [form, setForm] = useState({ local_part: '', password: '', display_name: '', quota_mb: '1024' });

  const mailboxesRaw = res?.data ?? [];
  const { sortedData: mailboxes, sortKey, sortDirection, onSort } = useSortable(mailboxesRaw, 'fullAddress');
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
      // Phase 2b: backend returns a ready-to-open URL with the SSO token
      // already embedded as ?_jwt=… for the jwt_auth Roundcube plugin.
      window.open(result.data.webmailUrl, '_blank', 'noopener,noreferrer');
    } catch { /* will show error */ }
  };

  const domainName = emailDomains.find(d => d.id === selectedDomain)?.domainName ?? '';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">{mailboxesRaw.length} mailbox{mailboxesRaw.length !== 1 ? 'es' : ''}</p>
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
                <SortableHeader label="Email" sortKey="fullAddress" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                <SortableHeader label="Quota" sortKey="quotaMb" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
                <SortableHeader label="Status" sortKey="status" currentKey={sortKey} direction={sortDirection} onSort={onSort} />
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
                      <button type="button" onClick={() => setEditingMailbox(mb as Mailbox)} className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700" data-testid={`edit-mailbox-${mb.id}`}>
                        <Edit2 size={12} /> Edit
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

      {editingMailbox && (
        <EditMailboxModal
          clientId={clientId}
          mailbox={editingMailbox}
          onClose={() => setEditingMailbox(null)}
        />
      )}
    </div>
  );
}

// ─── Edit Mailbox Modal ────────────────────────────────────────────────────
//
// Lets a client_admin change the mailbox display name, password,
// quota, enabled status, and auto-reply settings. Only the fields
// that actually change are sent in the PATCH body — empty password
// is NOT sent (so blank = keep current). The backend's
// updateMailboxSchema validates individual optional fields.

function EditMailboxModal({
  clientId,
  mailbox,
  onClose,
}: {
  readonly clientId: string;
  readonly mailbox: Mailbox;
  readonly onClose: () => void;
}) {
  const updateMailbox = useUpdateMailbox(clientId);
  const [displayName, setDisplayName] = useState(mailbox.displayName ?? '');
  const [password, setPassword] = useState('');
  const [quotaMb, setQuotaMb] = useState(String(mailbox.quotaMb));
  const [status, setStatus] = useState<'active' | 'disabled'>(
    mailbox.status === 'disabled' ? 'disabled' : 'active',
  );
  const [autoReply, setAutoReply] = useState(mailbox.autoReply === 1);
  const [autoReplySubject, setAutoReplySubject] = useState(mailbox.autoReplySubject ?? '');
  const [autoReplyBody, setAutoReplyBody] = useState(mailbox.autoReplyBody ?? '');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const input: Record<string, unknown> = {};
    if (displayName !== (mailbox.displayName ?? '')) {
      input.display_name = displayName;
    }
    if (password.length > 0) {
      input.password = password;
    }
    const parsedQuota = Number(quotaMb);
    if (Number.isFinite(parsedQuota) && parsedQuota !== mailbox.quotaMb) {
      input.quota_mb = parsedQuota;
    }
    const currentStatus = mailbox.status === 'disabled' ? 'disabled' : 'active';
    if (status !== currentStatus) {
      input.status = status;
    }
    const currentAutoReply = mailbox.autoReply === 1;
    if (autoReply !== currentAutoReply) {
      input.auto_reply = autoReply;
    }
    if (autoReplySubject !== (mailbox.autoReplySubject ?? '')) {
      input.auto_reply_subject = autoReplySubject;
    }
    if (autoReplyBody !== (mailbox.autoReplyBody ?? '')) {
      input.auto_reply_body = autoReplyBody;
    }
    // Nothing changed? Just close.
    if (Object.keys(input).length === 0) {
      onClose();
      return;
    }
    try {
      await updateMailbox.mutateAsync({ id: mailbox.id, input });
      onClose();
    } catch {
      // Error rendered below.
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl bg-white dark:bg-gray-800 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="edit-mailbox-modal"
      >
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-6 py-4">
          <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            <Edit2 size={16} className="text-brand-500" />
            Edit {mailbox.fullAddress}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700"
            data-testid="edit-mailbox-close"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 p-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Display Name</label>
              <input
                type="text"
                className={INPUT_CLASS + ' mt-1'}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                data-testid="edit-mailbox-display-name"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Quota (MB)</label>
              <input
                type="number"
                min={50}
                className={INPUT_CLASS + ' mt-1'}
                value={quotaMb}
                onChange={(e) => setQuotaMb(e.target.value)}
                data-testid="edit-mailbox-quota"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                New Password <span className="text-xs text-gray-500 dark:text-gray-400">(leave blank to keep current)</span>
              </label>
              <input
                type="password"
                className={INPUT_CLASS + ' mt-1'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                data-testid="edit-mailbox-password"
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Status</label>
              <select
                className={INPUT_CLASS + ' mt-1'}
                value={status}
                onChange={(e) => setStatus(e.target.value as 'active' | 'disabled')}
                data-testid="edit-mailbox-status"
              >
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-3">
            <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
              <input
                type="checkbox"
                checked={autoReply}
                onChange={(e) => setAutoReply(e.target.checked)}
                data-testid="edit-mailbox-auto-reply"
              />
              Enable auto-reply (vacation message)
            </label>
            {autoReply && (
              <div className="space-y-2 pl-6">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">Subject</label>
                  <input
                    type="text"
                    className={INPUT_CLASS + ' mt-1'}
                    value={autoReplySubject}
                    onChange={(e) => setAutoReplySubject(e.target.value)}
                    placeholder="Out of office"
                    data-testid="edit-mailbox-auto-reply-subject"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400">Body</label>
                  <textarea
                    className={INPUT_CLASS + ' mt-1'}
                    rows={4}
                    value={autoReplyBody}
                    onChange={(e) => setAutoReplyBody(e.target.value)}
                    placeholder="Thank you for your message. I'm currently out of the office and will respond when I return."
                    data-testid="edit-mailbox-auto-reply-body"
                  />
                </div>
              </div>
            )}
          </div>

          {updateMailbox.error && (
            <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
              <AlertCircle size={14} />
              {updateMailbox.error instanceof Error ? updateMailbox.error.message : 'Update failed'}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={updateMailbox.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="submit-edit-mailbox"
            >
              {updateMailbox.isPending && <Loader2 size={14} className="animate-spin" />}
              Save changes
            </button>
          </div>
        </form>
      </div>
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

// ─── Settings & DNS tab ────────────────────────────────────────────────────
//
// Shows per-domain settings (spam thresholds, catch-all, webmail
// toggle) AND the DNS records the operator must publish in cname /
// secondary mode. Primary-mode domains see the same records with a
// "DNS managed by platform" banner for reference.

function SettingsTab({
  clientId,
  emailDomains,
}: {
  readonly clientId: string;
  readonly emailDomains: readonly EmailDomain[];
}) {
  const [selectedDomain, setSelectedDomain] = useState(emailDomains[0]?.id ?? '');
  const current = emailDomains.find((d) => d.id === selectedDomain) ?? emailDomains[0];

  if (!current) {
    return (
      <div className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">
        No email domains configured yet.
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="settings-tab">
      {emailDomains.length > 1 && (
        <div>
          <label className="mr-2 text-sm font-medium text-gray-700 dark:text-gray-300">Domain:</label>
          <select
            className={INPUT_CLASS + ' inline w-auto'}
            value={selectedDomain}
            onChange={(e) => setSelectedDomain(e.target.value)}
            data-testid="settings-domain-select"
          >
            {emailDomains.map((d) => (
              <option key={d.id} value={d.id}>{d.domainName}</option>
            ))}
          </select>
        </div>
      )}

      <DomainSettingsCard clientId={clientId} domain={current} />
      <DnsRecordsCard clientId={clientId} domain={current} />
    </div>
  );
}

function DomainSettingsCard({
  clientId,
  domain,
}: {
  readonly clientId: string;
  readonly domain: EmailDomain;
}) {
  const updateDomain = useUpdateEmailDomain(clientId);
  const [catchAll, setCatchAll] = useState(domain.catchAllAddress ?? '');
  const [spamJunk, setSpamJunk] = useState(domain.spamThresholdJunk ?? '5.0');
  const [spamReject, setSpamReject] = useState(domain.spamThresholdReject ?? '10.0');
  const [webmailEnabled, setWebmailEnabled] = useState(
    domain.webmailEnabled === undefined ? true : domain.webmailEnabled === 1,
  );
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    const input: Record<string, unknown> = {};
    if (catchAll !== (domain.catchAllAddress ?? '')) {
      input.catch_all_address = catchAll.trim() === '' ? null : catchAll.trim();
    }
    if (spamJunk !== (domain.spamThresholdJunk ?? '5.0')) {
      input.spam_threshold_junk = spamJunk;
    }
    if (spamReject !== (domain.spamThresholdReject ?? '10.0')) {
      input.spam_threshold_reject = spamReject;
    }
    const currentWebmail = domain.webmailEnabled === undefined ? true : domain.webmailEnabled === 1;
    if (webmailEnabled !== currentWebmail) {
      input.webmail_enabled = webmailEnabled;
    }
    if (Object.keys(input).length === 0) {
      setSavedAt(Date.now());
      return;
    }
    try {
      await updateDomain.mutateAsync({ domainId: domain.domainId, input });
      setSavedAt(Date.now());
    } catch {
      // Error shown below
    }
  };

  return (
    <form
      onSubmit={handleSave}
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4"
      data-testid="domain-settings-form"
    >
      <div className="flex items-center gap-2">
        <Settings size={16} className="text-brand-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Domain settings — {domain.domainName}
        </h3>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Catch-all address</label>
          <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">
            All mail to unknown addresses @{domain.domainName} is delivered here. Leave blank to reject unknown addresses.
          </p>
          <input
            type="email"
            className={INPUT_CLASS}
            value={catchAll}
            onChange={(e) => setCatchAll(e.target.value)}
            placeholder={`someone@${domain.domainName}`}
            data-testid="settings-catch-all"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Webmail</label>
          <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">
            Enable webmail.{domain.domainName} → Roundcube.
          </p>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={webmailEnabled}
              onChange={(e) => setWebmailEnabled(e.target.checked)}
              data-testid="settings-webmail-enabled"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">
              Enabled (webmail.{domain.domainName})
            </span>
          </label>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Spam threshold — Junk folder
          </label>
          <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">
            Score at or above this moves mail to Junk. Default 5.0.
          </p>
          <input
            type="number"
            step="0.1"
            min="0"
            max="20"
            className={INPUT_CLASS}
            value={spamJunk}
            onChange={(e) => setSpamJunk(e.target.value)}
            data-testid="settings-spam-junk"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Spam threshold — Reject
          </label>
          <p className="mb-1 text-xs text-gray-500 dark:text-gray-400">
            Score at or above this is rejected at SMTP time. Default 10.0.
          </p>
          <input
            type="number"
            step="0.1"
            min="0"
            max="20"
            className={INPUT_CLASS}
            value={spamReject}
            onChange={(e) => setSpamReject(e.target.value)}
            data-testid="settings-spam-reject"
          />
        </div>
      </div>

      {updateDomain.error && (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertCircle size={14} />
          {updateDomain.error instanceof Error ? updateDomain.error.message : 'Save failed'}
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        {savedAt && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
        <button
          type="submit"
          disabled={updateDomain.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="settings-save-button"
        >
          {updateDomain.isPending && <Loader2 size={14} className="animate-spin" />}
          Save settings
        </button>
      </div>
    </form>
  );
}

function DnsRecordsCard({
  clientId,
  domain,
}: {
  readonly clientId: string;
  readonly domain: EmailDomain;
}) {
  const { data: res, isLoading, error } = useEmailDomainDnsRecords(clientId, domain.domainId);
  const dns = res?.data;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4" data-testid="dns-records-card">
      <div className="flex items-center gap-2">
        <Shield size={16} className="text-brand-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          DNS records — {domain.domainName}
        </h3>
      </div>

      {isLoading && (
        <div className="flex justify-center py-6">
          <Loader2 size={20} className="animate-spin text-brand-500" />
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertCircle size={14} />
          {error instanceof Error ? error.message : 'Failed to load DNS records'}
        </div>
      )}

      {dns && (
        <>
          {dns.manualRequired ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20 p-4">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
                Manual DNS publishing required ({dns.dnsMode} mode)
              </p>
              <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">
                The platform does NOT manage DNS for this domain. Publish the records below at your
                DNS provider. Mail may not deliver reliably until all records are in place.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-green-200 bg-green-50 dark:border-green-700 dark:bg-green-900/20 p-4">
              <p className="text-sm font-medium text-green-900 dark:text-green-100">
                DNS managed by platform (primary mode)
              </p>
              <p className="mt-1 text-xs text-green-800 dark:text-green-200">
                These records are automatically published and kept in sync in the authoritative
                zone. Shown here for reference.
              </p>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="dns-records-table">
              <thead>
                <tr className="border-b border-gray-100 dark:border-gray-700 text-gray-500 dark:text-gray-400 uppercase">
                  <th className="py-2 pr-3">Type</th>
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">Value</th>
                  <th className="py-2 pr-3">TTL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
                {dns.records.map((r, i) => (
                  <DnsRecordRow key={`${r.type}-${r.name}-${i}`} record={r} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function DnsRecordRow({ record }: { readonly record: DnsRecordDisplay }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(record.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — silently ignore
    }
  };
  return (
    <tr>
      <td className="py-2 pr-3 font-mono text-gray-900 dark:text-gray-100">{record.type}</td>
      <td className="py-2 pr-3 font-mono text-gray-700 dark:text-gray-300 break-all">{record.name}</td>
      <td className="py-2 pr-3">
        <div className="flex items-start gap-1">
          <code className="flex-1 break-all font-mono text-gray-900 dark:text-gray-100">
            {record.priority !== null ? `${record.priority} ` : ''}
            {record.value}
          </code>
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
            title="Copy value"
          >
            {copied ? <CheckCircle size={12} className="text-green-500" /> : <Copy size={12} />}
          </button>
        </div>
      </td>
      <td className="py-2 pr-3 text-gray-500 dark:text-gray-400">{record.ttl}</td>
    </tr>
  );
}
