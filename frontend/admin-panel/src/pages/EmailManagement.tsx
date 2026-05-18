import { useState } from 'react';
import {
  Mail, Globe, Server, Shield, Loader2, CheckCircle, XCircle, Plus, Trash2,
  TestTube, X, Key, Copy, ExternalLink, HardDrive, Settings, Archive as ArchiveIcon,
  Network,
} from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import StatCard from '@/components/ui/StatCard';
import {
  useAdminEmailDomains,
  useSmtpRelays,
  useCreateSmtpRelay,
  useDeleteSmtpRelay,
  useTestSmtpRelay,
  useUpdateEmailDomain,
  useDkimStatus,
  type DkimSelectorInfo,
} from '@/hooks/use-email';
import StalwartAdminPanel from '@/components/StalwartAdminPanel';
import MailSettingsTab from '@/components/mail-settings/MailSettingsTab';
import WebmailSettingsTab from '@/components/mail-settings/WebmailSettingsTab';
import MailStorageCard from '@/components/MailStorageCard';
import StalwartBlobStoreCard from '@/components/StalwartBlobStoreCard';
import MailDrCard from '@/components/MailDrCard';
import MailPortExposureCard from '@/components/MailPortExposureCard';
import MailArchiveCard from '@/components/MailArchiveCard';
import MailHealthBanner from '@/components/MailHealthBanner';
import MailSectionCard from '@/components/MailSectionCard';
import type { FormEvent } from 'react';
import { useSortable } from '@/hooks/use-sortable';
import SortableHeader from '@/components/ui/SortableHeader';

const INPUT_CLASS = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 placeholder:text-gray-400 dark:placeholder:text-gray-500 dark:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

type DomainsTab = 'domains' | 'relays';
type OpsTab = 'placement' | 'backups' | 'storage';
type BackupTab = 'snapshot' | 'archive';
type SettingsTab = 'mail' | 'webmail';

/**
 * Email Management page — Phase 3 streamline (2026-05-15).
 *
 * Pre-streamline layout: 7 always-expanded cards (Domains, Server settings,
 * Placement, Port exposure, Backups, Storage, Stalwart admin) dumped inline
 * — operator scrolled past 2000 lines of DOM to find the section they
 * needed. Status info was duplicated across cards (placement showed an
 * active-node tile that didn't verify the pod, storage showed a "PVC
 * capacity %" that wasn't enforced).
 *
 * Post-streamline:
 *
 *   1. Health banner (always at top, real probes from /admin/mail/health)
 *   2. Domains & SMTP relays (default-expanded, day-1 operator surface)
 *   3. Server settings (collapsible — hostname + webmail URL)
 *   4. Operations (collapsible — Placement / Backups / Storage tabs)
 *   5. Stalwart admin UI (collapsible — link to upstream Stalwart admin)
 *
 * Port exposure (a Day-99 toggle since Phase 2 made allServerNodes the
 * default) lives inside Operations → Placement → "Advanced" details.
 */
