import { useState, useEffect, type FormEvent } from 'react';
import { Loader2, Save, CheckCircle, AlertCircle, RotateCcw, Link2 } from 'lucide-react';
import { usePlatformUrls, useUpdatePlatformUrls } from '@/hooks/use-platform-urls';

/**
 * Integrations — operator-editable URLs for services the admin panel
 * embeds (Longhorn, Stalwart) or links to (webmail).
 *
 * Each row shows the current value, a "Default: <apex-derived>" hint,
 * and a Reset button that clears the DB row → falls back to the apex
 * default on next load. Changes to the apex (from the Networking
 * section of the main SystemSettingsForm) automatically shift the
 * defaults shown here.
 *
 * Submit is a partial PATCH — only changed fields are sent. Zod on the
 * server enforces https:// (http allowed for localhost) and valid FQDN
 * on the mail hostname.
 */
export default function IntegrationsSettings() {
  const { data: urls, isLoading } = usePlatformUrls();
  const update = useUpdatePlatformUrls();

  const [longhornUrl, setLonghornUrl] = useState('');
  const [stalwartAdminUrl, setStalwartAdminUrl] = useState('');
  const [success, setSuccess] = useState(false);

  // Sync form state with the server state whenever the query resolves.
  // Guarded on `.source === 'db'` so a Reset-click that yields the
  // derived default doesn't loop the user back into "set" mode — the
  // input stays blank, placeholder shows the default.
  useEffect(() => {
    if (!urls) return;
    setLonghornUrl(urls.longhornUrl.source === 'db' ? urls.longhornUrl.value : '');
    setStalwartAdminUrl(urls.stalwartAdminUrl.source === 'db' ? urls.stalwartAdminUrl.value : '');
  }, [urls]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSuccess(false);
    const payload: Record<string, string | null> = {};
    if ((urls?.longhornUrl.source === 'db' ? urls.longhornUrl.value : '') !== longhornUrl) {
      payload.longhornUrl = longhornUrl.trim() === '' ? null : longhornUrl.trim();
    }
    if ((urls?.stalwartAdminUrl.source === 'db' ? urls.stalwartAdminUrl.value : '') !== stalwartAdminUrl) {
      payload.stalwartAdminUrl = stalwartAdminUrl.trim() === '' ? null : stalwartAdminUrl.trim();
    }
    if (Object.keys(payload).length === 0) return;
    try {
      await update.mutateAsync(payload);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2500);
    } catch {
      // error displayed below
    }
  };

  const handleReset = async (field: 'longhornUrl' | 'stalwartAdminUrl') => {
    setSuccess(false);
    try {
      await update.mutateAsync({ [field]: null });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2500);
    } catch {
      // error displayed below
    }
  };

  if (isLoading || !urls) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm">
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading integrations…
        </div>
      </div>
    );
  }

  const inputClass = 'w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500';

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm space-y-5"
      data-testid="integrations-form"
    >
      <div className="flex items-center gap-3">
        <Link2 size={20} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Integrations</h2>
      </div>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        URLs the admin panel uses to embed or link to adjacent services. Leave blank
        to use the apex-derived default shown under each field.
      </p>

      {/* Longhorn */}
      <UrlRow
        id="int-longhorn"
        label="Longhorn Dashboard URL"
        help="Embedded in the Storage Configuration page. Must be reachable from the admin origin."
        value={longhornUrl}
        defaultValue={urls.longhornUrl.default}
        source={urls.longhornUrl.source}
        onChange={setLonghornUrl}
        onReset={() => handleReset('longhornUrl')}
        resetDisabled={urls.longhornUrl.source !== 'db' || update.isPending}
        inputClass={inputClass}
      />

      {/* Stalwart web-admin */}
      <UrlRow
        id="int-stalwart"
        label="Stalwart Web-Admin URL"
        help="Embedded in the Mail Management page. Leave blank on environments where Stalwart is not yet deployed."
        value={stalwartAdminUrl}
        defaultValue={urls.stalwartAdminUrl.default}
        source={urls.stalwartAdminUrl.source}
        onChange={setStalwartAdminUrl}
        onReset={() => handleReset('stalwartAdminUrl')}
        resetDisabled={urls.stalwartAdminUrl.source !== 'db' || update.isPending}
        inputClass={inputClass}
      />

      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={update.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          data-testid="int-save"
        >
          {update.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save
        </button>
        {success && (
          <span className="inline-flex items-center gap-1 text-sm text-green-700 dark:text-green-300">
            <CheckCircle size={14} /> Saved
          </span>
        )}
        {update.error && (
          <span className="inline-flex items-center gap-1 text-sm text-red-700 dark:text-red-300">
            <AlertCircle size={14} />
            {update.error instanceof Error ? update.error.message : 'Update failed'}
          </span>
        )}
      </div>
    </form>
  );
}

interface UrlRowProps {
  readonly id: string;
  readonly label: string;
  readonly help: string;
  readonly value: string;
  readonly defaultValue: string;
  readonly source: 'db' | 'default';
  readonly onChange: (value: string) => void;
  readonly onReset: () => void;
  readonly resetDisabled: boolean;
  readonly inputClass: string;
}

function UrlRow({ id, label, help, value, defaultValue, source, onChange, onReset, resetDisabled, inputClass }: UrlRowProps) {
  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <label htmlFor={id} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
        </label>
        <button
          type="button"
          onClick={onReset}
          disabled={resetDisabled}
          className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-brand-600 dark:hover:text-brand-400 disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid={`${id}-reset`}
        >
          <RotateCcw size={11} /> Reset to default
        </button>
      </div>
      <input
        id={id}
        type="url"
        className={`${inputClass} mt-1`}
        placeholder={defaultValue || 'https://…'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={id}
      />
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {help}
        {defaultValue && (
          <>
            {' '}
            <span className="text-gray-400">Default: <code className="font-mono">{defaultValue}</code></span>
            {source === 'default' && (
              <span className="ml-1 inline-flex items-center rounded bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:text-gray-300">
                using default
              </span>
            )}
          </>
        )}
      </p>
    </div>
  );
}
