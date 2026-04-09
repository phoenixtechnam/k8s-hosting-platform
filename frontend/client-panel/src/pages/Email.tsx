import { useState, useEffect, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Mail, Plus, Trash2, Loader2, AlertCircle, X, ExternalLink, ArrowRight, Edit2, Settings, Copy, CheckCircle, Shield, Key, RefreshCw, Gauge, Download, Inbox, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import { useClientContext } from '@/hooks/use-client-context';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';
import { useDomains } from '@/hooks/use-domains';

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
  useDisableEmailDomain,
  useEmailDomainDisablePreview,
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
  usePurgeImapSyncJob,
  useResyncImapSyncJob,
  useMailRateLimit,
  useMailboxUsage,
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

  // Round-4 Phase 1: top-level domain selector with URL persistence.
  // The selected emailDomain id lives in `?emailDomain=<id>` so the
  // selection survives reloads and is shareable. When the URL param
  // is missing or refers to a domain the client no longer has, fall
  // back to the first email-enabled domain.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlSelectedId = searchParams.get('emailDomain');
  const validUrlSelection = emailDomains.find((ed) => ed.id === urlSelectedId);
  const fallbackId = emailDomains[0]?.id;
  const selectedEmailDomainId = validUrlSelection?.id ?? fallbackId ?? null;
  const selectedEmailDomain = emailDomains.find((ed) => ed.id === selectedEmailDomainId) ?? null;

  // If the URL param is stale (e.g. the selected domain was just
  // deleted), repair the URL to match the fallback. This avoids the
  // user being stuck on a phantom selection.
  // Review MEDIUM-3: if the client has NO email domains at all,
  // strip the param entirely so a later add lands cleanly.
  useEffect(() => {
    if (domainsLoading) return;
    if (urlSelectedId && !validUrlSelection) {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (fallbackId) {
          next.set('emailDomain', fallbackId);
        } else {
          next.delete('emailDomain');
        }
        return next;
      }, { replace: true });
    }
  }, [domainsLoading, urlSelectedId, validUrlSelection, fallbackId, setSearchParams]);

  const handleDomainChange = (id: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('emailDomain', id);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Mail size={28} className="text-gray-700 dark:text-gray-300" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="email-heading">Email</h1>

        {/*
          Round-4 Phase 1: top-level domain selector. Decision per
          user: when only ONE email-enabled domain exists, show the
          domain name as plain text; otherwise render a dropdown so
          users can switch which domain's email config they're
          viewing. All tabs (Mailboxes / Aliases / Settings) filter
          their queries by `selectedEmailDomainId`.
        */}
        {!domainsLoading && emailDomains.length === 1 && (
          <span
            className="rounded-full border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-300"
            data-testid="email-domain-label"
          >
            {emailDomains[0].domainName}
          </span>
        )}
        {!domainsLoading && emailDomains.length > 1 && selectedEmailDomainId && (
          <select
            value={selectedEmailDomainId}
            onChange={(e) => handleDomainChange(e.target.value)}
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200"
            data-testid="email-domain-selector"
          >
            {emailDomains.map((ed) => (
              <option key={ed.id} value={ed.id}>
                {ed.domainName}
              </option>
            ))}
          </select>
        )}
      </div>

      {domainsLoading && <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-brand-500" /></div>}

      {!domainsLoading && emailDomains.length > 0 && selectedEmailDomain && (
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

          {tab === 'mailboxes' && (
            <MailboxesTab
              clientId={clientId!}
              emailDomain={selectedEmailDomain}
            />
          )}
          {tab === 'aliases' && (
            <AliasesTab
              clientId={clientId!}
              emailDomain={selectedEmailDomain}
            />
          )}
          {tab === 'settings' && (
            <SettingsTab
              clientId={clientId!}
              emailDomain={selectedEmailDomain}
            />
          )}
        </>
      )}

      {/*
        The Enable Email card is always available when there are
        domains that have NOT yet been email-enabled. The card
        filters out domains that already exist in emailDomains, so
        it auto-hides once every domain has email.
      */}
      {!domainsLoading && clientId && (
        <EnableEmailCard
          clientId={clientId}
          enabledDomainIds={emailDomains.map((ed) => ed.domainId)}
        />
      )}
    </div>
  );
}