export default function EmailManagement() {
  const [domainsTab, setDomainsTab] = useState<DomainsTab>('domains');
  const [opsTab, setOpsTab] = useState<OpsTab>('placement');
  const [backupTab, setBackupTab] = useState<BackupTab>('snapshot');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('mail');
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

      {/* Always-visible real-probe health banner.
          Drill-down: pod | jmap | rocksdb | cert-per-port | tcp-per-port. */}
      <MailHealthBanner />

      {/* ─── Section 1: Domains & SMTP relays (daily-driver, default-open) ─── */}
      <MailSectionCard
        icon={Mail}
        title="Domains & SMTP relays"
        summary={
          domainsLoading
            ? 'Loading…'
            : `${domains.length} domain${domains.length === 1 ? '' : 's'} • ${totalMailboxes} mailbox${totalMailboxes === 1 ? '' : 'es'}`
        }
        dataTestId="mail-section-domains"
        defaultOpen
        storageKey="domains-and-relays"
      >
        <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
          {[
            { key: 'domains' as DomainsTab, label: 'Email Domains' },
            { key: 'relays' as DomainsTab, label: 'SMTP Relays' },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setDomainsTab(t.key)}
              className={`border-b-2 px-4 py-2.5 text-sm font-medium ${domainsTab === t.key ? 'border-brand-500 text-brand-600 dark:text-brand-400' : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
              data-testid={`tab-${t.key}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {domainsTab === 'domains' && <EmailDomainsTable domains={domains} isLoading={domainsLoading} />}
        {domainsTab === 'relays' && <SmtpRelaysSection />}
      </MailSectionCard>

      {/* ─── Section 2: Settings (mail + webmail tabs) ─── */}
      <MailSectionCard
        icon={Settings}
        title="Settings"
        summary="Mail hostname • Stalwart Web-Admin URL • Webmail engine"
        dataTestId="mail-section-settings"
        storageKey="mail-settings"
      >
        <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
          {[
            { key: 'mail' as SettingsTab, label: 'Mail Settings' },
            { key: 'webmail' as SettingsTab, label: 'Webmail' },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setSettingsTab(t.key)}
              className={`border-b-2 px-4 py-2.5 text-sm font-medium ${settingsTab === t.key ? 'border-brand-500 text-brand-600 dark:text-brand-400' : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}`}
              data-testid={`settings-tab-${t.key}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {settingsTab === 'mail' && <MailSettingsTab />}
        {settingsTab === 'webmail' && <WebmailSettingsTab />}
      </MailSectionCard>

      {/* ─── Section 3: Operations (placement / backups / storage) ─── */}
      <MailSectionCard
        icon={Server}
        title="Operations"
        summary="Placement & migration • Backups (snapshot + archive) • Storage"
        dataTestId="mail-section-operations"
        storageKey="operations"
      >
        <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
          {[
            { key: 'placement' as OpsTab, label: 'Placement & migration', icon: Network },
            { key: 'backups' as OpsTab, label: 'Backups', icon: ArchiveIcon },
            { key: 'storage' as OpsTab, label: 'Storage', icon: HardDrive },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setOpsTab(t.key)}
              className={`flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium ${
                opsTab === t.key
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
              data-testid={`ops-tab-${t.key}`}
            >
              <t.icon size={13} />
              {t.label}
            </button>
          ))}
        </div>

        {opsTab === 'placement' && (
          <div className="space-y-4">
            <MailDrCard />
            {/* Port exposure as Advanced collapsible — `allServerNodes` is
                the default since Phase 2. The toggle is retained for
                debugging single-node installs but rarely needed. */}
            <details className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
              <summary className="cursor-pointer px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
                Advanced — port exposure (debugging only)
              </summary>
              <div className="border-t border-gray-200 dark:border-gray-700 p-4">
                <MailPortExposureCard />
              </div>
            </details>
          </div>
        )}

        {opsTab === 'backups' && (
          <div className="space-y-3">
            <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
              {[
                { key: 'snapshot' as BackupTab, label: 'Snapshot (restic, 2-min interval)' },
                { key: 'archive' as BackupTab, label: 'Archive (DR export)' },
              ].map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setBackupTab(t.key)}
                  className={`border-b-2 px-4 py-2 text-sm font-medium ${
                    backupTab === t.key
                      ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                      : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}
                  data-testid={`backup-tab-${t.key}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {backupTab === 'snapshot' && (
              <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Mail snapshot health, restic stats, schedule + Trigger Now have moved to{' '}
                  <a href="/backups/system?tab=object" className="font-medium text-brand-600 dark:text-brand-400 hover:underline">
                    System Backups → Object Backups
                  </a>{' '}
                  alongside the other system-side backup paths.
                </p>
              </div>
            )}
            {backupTab === 'archive' && <MailArchiveCard />}
          </div>
        )}

        {opsTab === 'storage' && (
          <div className="space-y-4">
            <MailStorageCard />
            <details className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900">
              <summary className="cursor-pointer px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
                Blob store (S3-compatible, for large attachments)
              </summary>
              <div className="border-t border-gray-200 dark:border-gray-700 p-4">
                <StalwartBlobStoreCard />
              </div>
            </details>
          </div>
        )}
      </MailSectionCard>

      {/* ─── Section 4: Stalwart admin embed (advanced) ─── */}
      <MailSectionCard
        icon={Shield}
        title="Stalwart admin UI"
        summary="Direct access to the upstream Stalwart web admin (advanced)"
        dataTestId="mail-section-stalwart-admin"
        storageKey="stalwart-admin"
      >
        <StalwartAdminPanel />
      </MailSectionCard>
    </div>
  );
}

interface EmailDomainRow {
  readonly id: string;
  readonly tenantId: string;
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
        <DkimStatusModal
          domain={dkimDomain}
          onClose={() => setDkimDomain(null)}
        />
      )}
    </div>
  );
}

