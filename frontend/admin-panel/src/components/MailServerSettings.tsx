import { useEffect, useState, type FormEvent } from 'react';
import { Save, Loader2, CheckCircle, Server, AlertTriangle } from 'lucide-react';
import { useWebmailSettings, useUpdateWebmailSettings } from '@/hooks/use-webmail-settings';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

// Loose FQDN validator — accepts hostnames that look like real DNS
// names (no spaces, has a dot, alphanumeric + dash). The backend does
// the strict check; this is a pre-submit hint that catches the most
// obvious typos.
const FQDN_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/i;

/**
 * Platform-wide mail server settings.
 *
 * Both the SMTP/IMAP hostname AND the webmail URL are operator-editable.
 *
 * Hostname change semantics (2026-05-09):
 *   The PATCH endpoint pushes the new value to Stalwart's
 *   `SystemSettings.defaultHostname` first via the JMAP admin API.
 *   That single field drives both inbound listener banners (SMTP 220,
 *   IMAP greeting, ...) AND outbound EHLO via `MtaConnectionStrategy`'s
 *   null-fallback. If Stalwart accepts, the platform_settings row is
 *   updated; if Stalwart rejects, the DB row is NOT touched so the
 *   running server and the stored config can't drift.
 *
 *   Operator-side coordination (NOT auto-applied) for a full rename:
 *     1. The Stalwart Domain row's `subjectAlternativeNames` must
 *        include the new hostname before STARTTLS clients see a
 *        matching cert. Stalwart's ACME loop re-issues automatically
 *        once the SAN is updated.
 *     2. DNS MX + A records pointing at the cluster.
 *     3. Reverse DNS at the IP-provider level for outbound deliverability.
 */
export default function MailServerSettings() {
  const { data: response, isLoading, isError, error } = useWebmailSettings();
  const update = useUpdateWebmailSettings();
  const settings = response?.data;

  const [defaultWebmailUrl, setDefaultWebmailUrl] = useState('');
  const [mailServerHostname, setMailServerHostname] = useState('');
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) {
      setDefaultWebmailUrl(settings.defaultWebmailUrl ?? '');
      setMailServerHostname(settings.mailServerHostname ?? '');
    }
  }, [settings]);

  const trimmedHostname = mailServerHostname.trim();
  const hostnameChanged =
    trimmedHostname.length > 0 && trimmedHostname !== (settings?.mailServerHostname ?? '');
  const hostnameLooksValid = !hostnameChanged || FQDN_RE.test(trimmedHostname);

  const handleSave = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    setSaveError(null);

    const payload: { defaultWebmailUrl?: string; mailServerHostname?: string } = {};
    if (defaultWebmailUrl && defaultWebmailUrl !== (settings?.defaultWebmailUrl ?? '')) {
      payload.defaultWebmailUrl = defaultWebmailUrl;
    }
    if (hostnameChanged) {
      if (!hostnameLooksValid) {
        setSaveError('Mail server hostname must be a valid FQDN (e.g. mail.example.com).');
        return;
      }
      payload.mailServerHostname = trimmedHostname;
    }

    if (Object.keys(payload).length === 0) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      return;
    }

    update.mutate(payload, {
      onSuccess: () => {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      },
      onError: (err) => {
        setSaveError(err instanceof Error ? err.message : 'Failed to save mail server settings');
      },
    });
  };

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading mail server settings…
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 shadow-sm p-5 text-sm text-red-700 dark:text-red-300">
        Failed to load mail server settings: {error instanceof Error ? error.message : 'unknown error'}
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSave}
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 space-y-4"
      data-testid="mail-server-settings"
    >
      <div className="flex items-center gap-3">
        <Server size={20} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Mail Server Settings</h2>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        The SMTP/IMAP hostname drives Stalwart&apos;s connection banners and
        outbound EHLO. The webmail URL is the fallback link used by mailbox
        single sign-on when a domain doesn&apos;t override it.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label
            htmlFor="mail-hostname"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300"
          >
            SMTP/IMAP hostname
          </label>
          <input
            id="mail-hostname"
            type="text"
            inputMode="url"
            value={mailServerHostname}
            onChange={(e) => setMailServerHostname(e.target.value)}
            placeholder="mail.example.com"
            className={`mt-1 ${INPUT_CLASS} font-mono ${
              hostnameChanged && !hostnameLooksValid
                ? 'border-amber-400 dark:border-amber-500 focus:border-amber-500 focus:ring-amber-500'
                : ''
            }`}
            data-testid="mail-hostname-input"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={hostnameChanged && !hostnameLooksValid}
          />
          {hostnameChanged && !hostnameLooksValid ? (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              Must be a valid FQDN (e.g. mail.example.com).
            </p>
          ) : (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Pushes to Stalwart&apos;s <code>SystemSettings.defaultHostname</code>{' '}
              — drives banners + outbound EHLO. Cert SAN, DNS MX records, and
              reverse DNS still need operator-side coordination.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="webmail-url" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            Default webmail URL
          </label>
          <input
            id="webmail-url"
            type="url"
            value={defaultWebmailUrl}
            onChange={(e) => setDefaultWebmailUrl(e.target.value)}
            placeholder="https://webmail.example.com"
            className={`mt-1 ${INPUT_CLASS}`}
            data-testid="webmail-url-input"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Used for SSO login links when a client&apos;s domain doesn&apos;t host its own webmail.
          </p>
        </div>
      </div>

      {hostnameChanged && (
        <div
          className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
          role="alert"
          data-testid="hostname-change-warning"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            <strong>Hostname change requires manual follow-up.</strong> After
            saving: (1) add the new hostname to the Stalwart Domain&apos;s{' '}
            <code>subjectAlternativeNames</code> so the ACME loop re-issues a
            cert that covers it; (2) update the cluster&apos;s DNS MX + A records
            to point at the new name; (3) coordinate reverse DNS / FCrDNS at
            the IP-provider level so outbound mail isn&apos;t penalised. Roll
            <code> deploy/stalwart-mail</code> to refresh banner state.
          </span>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={update.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-600 disabled:opacity-50"
          data-testid="mail-server-settings-save"
        >
          {update.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {update.isPending ? 'Saving…' : 'Save'}
        </button>

        {saved && (
          <span className="inline-flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle size={14} /> Saved
          </span>
        )}

        {saveError && (
          <span className="text-sm text-red-600 dark:text-red-400">{saveError}</span>
        )}
      </div>
    </form>
  );
}
