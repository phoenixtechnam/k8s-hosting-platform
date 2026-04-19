import { useEffect, useState, type FormEvent } from 'react';
import { Save, Loader2, CheckCircle, AlertTriangle, Server } from 'lucide-react';
import { useWebmailSettings, useUpdateWebmailSettings } from '@/hooks/use-webmail-settings';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

/**
 * Platform-wide mail server settings. These power:
 *   - SMTP/IMAP hostname announced in the 220 greeting + TLS cert SAN
 *   - Webmail base URL used by mailbox SSO and the admin panel's "Open Webmail"
 *     affordance
 *
 * The hostname is the authoritative value the running Stalwart StatefulSet
 * reads from its Secret at startup. Saving a new hostname triggers a rolling
 * restart so the 220 greeting switches within ~10-30s.
 */
export default function MailServerSettings() {
  const { data: response, isLoading, isError, error } = useWebmailSettings();
  const update = useUpdateWebmailSettings();
  const settings = response?.data;

  const [mailServerHostname, setMailServerHostname] = useState('');
  const [defaultWebmailUrl, setDefaultWebmailUrl] = useState('');
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) {
      setMailServerHostname(settings.mailServerHostname ?? '');
      setDefaultWebmailUrl(settings.defaultWebmailUrl ?? '');
    }
  }, [settings]);

  const hostnameDirty =
    settings !== undefined && mailServerHostname !== (settings.mailServerHostname ?? '');

  const handleSave = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    setSaveError(null);

    // Send only fields that actually changed so we don't trigger a
    // Stalwart rollout when editing only the webmail URL.
    const payload: {
      mailServerHostname?: string;
      defaultWebmailUrl?: string;
    } = {};
    if (mailServerHostname && mailServerHostname !== (settings?.mailServerHostname ?? '')) {
      payload.mailServerHostname = mailServerHostname;
    }
    if (defaultWebmailUrl && defaultWebmailUrl !== (settings?.defaultWebmailUrl ?? '')) {
      payload.defaultWebmailUrl = defaultWebmailUrl;
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
        Platform-wide defaults. The hostname is what Stalwart announces on the SMTP
        220 banner and embeds in its TLS certificate. The webmail URL is the base
        link used by mailbox single sign-on when a domain doesn&apos;t override it.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="mail-hostname" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
            SMTP/IMAP hostname
          </label>
          <input
            id="mail-hostname"
            type="text"
            value={mailServerHostname}
            onChange={(e) => setMailServerHostname(e.target.value)}
            placeholder="mail.example.com"
            className={`mt-1 ${INPUT_CLASS}`}
            data-testid="mail-hostname-input"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Fully-qualified domain that clients use to connect. rDNS should match for outbound delivery to work reliably.
          </p>
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

      {hostnameDirty && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/20 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-200">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-300" />
          <div>
            Saving the hostname will <strong>restart the Stalwart mail server</strong>{' '}
            (brief SMTP/IMAP outage, typically 10-30 seconds). The TLS certificate will
            also be re-issued to match.
          </div>
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