// Phase 4 round-2: self-service Enable Email card.
//
// Shows the list of a client's domains that do NOT yet have email
// enabled, with an "Enable Email" button per row. Clicking it hits
// POST /api/v1/clients/:clientId/email/domains/:domainId/enable,
// which generates DKIM keys + provisions DNS records server-side.
//
// Phase 2 round-3: the parent page always mounts this component so
// newly-added domains can be enabled even after the client already
// has at least one email-hosted domain. `enabledDomainIds` filters
// out domains whose email_domains row already exists. When no
// eligible domains remain the card renders nothing at all.
function EnableEmailCard({
  clientId,
  enabledDomainIds = [],
}: {
  readonly clientId: string;
  readonly enabledDomainIds?: readonly string[];
}) {
  const { data: domainsRes, isLoading: domainsLoading } = useDomains(clientId);
  const enable = useEnableEmailDomain(clientId);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);

  const allDomains = domainsRes?.data ?? [];
  // Filter out domains that already have an email_domains row. Use a
  // Set for O(1) lookups even with hundreds of domains.
  const enabledSet = new Set(enabledDomainIds);
  const eligibleDomains = allDomains.filter((d) => !enabledSet.has(d.id));

  const handleEnable = async (domainId: string) => {
    setSubmittingId(domainId);
    setErrorId(null);
    try {
      await enable.mutateAsync({ domainId, input: {} });
    } catch {
      setErrorId(domainId);
    } finally {
      setSubmittingId(null);
    }
  };

  // If the domains list is still loading AND the client has no
  // email-enabled domains yet, show a spinner inside the card so the
  // user sees "something is happening". If the client already has
  // emailDomains, the tabs above are already visible — we can skip
  // rendering anything until the domains list resolves.
  if (domainsLoading && enabledDomainIds.length > 0) return null;

  // Nothing to enable — do not render the card at all. This is the
  // multi-domain case where every domain already has email enabled.
  if (!domainsLoading && eligibleDomains.length === 0 && allDomains.length > 0) {
    return null;
  }

  return (
    <div
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-8 shadow-sm"
      data-testid="email-enable-card"
    >
      <div className="flex items-start gap-4">
        <div className="rounded-xl bg-brand-50 dark:bg-brand-900/30 p-3">
          <Mail size={28} className="text-brand-600 dark:text-brand-400" />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {enabledDomainIds.length > 0 ? 'Enable Email for another domain' : 'Enable Email Hosting'}
          </h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Turn on email for one of your domains to start creating mailboxes. The
            platform will generate DKIM keys and publish DNS records for you.
          </p>
        </div>
      </div>

      <div className="mt-6 space-y-2">
        {domainsLoading && (
          <div className="flex justify-center py-6">
            <Loader2 size={18} className="animate-spin text-brand-500" />
          </div>
        )}
        {!domainsLoading && allDomains.length === 0 && (
          <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
            You don't have any domains yet. Add a domain from the Domains page, then come
            back here to enable email for it.
          </div>
        )}
        {!domainsLoading
          && eligibleDomains.map((d) => (
            <div
              key={d.id}
              className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/50 px-4 py-3"
              data-testid={`enable-email-row-${d.id}`}
            >
              <div>
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {d.domainName}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  DNS mode: {d.dnsMode ?? 'unknown'}
                </div>
                {errorId === d.id && enable.error && (
                  <div className="mt-1 flex items-center gap-1 text-xs text-red-600">
                    <AlertCircle size={12} />
                    {enable.error instanceof Error ? enable.error.message : 'Failed to enable'}
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={submittingId === d.id}
                onClick={() => handleEnable(d.id)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
                data-testid={`enable-email-button-${d.id}`}
              >
                {submittingId === d.id && <Loader2 size={12} className="animate-spin" />}
                {submittingId === d.id ? 'Enabling…' : 'Enable Email'}
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}

// Round-4 Phase 1: DisableEmailCard with server-side preview.
//
// Lives at the bottom of the Settings & DNS tab as a "danger zone".
// Opens a confirmation modal that fetches the authoritative
// disable preview from the backend (mailboxes, aliases, DNS
// records, DKIM keys, webmail hostname) and forces the user to type
// the domain name to enable the destructive Confirm button.
function DisableEmailCard({
  clientId,
  domain,
}: {
  readonly clientId: string;
  readonly domain: EmailDomain;
}) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const preview = useEmailDomainDisablePreview(clientId, domain.domainId, open);
  const disable = useDisableEmailDomain(clientId);

  const handleConfirm = async () => {
    try {
      await disable.mutateAsync(domain.domainId);
      setOpen(false);
      setConfirmText('');
    } catch {
      // Error shown inside the modal via disable.error
    }
  };

  const previewData = preview.data?.data;

  return (
    <>
      <div
        className="rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50/50 dark:bg-red-900/10 p-5 shadow-sm"
        data-testid="disable-email-card"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="text-red-600 dark:text-red-400 mt-0.5" />
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-red-700 dark:text-red-300">Danger zone</h3>
            <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
              Disabling email for <span className="font-mono">{domain.domainName}</span> will
              permanently delete all mailboxes, aliases, DKIM keys, DNS records, and the
              webmail site for this domain. The domain itself will remain active for
              non-email use (websites, ingress routes, etc.).
            </p>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
              data-testid="disable-email-button"
            >
              <Trash2 size={12} /> Disable email for this domain
            </button>
          </div>
        </div>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          data-testid="disable-email-modal"
        >
          <div className="w-full max-w-xl rounded-xl bg-white dark:bg-gray-800 p-6 shadow-xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-red-600 dark:text-red-400">Disable Email for {domain.domainName}</h3>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              The following resources will be permanently deleted. This action cannot be undone.
            </p>

            <div
              className="mt-4 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/20 p-4"
              data-testid="disable-email-preview-list"
            >
              {preview.isLoading && (
                <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
                  <Loader2 size={14} className="animate-spin" />
                  Loading cascade list…
                </div>
              )}
              {preview.isError && (
                <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                  <AlertCircle size={14} />
                  Failed to load preview — please cancel and try again.
                </div>
              )}
              {previewData && (
                <div className="space-y-3 text-sm">
                  {previewData.mailboxes.length > 0 && (
                    <div data-testid="disable-preview-mailboxes">
                      <div className="font-medium text-gray-700 dark:text-gray-300">
                        {previewData.mailboxes.length} mailbox(es):
                      </div>
                      <ul className="ml-4 mt-1 list-disc text-xs text-gray-600 dark:text-gray-400">
                        {previewData.mailboxes.slice(0, 10).map((m) => (
                          <li key={m.id}>{m.fullAddress}</li>
                        ))}
                        {previewData.mailboxes.length > 10 && (
                          <li className="italic">…and {previewData.mailboxes.length - 10} more</li>
                        )}
                      </ul>
                    </div>
                  )}

                  {previewData.aliases.length > 0 && (
                    <div data-testid="disable-preview-aliases">
                      <div className="font-medium text-gray-700 dark:text-gray-300">
                        {previewData.aliases.length} alias(es):
                      </div>
                      <ul className="ml-4 mt-1 list-disc text-xs text-gray-600 dark:text-gray-400">
                        {previewData.aliases.slice(0, 10).map((a) => (
                          <li key={a.id}>{a.sourceAddress}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {previewData.dkimKeys.length > 0 && (
                    <div data-testid="disable-preview-dkim">
                      <div className="font-medium text-gray-700 dark:text-gray-300">
                        {previewData.dkimKeys.length} DKIM key(s):
                      </div>
                      <ul className="ml-4 mt-1 list-disc text-xs text-gray-600 dark:text-gray-400">
                        {previewData.dkimKeys.map((k) => (
                          <li key={k.id}>{k.selector} ({k.status})</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {previewData.dnsRecords.length > 0 && (
                    <div data-testid="disable-preview-dns">
                      <div className="font-medium text-gray-700 dark:text-gray-300">
                        {previewData.dnsRecords.length} DNS record(s):
                      </div>
                      <ul className="ml-4 mt-1 list-disc text-xs text-gray-600 dark:text-gray-400">
                        {previewData.dnsRecords.slice(0, 15).map((r) => (
                          <li key={r.id}>
                            {r.type} {r.name ?? '(apex)'} {r.purpose && <span className="text-gray-400">[{r.purpose}]</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {previewData.webmailHostname && (
                    <div data-testid="disable-preview-webmail">
                      <div className="font-medium text-gray-700 dark:text-gray-300">Webmail site:</div>
                      <ul className="ml-4 mt-1 list-disc text-xs text-gray-600 dark:text-gray-400">
                        <li>{previewData.webmailHostname}</li>
                      </ul>
                    </div>
                  )}

                  {previewData.mailboxes.length === 0
                    && previewData.aliases.length === 0
                    && previewData.dnsRecords.length === 0
                    && previewData.dkimKeys.length === 0 && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      No resources to delete — only the email_domains row.
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="mt-4">
              <label htmlFor="disable-confirm-input" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Type <span className="font-mono font-bold text-gray-900 dark:text-gray-100">{domain.domainName}</span> to confirm
              </label>
              <input
                id="disable-confirm-input"
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={domain.domainName}
                className={INPUT_CLASS + ' mt-1'}
                data-testid="disable-confirm-input"
              />
            </div>

            {disable.isError && (
              <div className="mt-3 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                <AlertCircle size={14} />
                {disable.error instanceof Error ? disable.error.message : 'Failed to disable email'}
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setOpen(false); setConfirmText(''); }}
                className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600"
                data-testid="disable-cancel-button"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={
                  confirmText !== domain.domainName
                  || disable.isPending
                  || preview.isLoading
                  || preview.isError
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                data-testid="disable-confirm-button"
              >
                {disable.isPending && <Loader2 size={14} className="animate-spin" />}
                Disable Email
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Phase 5 round-2: client mailbox usage bar.
// Displays { current / limit } with a colored progress bar driven
// by the plan-based limit helper on the backend.
function MailboxUsageBar({ clientId }: { readonly clientId: string }) {
  const { data } = useMailboxUsage(clientId);
  const usage = data?.data;
  if (!usage) return null;
  const pct = usage.limit > 0 ? (usage.current / usage.limit) * 100 : 0;
  const nearLimit = pct >= 80;
  const atLimit = pct >= 100;
  const barColor = atLimit
    ? 'bg-red-500'
    : nearLimit
      ? 'bg-amber-500'
      : 'bg-brand-500';
  const containerBorder = atLimit
    ? 'border-red-200 dark:border-red-800'
    : nearLimit
      ? 'border-amber-200 dark:border-amber-800'
      : 'border-gray-200 dark:border-gray-700';
  return (
    <div
      className={clsx(
        'rounded-xl border bg-white dark:bg-gray-800 p-4 shadow-sm',
        containerBorder,
      )}
      data-testid="mailbox-usage-bar"
    >
      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        <Inbox size={14} />
        <span>Mailbox usage</span>
        <span className="ml-auto font-medium text-gray-700 dark:text-gray-200">
          {usage.current} / {usage.limit}
        </span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <div
          className={clsx('h-2 rounded-full transition-all', barColor)}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      {atLimit && (
        <p className="mt-2 text-xs text-red-600 dark:text-red-400">
          You have reached the mailbox limit for your plan. Remove an existing mailbox or
          contact your administrator to request a larger plan.
        </p>
      )}
      {!atLimit && nearLimit && (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
          You're approaching your plan's mailbox limit. Consider upgrading if you'll need more.
        </p>
      )}
      {usage.source === 'client_override' && (
        <p className="mt-1 text-[10px] text-gray-400 dark:text-gray-500">
          Limit set by per-client override.
        </p>
      )}
    </div>
  );
}

// Round-4 Phase 1: tabs receive a SINGLE selected emailDomain
// instead of the array. The top-level selector picks which one.
function MailboxesTab({
  clientId,
  emailDomain,
}: {
  readonly clientId: string;
  readonly emailDomain: { readonly id: string; readonly domainName: string };
}) {
  // Round-4 Phase 1: scope mailboxes to the selected emailDomain.
  const { data: res, isLoading } = useMailboxes(clientId, emailDomain.id);
  const deleteMailbox = useDeleteMailbox(clientId);
  const webmailToken = useWebmailToken();
  const [showForm, setShowForm] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [editingMailbox, setEditingMailbox] = useState<Mailbox | null>(null);
  const [form, setForm] = useState({ local_part: '', password: '', display_name: '', quota_mb: '1024' });

  const mailboxesRaw = res?.data ?? [];
  const { sortedData: mailboxes, sortKey, sortDirection, onSort } = useSortable(mailboxesRaw, 'fullAddress');
  const createMailbox = useCreateMailbox(clientId, emailDomain.id);

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

  const domainName = emailDomain.domainName;

  return (
    <div className="space-y-4">
      <MailboxUsageBar clientId={clientId} />
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">{mailboxesRaw.length} mailbox{mailboxesRaw.length !== 1 ? 'es' : ''}</p>
        <button type="button" onClick={() => setShowForm(p => !p)} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600" data-testid="add-mailbox-button">
          {showForm ? <X size={14} /> : <Plus size={14} />} {showForm ? 'Cancel' : 'Create Mailbox'}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-4" data-testid="create-mailbox-form">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/*
              Round-4 Phase 1: per-tab Domain selector removed. The
              parent page's top-level selector now controls which
              domain mailboxes are scoped to.
            */}
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

function AliasesTab({
  clientId,
  emailDomain,
}: {
  readonly clientId: string;
  readonly emailDomain: { readonly id: string; readonly domainName: string };
}) {
  // Round-4 Phase 1: scope aliases to the selected emailDomain.
  const { data: res, isLoading } = useEmailAliases(clientId, emailDomain.id);
  const deleteAlias = useDeleteEmailAlias(clientId);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ source: '', destinations: '' });
  const createAlias = useCreateEmailAlias(clientId, emailDomain.id);

  const aliases = res?.data ?? [];
  const domainName = emailDomain.domainName;

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
  emailDomain,
}: {
  readonly clientId: string;
  readonly emailDomain: EmailDomain;
}) {
  // Round-4 Phase 1: per-tab Domain selector removed; the parent
  // page's top-level selector is the single source of truth.
  const current = emailDomain;

  return (
    <div className="space-y-6" data-testid="settings-tab">
      <DomainSettingsCard clientId={clientId} domain={current} />
      <DnsRecordsCard clientId={clientId} domain={current} />
      <DkimKeysCard clientId={clientId} domain={current} />
      <SendmailCredentialCard clientId={clientId} />
      <RateLimitCard clientId={clientId} />
      {/* Round-4 Phase 1: Danger zone — disable email for the current domain */}
      <DisableEmailCard clientId={clientId} domain={current} />
    </div>
  );
}

// Round-4 Phase 2: webmail provisioning lifecycle badge.
//
// Renders next to the webmail enable toggle in the Settings tab.
// 'pending' = blue (provisioning in flight)
// 'ready' = green (Ingress + TLS up)
// 'ready_no_tls' = amber (Ingress up, cert pending — site is HTTP)
// 'failed' = red (Ingress could not be created at all)
// undefined = no badge (legacy rows or non-webmail-enabled domains)
function WebmailStatusBadge({
  status,
  message,
}: {
  readonly status: 'pending' | 'ready' | 'ready_no_tls' | 'failed' | undefined;
  readonly message: string | null;
}) {
  if (!status) return null;
  const meta: Record<string, { label: string; cls: string }> = {
    pending: {
      label: 'Provisioning…',
      cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    },
    ready: {
      label: 'Ready',
      cls: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
    },
    ready_no_tls: {
      label: 'Cert pending (HTTP only)',
      cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    },
    failed: {
      label: 'Failed',
      cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    },
  };
  const m = meta[status] ?? meta.pending;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${m.cls}`}
      title={message ?? m.label}
      data-testid={`webmail-status-${status}`}
    >
      {m.label}
    </span>
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
          <div className="flex items-center gap-3">
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
            <WebmailStatusBadge
              status={domain.webmailStatus}
              message={domain.webmailStatusMessage ?? null}
            />
          </div>
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

function purposeBadgeStyle(purpose: string | undefined): { label: string; cls: string } | null {
  if (!purpose) return null;
  switch (purpose) {
    case 'mx':
    case 'mail_host':
      return { label: 'mail', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' };
    case 'spf':
    case 'dkim':
    case 'dmarc':
      return { label: purpose.toUpperCase(), cls: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300' };
    case 'srv':
      return { label: 'srv', cls: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' };
    case 'autoconfig':
      return { label: 'autoconfig', cls: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300' };
    case 'mta_sts':
      return { label: 'mta-sts', cls: 'bg-slate-100 text-slate-700 dark:bg-slate-900/40 dark:text-slate-300' };
    case 'webmail':
      return { label: 'webmail', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300' };
    default:
      return null;
  }
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
  const badge = purposeBadgeStyle(record.purpose);
  return (
    <tr>
      <td className="py-2 pr-3 font-mono text-gray-900 dark:text-gray-100">
        <div className="flex items-center gap-1">
          <span>{record.type}</span>
          {badge && (
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
              {badge.label}
            </span>
          )}
        </div>
      </td>
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
  // Round-4 Phase 1: re-sync + purge for terminal jobs.
  const purge = usePurgeImapSyncJob(clientId);
  const resync = useResyncImapSyncJob(clientId);
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
      {jobs.map(j => (
        <ImapSyncJobRow
          key={j.id}
          job={j}
          onCancel={() => cancel.mutate(j.id)}
          cancelPending={cancel.isPending}
          onPurge={() => purge.mutate(j.id)}
          purgePending={purge.isPending}
          onResync={() => resync.mutate(j.id)}
          resyncPending={resync.isPending}
        />
      ))}
    </div>
  );
}

function ImapSyncJobRow({
  job,
  onCancel,
  cancelPending,
  onPurge,
  purgePending,
  onResync,
  resyncPending,
}: {
  readonly job: ImapSyncJob;
  readonly onCancel: () => void;
  readonly cancelPending: boolean;
  readonly onPurge: () => void;
  readonly purgePending: boolean;
  readonly onResync: () => void;
  readonly resyncPending: boolean;
}) {
  const [showLog, setShowLog] = useState(false);
  const isActive = job.status === 'pending' || job.status === 'running';
  const isTerminal = job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled';
  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3 text-xs" data-testid={`imapsync-job-${job.id}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <code className="font-mono text-gray-900 dark:text-gray-100">{job.sourceUsername}@{job.sourceHost}</code>
          <ImapSyncStatusBadge status={job.status} />
        </div>
        <div className="flex items-center gap-1">
          {isActive && (
            <button
              type="button"
              onClick={onCancel}
              disabled={cancelPending}
              className="rounded border border-red-200 dark:border-red-700 px-2 py-0.5 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
              data-testid={`imapsync-cancel-${job.id}`}
            >
              Cancel
            </button>
          )}
          {isTerminal && (
            <>
              <button
                type="button"
                onClick={onResync}
                disabled={resyncPending}
                className="rounded border border-brand-200 dark:border-brand-700 px-2 py-0.5 text-brand-700 dark:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/20 disabled:opacity-50"
                data-testid={`imapsync-resync-${job.id}`}
              >
                {resyncPending ? <Loader2 size={10} className="inline animate-spin" /> : <RefreshCw size={10} className="inline" />} Re-sync
              </button>
              <button
                type="button"
                onClick={onPurge}
                disabled={purgePending}
                className="rounded border border-red-200 dark:border-red-700 px-2 py-0.5 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
                data-testid={`imapsync-purge-${job.id}`}
              >
                <Trash2 size={10} className="inline" /> Delete
              </button>
            </>
          )}
        </div>
      </div>
      <div className="mt-1 text-gray-500 dark:text-gray-400">
        Started {job.startedAt ? new Date(job.startedAt).toLocaleString() : '—'}
        {job.finishedAt && ` · Finished ${new Date(job.finishedAt).toLocaleString()}`}
      </div>
      {job.errorMessage && <p className="mt-1 text-red-600 dark:text-red-400">{job.errorMessage}</p>}
      {job.logTail && (
        <div className="mt-2">
          <button type="button" onClick={() => setShowLog(s => !s)} className="text-brand-600 dark:text-brand-400 hover:underline" data-testid={`imapsync-log-toggle-${job.id}`}>
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
