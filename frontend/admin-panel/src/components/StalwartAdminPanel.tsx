import { useState } from 'react';
import {
  Server,
  Eye,
  EyeOff,
  Copy,
  Check,
  ExternalLink,
  RefreshCw,
  Loader2,
  AlertTriangle,
  X,
} from 'lucide-react';
import { useStalwartCredentials, useRotateStalwartPassword } from '@/hooks/use-stalwart';
import { config } from '@/lib/runtime-config';

/**
 * Admin panel controls for the Stalwart mail-server.
 *
 *  • SHOW STALWART CREDENTIALS — reveals username + password (click to copy)
 *  • OPEN STALWART             — opens the Stalwart web-admin in a modal
 *                                iframe served same-origin via nginx proxy
 *                                (no public ingress route)
 *  • ROTATE PASSWORD           — confirmation modal → rotate endpoint
 *                                (warns that Stalwart + platform-api restart)
 */
export default function StalwartAdminPanel() {
  const [revealed, setRevealed] = useState(false);
  const [showIframe, setShowIframe] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);

  const creds = useStalwartCredentials(revealed);
  const rotate = useRotateStalwartPassword();

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm p-5 space-y-4">
      <div className="flex items-center gap-3">
        <Server size={20} className="text-gray-700 dark:text-gray-300" />
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Stalwart Mail Server</h2>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400">
        Manage the Stalwart mail server via its built-in admin UI. The UI is
        not exposed publicly — it is served through the admin panel origin,
        so only authenticated platform admins can reach it.
      </p>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          data-testid="stalwart-show-credentials"
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-sm hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
          {revealed ? 'Hide credentials' : 'Show Stalwart credentials'}
        </button>

        <button
          type="button"
          onClick={() => setShowIframe(true)}
          data-testid="stalwart-open"
          className="inline-flex items-center gap-2 rounded-lg border border-brand-500 bg-brand-500 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-600"
        >
          <ExternalLink size={14} /> Open Stalwart
        </button>

        <button
          type="button"
          onClick={() => setConfirmRotate(true)}
          data-testid="stalwart-rotate"
          className="inline-flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/30 dark:border-amber-700 px-3 py-2 text-sm font-medium text-amber-800 dark:text-amber-200 shadow-sm hover:bg-amber-100 dark:hover:bg-amber-900/50"
        >
          <RefreshCw size={14} /> Rotate password
        </button>
      </div>

      {revealed && (
        <CredentialsReveal
          loading={creds.isLoading}
          error={creds.error}
          username={creds.data?.data.username}
          password={creds.data?.data.password}
        />
      )}

      {showIframe && <StalwartIframeModal onClose={() => setShowIframe(false)} />}

      {confirmRotate && (
        <RotateConfirmModal
          pending={rotate.isPending}
          error={rotate.error}
          onClose={() => {
            if (!rotate.isPending) {
              setConfirmRotate(false);
              rotate.reset();
            }
          }}
          onConfirm={async () => {
            try {
              await rotate.mutateAsync();
              setConfirmRotate(false);
              rotate.reset();
              setRevealed(true);
              // If the Stalwart iframe was open, close it — its cached
              // SPA state references the old token and will not pick up
              // the rotated password without a clean reload.
              setShowIframe(false);
            } catch {
              // error state is surfaced via rotate.error
            }
          }}
        />
      )}
    </div>
  );
}

interface CredentialsRevealProps {
  readonly loading: boolean;
  readonly error: unknown;
  readonly username: string | undefined;
  readonly password: string | undefined;
}

function CredentialsReveal({ loading, error, username, password }: CredentialsRevealProps) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <Loader2 size={14} className="animate-spin" /> Loading credentials…
      </div>
    );
  }
  if (error || !username || !password) {
    return (
      <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-700 dark:text-red-300">
        Could not load Stalwart credentials. Check that STALWART_ADMIN_PASSWORD (or ADMIN_SECRET_PLAIN) is configured on the platform.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 space-y-2">
      <CopyableField label="Username" value={username} testId="stalwart-username" />
      <CopyableField label="Password" value={password} testId="stalwart-password" mono />
    </div>
  );
}

interface CopyableFieldProps {
  readonly label: string;
  readonly value: string;
  readonly testId: string;
  readonly mono?: boolean;
}

function CopyableField({ label, value, testId, mono }: CopyableFieldProps) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API can fail on non-secure contexts — ignore silently
    }
  };
  return (
    <div className="flex items-center gap-3" data-testid={`${testId}-row`}>
      <span className="w-24 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">{label}</span>
      <code
        data-testid={testId}
        className={`flex-1 rounded bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-2 py-1 text-sm text-gray-800 dark:text-gray-200 ${mono ? 'font-mono' : ''} select-all`}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        data-testid={`${testId}-copy`}
        className="inline-flex items-center gap-1 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700"
      >
        {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function StalwartIframeModal({ onClose }: { readonly onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      data-testid="stalwart-iframe-modal"
    >
      <div className="relative w-full max-w-[1400px] h-[90vh] bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
            <Server size={14} /> Stalwart Web Admin
          </div>
          <button
            type="button"
            onClick={onClose}
            data-testid="stalwart-iframe-close"
            className="rounded-md p-1 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700"
          >
            <X size={18} />
          </button>
        </div>
        <iframe
          // Dedicated subdomain gated by ingress auth_request — the
          // browser's platform_session cookie (Domain=.<apex>) authenticates
          // the whole SPA traffic, including WebSocket upgrades for live
          // metrics. First open still shows Stalwart's own login screen;
          // paste the credentials from "Show Stalwart credentials". Stalwart
          // stores its own token in localStorage under THIS origin, so
          // subsequent opens skip login until the token expires.
          src={config.STALWART_ADMIN_URL || '/__stalwart/'}
          title="Stalwart Web Admin"
          className="flex-1 w-full border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          data-testid="stalwart-iframe"
        />
      </div>
    </div>
  );
}

interface RotateConfirmModalProps {
  readonly pending: boolean;
  readonly error: unknown;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<void>;
}

function RotateConfirmModal({ pending, error, onClose, onConfirm }: RotateConfirmModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      data-testid="stalwart-rotate-modal"
    >
      <div className="relative w-full max-w-md bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="shrink-0 rounded-full bg-amber-100 dark:bg-amber-900/30 p-2">
            <AlertTriangle size={20} className="text-amber-600" />
          </div>
          <div className="flex-1">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Rotate Stalwart admin password?
            </h3>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              This generates a new random password, writes it to the{' '}
              <code className="rounded bg-gray-100 dark:bg-gray-800 px-1">stalwart-secrets</code>{' '}
              Kubernetes Secret, and then <strong>restarts</strong>:
            </p>
            <ul className="mt-2 list-disc pl-5 text-sm text-gray-600 dark:text-gray-400 space-y-0.5">
              <li><code className="text-xs">stalwart-mail</code> StatefulSet (brief SMTP/IMAP outage)</li>
              <li><code className="text-xs">platform-api</code> Deployment (brief admin-panel API brownout)</li>
            </ul>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              The new password will be shown after rotation succeeds.
            </p>
          </div>
        </div>

        {error ? (
          <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            {error instanceof Error ? error.message : 'Rotation failed — see server logs.'}
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            data-testid="stalwart-rotate-confirm"
            className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-700 disabled:opacity-50"
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            {pending ? 'Rotating…' : 'Rotate password'}
          </button>
        </div>
      </div>
    </div>
  );
}
