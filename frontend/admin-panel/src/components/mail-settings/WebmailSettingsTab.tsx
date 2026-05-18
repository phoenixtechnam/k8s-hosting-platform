import { useEffect, useState, type FormEvent } from 'react';
import { Save, Loader2, CheckCircle, Mail, ExternalLink } from 'lucide-react';
import { useWebmailSettings, useUpdateWebmailSettings } from '@/hooks/use-webmail-settings';
import MailTaskProgressModal from '@/components/MailTaskProgressModal';

const INPUT_CLASS =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

type WebmailEngine = 'roundcube' | 'bulwark';

interface EngineMeta {
  readonly key: WebmailEngine;
  readonly label: string;
  readonly tagline: string;
  readonly bullets: ReadonlyArray<string>;
  readonly docsHref: string;
}

const ENGINES: ReadonlyArray<EngineMeta> = [
  {
    key: 'roundcube',
    label: 'Roundcube',
    tagline: 'PHP IMAP webmail. Battle-tested across the platform since v1.',
    bullets: [
      'IMAP/SMTP under the hood — works against Stalwart out of the box.',
      'Per-tenant subdomain (webmail.<clientdomain>) with its own TLS cert.',
      'Plugin ecosystem — sieve filters, Bongo CalDAV, ManageSieve.',
    ],
    docsHref: 'https://roundcube.net/',
  },
  {
    key: 'bulwark',
    label: 'Bulwark',
    tagline: 'Modern JMAP-native client purpose-built for Stalwart (ADR-039).',
    bullets: [
      'Speaks JMAP directly — lower latency, no IMAP→JMAP translation.',
      'Reuses the same webmail.<apex> URL — no extra DNS or cert work.',
      'Master-user impersonation lets tenant_admin open any mailbox SSO-style.',
    ],
    docsHref: 'https://bulwarkmail.org/',
  },
];

/**
 * Webmail engine + URL settings. The engine selector is platform-wide:
 * once flipped, every `Open Webmail` button in tenant-panel mints a
 * handoff token shaped for the chosen engine. There is no per-tenant
 * override (per ADR-039 §Phase 10 — the SSO contract differs between
 * engines and the operator cost of supporting both per-tenant is
 * unjustified).
 */
