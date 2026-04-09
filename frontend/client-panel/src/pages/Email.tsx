import { useState, type FormEvent } from 'react';
import { Mail, Plus, Trash2, Loader2, AlertCircle, X, ExternalLink, ArrowRight, Edit2, Settings, Copy, CheckCircle, Shield, Key, RefreshCw, Gauge, Download } from 'lucide-react';
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
  useDkimKeys,
  useRotateDkimKey,
  useActivateDkimKey,
  useMailSubmitCredential,
  useRotateMailSubmitCredential,
  useImapSyncJobs,
  useCreateImapSyncJob,
  useCancelImapSyncJob,
  useMailRateLimit,
  type Mailbox,
  type EmailDomain,
  type DnsRecordDisplay,
  type DkimKey,
  type DkimRotateResult,
  type MailSubmitRotateResult,
  type ImapSyncJob,
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

      {mailboxes.length > 0 && (
        <ImapSyncPanel
          clientId={clientId}
          mailboxes={mailboxes.map(m => ({ id: m.id, fullAddress: m.fullAddress }))}
        />
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
      <DkimKeysCard clientId={clientId} domain={current} />
      <SendmailCredentialCard clientId={clientId} />
      <RateLimitCard clientId={clientId} />
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

// ─── DKIM keys card (Phase 3) ──────────────────────────────────────────

function DkimKeysCard({
  clientId,
  domain,
}: {
  readonly clientId: string;
  readonly domain: EmailDomain;
}) {
  const { data: keysRes, isLoading } = useDkimKeys(clientId, domain.domainId);
  const rotate = useRotateDkimKey(clientId, domain.domainId);
  const activate = useActivateDkimKey(clientId, domain.domainId);
  const [lastRotation, setLastRotation] = useState<DkimRotateResult | null>(null);
  const keys = keysRes?.data ?? [];

  const handleRotate = async () => {
    setLastRotation(null);
    try {
      const res = await rotate.mutateAsync();
      setLastRotation(res.data);
    } catch {
      // shown below
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4" data-testid="dkim-card">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Key size={16} className="text-amber-500" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            DKIM signing keys
          </h3>
        </div>
        <button
          type="button"
          onClick={handleRotate}
          disabled={rotate.isPending}
          className="inline-flex items-center gap-1 rounded-md bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="dkim-rotate-button"
        >
          {rotate.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Rotate key
        </button>
      </div>

      {lastRotation && (
        <div className={clsx(
          'rounded-lg border p-3 text-xs',
          lastRotation.manualDnsRequired
            ? 'border-amber-200 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20'
            : 'border-green-200 bg-green-50 dark:border-green-700 dark:bg-green-900/20',
        )}>
          <p className="font-medium text-gray-900 dark:text-gray-100">
            {lastRotation.manualDnsRequired
              ? `New key generated (${lastRotation.mode} mode). Publish the DNS record below at your DNS provider, then click Activate.`
              : `New key rotated and DNS published automatically (${lastRotation.mode} mode).`}
          </p>
          <div className="mt-2 grid grid-cols-[80px_1fr] gap-1 font-mono">
            <span className="text-gray-500 dark:text-gray-400">Type</span><span className="text-gray-900 dark:text-gray-100">TXT</span>
            <span className="text-gray-500 dark:text-gray-400">Name</span><code className="break-all text-gray-900 dark:text-gray-100">{lastRotation.dnsRecordName}</code>
            <span className="text-gray-500 dark:text-gray-400">Value</span><code className="break-all text-gray-900 dark:text-gray-100">{lastRotation.dnsRecordValue}</code>
          </div>
        </div>
      )}

      {rotate.error && (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertCircle size={14} />
          {rotate.error instanceof Error ? rotate.error.message : 'Rotation failed'}
        </div>
      )}

      {isLoading && <div className="py-3 text-center"><Loader2 size={16} className="inline animate-spin text-brand-500" /></div>}

      {!isLoading && keys.length === 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400 italic">No DKIM keys yet. Click Rotate to generate the first key.</p>
      )}

      {keys.map((k) => (
        <DkimKeyRow key={k.id} dkimKey={k} onActivate={() => activate.mutate(k.id)} activatePending={activate.isPending} />
      ))}
    </div>
  );
}

function DkimKeyRow({
  dkimKey,
  onActivate,
  activatePending,
}: {
  readonly dkimKey: DkimKey;
  readonly onActivate: () => void;
  readonly activatePending: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-1.5 text-xs">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <code className="font-mono text-gray-900 dark:text-gray-100">{dkimKey.selector}</code>
          <DkimStatusBadge status={dkimKey.status} />
        </div>
        {dkimKey.status === 'pending' && (
          <button
            type="button"
            onClick={onActivate}
            disabled={activatePending}
            className="rounded-md border border-green-200 bg-green-50 dark:border-green-700 dark:bg-green-900/20 px-2 py-0.5 text-xs text-green-700 dark:text-green-400 hover:bg-green-100 disabled:opacity-50"
            data-testid={`dkim-activate-${dkimKey.id}`}
          >
            Activate
          </button>
        )}
      </div>
      <div className="text-gray-500 dark:text-gray-400">
        Created {new Date(dkimKey.createdAt).toLocaleString()}
        {dkimKey.activatedAt && ` · Activated ${new Date(dkimKey.activatedAt).toLocaleString()}`}
      </div>
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

// ─── Sendmail submission credential card (Phase 3) ────────────────────

function SendmailCredentialCard({ clientId }: { readonly clientId: string }) {
  const { data, isLoading } = useMailSubmitCredential(clientId);
  const rotate = useRotateMailSubmitCredential(clientId);
  const [latest, setLatest] = useState<MailSubmitRotateResult | null>(null);
  const [copied, setCopied] = useState(false);
  const cred = data?.data;

  const handleRotate = async (pushToPvc: boolean) => {
    setLatest(null);
    try {
      const res = await rotate.mutateAsync({ pushToPvc });
      setLatest(res.data);
    } catch {
      // shown below
    }
  };

  const copyPassword = async () => {
    if (!latest?.password) return;
    try {
      await navigator.clipboard.writeText(latest.password);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API unavailable
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-3" data-testid="sendmail-card">
      <div className="flex items-center gap-2">
        <Mail size={16} className="text-brand-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Sendmail compatibility credential</h3>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Per-customer SMTP credentials used by legacy apps (WordPress, PHP <code>mail()</code>) to relay mail
        through the platform. The auth file is written to your workload PVC at <code>.platform/sendmail-auth</code>
        and hidden from the file manager.
      </p>

      {isLoading && <div className="py-2 text-center"><Loader2 size={16} className="inline animate-spin text-brand-500" /></div>}

      {!isLoading && cred && cred.exists && (
        <div className="grid grid-cols-[100px_1fr] gap-1 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3 text-xs">
          <span className="text-gray-500 dark:text-gray-400">Username</span>
          <code className="font-mono text-gray-900 dark:text-gray-100">{cred.username}</code>
          <span className="text-gray-500 dark:text-gray-400">Created</span>
          <span className="text-gray-700 dark:text-gray-300">{cred.createdAt ? new Date(cred.createdAt).toLocaleString() : '—'}</span>
          <span className="text-gray-500 dark:text-gray-400">Last used</span>
          <span className="text-gray-700 dark:text-gray-300">{cred.lastUsedAt ? new Date(cred.lastUsedAt).toLocaleString() : 'never'}</span>
        </div>
      )}

      {!isLoading && cred && !cred.exists && (
        <p className="text-xs italic text-gray-500 dark:text-gray-400">No credentials provisioned yet.</p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => handleRotate(true)}
          disabled={rotate.isPending}
          className="inline-flex items-center gap-1 rounded-md bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="sendmail-rotate-push"
        >
          {rotate.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Rotate &amp; push to PVC
        </button>
        <button
          type="button"
          onClick={() => handleRotate(false)}
          disabled={rotate.isPending}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
        >
          Rotate only
        </button>
      </div>

      {latest && (
        <div className="rounded-md border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-3 text-xs">
          <p className="mb-2 font-medium text-amber-900 dark:text-amber-100">
            New credential generated. The plain password is shown ONCE — copy it now if you need it for manual configuration.
          </p>
          <div className="grid grid-cols-[80px_1fr] gap-1 font-mono">
            <span className="text-gray-500 dark:text-gray-400">Username</span>
            <code className="break-all text-gray-900 dark:text-gray-100">{latest.username}</code>
            <span className="text-gray-500 dark:text-gray-400">Password</span>
            <div className="flex items-start gap-1">
              <code className="flex-1 break-all text-gray-900 dark:text-gray-100">{latest.password}</code>
              <button
                type="button"
                onClick={copyPassword}
                className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                title="Copy password"
                data-testid="sendmail-copy-password"
              >
                {copied ? <CheckCircle size={12} className="text-green-500" /> : <Copy size={12} />}
              </button>
            </div>
          </div>
          <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
            {latest.pushedToPvc
              ? '✓ Auth file written to your PVC. Workload pods will pick it up on next mail send.'
              : `⚠ PVC write skipped or failed${latest.pushError ? `: ${latest.pushError}` : ''}.`}
          </p>
        </div>
      )}

      {rotate.error && !latest && (
        <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertCircle size={14} />
          {rotate.error instanceof Error ? rotate.error.message : 'Rotation failed'}
        </div>
      )}
    </div>
  );
}

// ─── Rate limit card ──────────────────────────────────────────────────

function RateLimitCard({ clientId }: { readonly clientId: string }) {
  const { data, isLoading } = useMailRateLimit(clientId);
  const info = data?.data;
  const sourceLabels: Record<string, string> = {
    client_override: 'Account-specific override',
    platform_default: 'Platform default',
    hardcoded_default: 'Default',
    suspended: 'Suspended',
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-3" data-testid="rate-limit-card">
      <div className="flex items-center gap-2">
        <Gauge size={16} className="text-brand-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Outbound send rate limit</h3>
      </div>

      {isLoading && <div className="py-2 text-center"><Loader2 size={16} className="inline animate-spin text-brand-500" /></div>}

      {info && (
        <div className="grid grid-cols-[140px_1fr] gap-1 text-xs">
          <span className="text-gray-500 dark:text-gray-400">Messages/hour</span>
          <span className={clsx(
            'font-semibold',
            info.suspended ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-gray-100',
          )}>
            {info.limitPerHour}
            {info.suspended && ' (account suspended)'}
          </span>
          <span className="text-gray-500 dark:text-gray-400">Source</span>
          <span className="text-gray-700 dark:text-gray-300">{sourceLabels[info.source] ?? info.source}</span>
        </div>
      )}
    </div>
  );
}

// ─── IMAPSync migration panel (Phase 3) ──────────────────────────────
// Rendered inside the Mailboxes tab — migration IS a mailbox action.

function ImapSyncPanel({
  clientId,
  mailboxes,
}: {
  readonly clientId: string;
  readonly mailboxes: readonly { id: string; fullAddress: string }[];
}) {
  const { data: jobsRes, isLoading } = useImapSyncJobs(clientId);
  const create = useCreateImapSyncJob(clientId);
  const cancel = useCancelImapSyncJob(clientId);
  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const jobs = jobsRes?.data ?? [];

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);
    const fd = new FormData(e.currentTarget);
    try {
      await create.mutateAsync({
        mailbox_id: String(fd.get('mailbox_id') ?? ''),
        source_host: String(fd.get('source_host') ?? ''),
        source_port: parseInt(String(fd.get('source_port') ?? '993'), 10),
        source_username: String(fd.get('source_username') ?? ''),
        source_password: String(fd.get('source_password') ?? ''),
        source_ssl: fd.get('source_ssl') === 'on',
        options: {
          automap: fd.get('automap') === 'on',
          dryRun: fd.get('dry_run') === 'on',
        },
      });
      setShowForm(false);
      (e.currentTarget as HTMLFormElement).reset();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to start sync');
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-3" data-testid="imapsync-panel">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Download size={16} className="text-brand-500" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Migrate from external IMAP</h3>
        </div>
        <button
          type="button"
          onClick={() => setShowForm(s => !s)}
          className="inline-flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          data-testid="imapsync-toggle-form"
        >
          {showForm ? 'Cancel' : 'New migration'}
        </button>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Run a one-shot migration from an external IMAP server (Gmail, Outlook, legacy hosting) into one of your mailboxes.
      </p>

      {showForm && (
        <form onSubmit={onSubmit} className="rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-3 space-y-2 text-xs">
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="block text-gray-500 dark:text-gray-400">Destination mailbox</span>
              <select name="mailbox_id" required className={INPUT_CLASS}>
                {mailboxes.map(m => <option key={m.id} value={m.id}>{m.fullAddress}</option>)}
              </select>
            </label>
            <label className="space-y-1">
              <span className="block text-gray-500 dark:text-gray-400">Source host</span>
              <input name="source_host" required placeholder="imap.gmail.com" className={INPUT_CLASS} />
            </label>
            <label className="space-y-1">
              <span className="block text-gray-500 dark:text-gray-400">Source port</span>
              <input name="source_port" type="number" defaultValue={993} required className={INPUT_CLASS} />
            </label>
            <label className="space-y-1">
              <span className="block text-gray-500 dark:text-gray-400">Source username</span>
              <input name="source_username" required className={INPUT_CLASS} />
            </label>
            <label className="col-span-2 space-y-1">
              <span className="block text-gray-500 dark:text-gray-400">Source password</span>
              <input name="source_password" type="password" required className={INPUT_CLASS} autoComplete="new-password" />
            </label>
          </div>
          <div className="flex items-center gap-4 pt-1">
            <label className="inline-flex items-center gap-1 text-gray-600 dark:text-gray-300">
              <input type="checkbox" name="source_ssl" defaultChecked /> SSL
            </label>
            <label className="inline-flex items-center gap-1 text-gray-600 dark:text-gray-300">
              <input type="checkbox" name="automap" defaultChecked /> Automap folders
            </label>
            <label className="inline-flex items-center gap-1 text-gray-600 dark:text-gray-300">
              <input type="checkbox" name="dry_run" /> Dry run
            </label>
          </div>
          {formError && <p className="text-red-600 dark:text-red-400">{formError}</p>}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={create.isPending}
              className="inline-flex items-center gap-1 rounded-md bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              data-testid="imapsync-submit"
            >
              {create.isPending && <Loader2 size={12} className="animate-spin" />}
              Start migration
            </button>
          </div>
        </form>
      )}

      {isLoading && <div className="py-2 text-center"><Loader2 size={16} className="inline animate-spin text-brand-500" /></div>}
      {!isLoading && jobs.length === 0 && !showForm && (
        <p className="text-xs italic text-gray-500 dark:text-gray-400">No migrations yet.</p>
      )}
      {jobs.map(j => <ImapSyncJobRow key={j.id} job={j} onCancel={() => cancel.mutate(j.id)} cancelPending={cancel.isPending} />)}
    </div>
  );
}

function ImapSyncJobRow({
  job,
  onCancel,
  cancelPending,
}: {
  readonly job: ImapSyncJob;
  readonly onCancel: () => void;
  readonly cancelPending: boolean;
}) {
  const [showLog, setShowLog] = useState(false);
  const isActive = job.status === 'pending' || job.status === 'running';
  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3 text-xs" data-testid={`imapsync-job-${job.id}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <code className="font-mono text-gray-900 dark:text-gray-100">{job.sourceUsername}@{job.sourceHost}</code>
          <ImapSyncStatusBadge status={job.status} />
        </div>
        {isActive && (
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelPending}
            className="rounded border border-red-200 dark:border-red-700 px-2 py-0.5 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
          >
            Cancel
          </button>
        )}
      </div>
      <div className="mt-1 text-gray-500 dark:text-gray-400">
        Started {job.startedAt ? new Date(job.startedAt).toLocaleString() : '—'}
        {job.finishedAt && ` · Finished ${new Date(job.finishedAt).toLocaleString()}`}
      </div>
      {job.errorMessage && <p className="mt-1 text-red-600 dark:text-red-400">{job.errorMessage}</p>}
      {job.logTail && (
        <div className="mt-2">
          <button type="button" onClick={() => setShowLog(s => !s)} className="text-brand-600 dark:text-brand-400 hover:underline">
            {showLog ? 'Hide log' : 'Show log'}
          </button>
          {showLog && (
            <pre className="mt-1 max-h-48 overflow-auto rounded bg-gray-900 p-2 font-mono text-[11px] text-gray-100">{job.logTail}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function ImapSyncStatusBadge({ status }: { readonly status: ImapSyncJob['status'] }) {
  const styles = {
    pending: 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300',
    running: 'bg-blue-100 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
    succeeded: 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400',
    failed: 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400',
    cancelled: 'bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400',
  } as const;
  return <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${styles[status]}`}>{status}</span>;
}