function EmailDomainRowView({ domain: d, onOpenDkim }: { readonly domain: EmailDomainRow; readonly onOpenDkim: () => void }) {
  const updateDomain = useUpdateEmailDomain(d.tenantId);
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
          title="View DKIM status (Stalwart manages rotation natively)"
        >
          <Key size={12} /> DKIM
        </button>
      </td>
    </tr>
  );
}

// ─── DKIM Status Modal (read-only, Stalwart 0.16 owns rotation) ────────

function DkimStatusModal({ domain: d, onClose }: { readonly domain: EmailDomainRow; readonly onClose: () => void }) {
  const { data: statusRes, isLoading } = useDkimStatus(d.id);
  const status = statusRes?.data;

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-xl bg-white dark:bg-gray-800 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-700 px-6 py-4">
          <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
            <Key size={18} className="text-amber-500" />
            DKIM Status — {d.domainName}
          </h3>
          <button onClick={onClose} className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700" data-testid="dkim-modal-close">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* Info banner: Stalwart owns rotation */}
          <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-700 dark:bg-blue-900/20 px-4 py-3 text-sm text-blue-800 dark:text-blue-300 flex items-start gap-2">
            <Shield size={15} className="mt-0.5 shrink-0" />
            <span>
              Stalwart 0.16 manages DKIM key generation and rotation natively.
              To rotate manually, use the{' '}
              <a
                href="/__stalwart/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 underline"
              >
                Stalwart admin UI <ExternalLink size={11} />
              </a>.
            </span>
          </div>

          {isLoading && (
            <div className="flex justify-center py-6">
              <Loader2 size={20} className="animate-spin text-brand-500" />
            </div>
          )}

          {!isLoading && !status?.zoneFileAvailable && (
            <div className="rounded-lg border border-dashed border-gray-200 dark:border-gray-700 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
              {status
                ? 'Zone file not yet available — Stalwart may still be provisioning this domain.'
                : 'Could not reach Stalwart. Check that the mail pod is running.'}
            </div>
          )}

          {!isLoading && status?.zoneFileAvailable && status.selectors.length === 0 && (
            <div className="rounded-lg border border-dashed border-amber-200 dark:border-amber-700 p-6 text-center text-sm text-amber-700 dark:text-amber-300">
              No DKIM selector records found in the Stalwart zone file.
              DKIM may not be configured for this domain yet — check the Stalwart admin UI.
            </div>
          )}

          {!isLoading && status?.zoneFileAvailable && status.selectors.length > 0 && (
            <div className="space-y-3">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {status.selectors.length} active {status.selectors.length === 1 ? 'selector' : 'selectors'} in Stalwart
              </p>
              {status.selectors.map((sel) => (
                <DkimSelectorCard key={sel.name} selector={sel} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DkimSelectorCard({ selector: sel }: { readonly selector: DkimSelectorInfo }) {
  const [copied, setCopied] = useState(false);
  const copyTxt = async () => {
    try {
      await navigator.clipboard.writeText(sel.txtValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* silently ignore */ }
  };

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 space-y-2">
      <div className="flex items-center justify-between">
        <code className="text-sm font-mono text-gray-900 dark:text-gray-100">{sel.name}</code>
        <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${sel.valid ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400' : 'bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400'}`}>
          {sel.valid ? 'valid' : 'invalid'}
        </span>
      </div>
      <div className="flex items-start gap-1">
        <code className="flex-1 break-all text-xs font-mono text-gray-600 dark:text-gray-400">{sel.txtValue}</code>
        <button
          type="button"
          onClick={copyTxt}
          className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
          title="Copy TXT value"
        >
          {copied ? <CheckCircle size={12} className="text-green-500" /> : <Copy size={12} />}
        </button>
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