export default function WebmailSettingsTab() {
  const { data: response, isLoading, isError, error } = useWebmailSettings();
  const update = useUpdateWebmailSettings();
  const settings = response?.data;

  const [defaultWebmailUrl, setDefaultWebmailUrl] = useState('');
  const [engine, setEngine] = useState<WebmailEngine>('roundcube');
  // 2026-05-18: webmail feature-visibility toggles. Default to hidden
  // (false) on a fresh install so the OOTB experience is mail-only.
  // Stalwart's DAV endpoints stay reachable — DAV clients keep working.
  const [showContacts, setShowContacts] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // taskId returned by the PATCH response when the engine changes. The
  // backend kicks off a 5-step background task (IR flip → Pod mutex →
  // wait-ready → URL probe → finalize); we mount MailTaskProgressModal
  // here so the operator sees the live checklist. Closing the modal
  // only dismisses the UI — the chip in the top bar keeps tracking.
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setDefaultWebmailUrl(settings.defaultWebmailUrl ?? '');
    setEngine(settings.defaultWebmailEngine ?? 'roundcube');
    setShowContacts(settings.webmailShowContacts ?? false);
    setShowCalendar(settings.webmailShowCalendar ?? false);
    setShowFiles(settings.webmailShowFiles ?? false);
  }, [settings]);

  const urlChanged =
    defaultWebmailUrl.trim().length > 0
    && defaultWebmailUrl !== (settings?.defaultWebmailUrl ?? '');
  const engineChanged = engine !== (settings?.defaultWebmailEngine ?? 'roundcube');
  const contactsChanged = showContacts !== (settings?.webmailShowContacts ?? false);
  const calendarChanged = showCalendar !== (settings?.webmailShowCalendar ?? false);
  const filesChanged = showFiles !== (settings?.webmailShowFiles ?? false);

  const handleSave = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    setSaveError(null);

    const payload: {
      defaultWebmailUrl?: string;
      defaultWebmailEngine?: WebmailEngine;
      webmailShowContacts?: boolean;
      webmailShowCalendar?: boolean;
      webmailShowFiles?: boolean;
    } = {};
    if (urlChanged) payload.defaultWebmailUrl = defaultWebmailUrl.trim();
    if (engineChanged) payload.defaultWebmailEngine = engine;
    if (contactsChanged) payload.webmailShowContacts = showContacts;
    if (calendarChanged) payload.webmailShowCalendar = showCalendar;
    if (filesChanged) payload.webmailShowFiles = showFiles;

    if (Object.keys(payload).length === 0) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      return;
    }

    update.mutate(payload, {
      onSuccess: (resp) => {
        // Engine-flip path: backend emits a taskId. Open the progress
        // modal so the operator sees IR flip → Pod scale → wait-ready
        // → URL verify instead of a green-checkmark-and-out (which
        // would have lied — the IR flip can take 5-30s to converge).
        if (resp.data.taskId) {
          setActiveTaskId(resp.data.taskId);
        } else {
          setSaved(true);
          setTimeout(() => setSaved(false), 3000);
        }
      },
      onError: (err) => {
        setSaveError(err instanceof Error ? err.message : 'Failed to save webmail settings');
      },
    });
  };

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading webmail settings…
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 shadow-sm p-5 text-sm text-red-700 dark:text-red-300">
        Failed to load webmail settings:{' '}
        {error instanceof Error ? error.message : 'unknown error'}
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSave}
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 space-y-5"
      data-testid="webmail-settings-tab"
    >
      <div className="flex items-center gap-3">
        <Mail size={20} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Webmail</h2>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        Pick the webmail tenant every mailbox lands in when a customer
        clicks &ldquo;Open Webmail&rdquo;. Both engines share the same{' '}
        <code>webmail.&lt;apex&gt;</code> hostname &mdash; flipping the
        engine switches which backend serves that URL. Only one engine is
        active at a time.
      </p>

      {/* Engine selector */}
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Default engine
        </label>
        <div
          className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2"
          role="radiogroup"
          aria-label="Default webmail engine"
        >
          {ENGINES.map((meta) => {
            const isActive = engine === meta.key;
            return (
              <button
                type="button"
                key={meta.key}
                role="radio"
                aria-checked={isActive}
                onClick={() => setEngine(meta.key)}
                className={`text-left rounded-xl border px-4 py-3 transition focus:outline-none focus:ring-2 focus:ring-brand-500 ${
                  isActive
                    ? 'border-brand-500 ring-1 ring-brand-500 bg-brand-50 dark:bg-brand-900/20'
                    : 'border-gray-200 dark:border-gray-700 hover:border-brand-300 dark:hover:border-brand-500'
                }`}
                data-testid={`webmail-engine-${meta.key}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-gray-900 dark:text-gray-100">
                    {meta.label}
                  </span>
                  {isActive && (
                    <span className="inline-flex items-center rounded-md bg-brand-500 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white">
                      Active
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{meta.tagline}</p>
                <ul className="mt-2 space-y-1 text-xs text-gray-500 dark:text-gray-400 list-disc list-inside">
                  {meta.bullets.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
                <a
                  href={meta.docsHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="mt-2 inline-flex items-center gap-1 text-[11px] text-brand-600 dark:text-brand-400 hover:underline"
                >
                  Project page <ExternalLink size={10} />
                </a>
              </button>
            );
          })}
        </div>
      </div>

      {/* Default webmail URL */}
      <div>
        <label
          htmlFor="webmail-default-url"
          className="block text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Default webmail URL
        </label>
        <input
          id="webmail-default-url"
          type="url"
          value={defaultWebmailUrl}
          onChange={(e) => setDefaultWebmailUrl(e.target.value)}
          placeholder="https://webmail.example.com"
          className={`mt-1 ${INPUT_CLASS}`}
          data-testid="webmail-default-url-input"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Used as the SSO login URL for both engines (Roundcube falls back
          to per-tenant <code>webmail.&lt;clientdomain&gt;</code> when the
          tenant&apos;s domain hosts its own webmail). The platform&apos;s
          webmail IngressRoute is reconciled to point at whichever engine
          is active.
        </p>
      </div>

      {/* 2026-05-18: webmail feature-visibility toggles.
          Stalwart serves CardDAV / CalDAV / WebDAV regardless of these
          flags — they only control whether the corresponding nav entry
          appears in the webmail UI (Bulwark + Roundcube). DAV clients
          (Thunderbird, iOS, macOS) keep working in both states. Flipping
          a toggle triggers a rolling restart of the webmail Deployments
          so the new CSS is applied; expect a ~30 s reload before the
          change is visible in webmail tabs. */}
      <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Webmail features
        </h3>
        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
          Hide or show secondary tabs in the webmail UI. Stalwart&apos;s
          CalDAV / CardDAV / WebDAV endpoints stay reachable for native
          clients regardless of these toggles &mdash; flipping a switch
          rolls the webmail Pods (~30 s).
        </p>
        <div className="mt-3 space-y-2">
          {([
            {
              key: 'contacts' as const,
              label: 'Contacts',
              hint: 'Address book tab in Bulwark + Roundcube.',
              value: showContacts,
              setValue: setShowContacts,
            },
            {
              key: 'calendar' as const,
              label: 'Calendar',
              hint: 'Calendar tab in Bulwark. Roundcube ships no calendar plugin.',
              value: showCalendar,
              setValue: setShowCalendar,
            },
            {
              key: 'files' as const,
              label: 'Files',
              hint: 'WebDAV files tab in Bulwark. Roundcube has no files feature.',
              value: showFiles,
              setValue: setShowFiles,
            },
          ]).map((row) => (
            <label
              key={row.key}
              className="flex items-start gap-3 cursor-pointer"
              data-testid={`webmail-feature-${row.key}`}
            >
              <input
                type="checkbox"
                checked={row.value}
                onChange={(e) => row.setValue(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-600 focus:ring-brand-500"
                data-testid={`webmail-feature-${row.key}-input`}
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-900 dark:text-gray-100">
                  Show <span className="font-medium">{row.label}</span> in webmail
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">{row.hint}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={update.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-brand-600 disabled:opacity-50"
          data-testid="webmail-settings-save"
        >
          {update.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {update.isPending ? 'Saving…' : 'Save'}
        </button>

        {saved && (
          <span className="inline-flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle size={14} /> Saved
          </span>
        )}

        {saveError && <span className="text-sm text-red-600 dark:text-red-400">{saveError}</span>}
      </div>

      {activeTaskId && (
        <MailTaskProgressModal
          taskId={activeTaskId}
          onClose={() => {
            setActiveTaskId(null);
            // After the task completes the operator may want the
            // "Saved" pill; show it once they dismiss the modal.
            setSaved(true);
            setTimeout(() => setSaved(false), 3000);
          }}
        />
      )}
    </form>
  );
}
