import { useState } from 'react';
import { Check, Copy, ShieldAlert, X } from 'lucide-react';
import clsx from 'clsx';
import type { PrivateWorkerSecretResponse } from '@k8s-hosting/api-contracts';

interface PrivateWorkerTokenModalProps {
  readonly secret: PrivateWorkerSecretResponse;
  readonly onClose: () => void;
}

type TabId = 'token' | 'docker-run' | 'docker-compose';

interface TabDef {
  readonly id: TabId;
  readonly label: string;
  readonly value: string;
  readonly rows: number;
  readonly textareaTestId: string;
  readonly copyTestId: string;
}

function copyToClipboard(value: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(value).catch(() => fallbackCopy(value));
  }
  fallbackCopy(value);
  return Promise.resolve();
}

function fallbackCopy(value: string): void {
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function useCopyButton(): {
  readonly copied: TabId | null;
  readonly copy: (target: TabId, value: string) => Promise<void>;
} {
  const [copied, setCopied] = useState<TabId | null>(null);

  const copy = async (target: TabId, value: string): Promise<void> => {
    await copyToClipboard(value);
    setCopied(target);
    setTimeout(
      () => setCopied((c) => (c === target ? null : c)),
      2000,
    );
  };

  return { copied, copy };
}

/**
 * One-time token reveal modal. The full base64url token is the only
 * credential the home agent ever sees and is never re-shown by any
 * other endpoint — so this dialog is the user's single chance to
 * capture it.
 */
export default function PrivateWorkerTokenModal({
  secret,
  onClose,
}: PrivateWorkerTokenModalProps) {
  const { copied, copy } = useCopyButton();
  const [tab, setTab] = useState<TabId>('token');
  const [confirmDismiss, setConfirmDismiss] = useState(false);

  const tabs: readonly TabDef[] = [
    {
      id: 'token',
      label: 'Token',
      value: secret.token,
      rows: 3,
      textareaTestId: 'pw-token-textarea',
      copyTestId: 'copy-pw-token',
    },
    {
      id: 'docker-run',
      label: 'docker run',
      value: secret.dockerRunCommand,
      rows: 4,
      textareaTestId: 'pw-docker-run',
      copyTestId: 'copy-pw-docker-run',
    },
    {
      id: 'docker-compose',
      label: 'docker-compose.yml',
      value: secret.dockerComposeYaml,
      rows: 8,
      textareaTestId: 'pw-docker-compose',
      copyTestId: 'copy-pw-docker-compose',
    },
  ];

  const active = tabs.find((t) => t.id === tab) ?? tabs[0];

  const handleClose = (): void => {
    if (confirmDismiss) {
      onClose();
      return;
    }
    setConfirmDismiss(true);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pw-token-title"
      data-testid="private-worker-token-modal"
    >
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-2xl w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between">
          <h3
            id="pw-token-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            Private worker token
          </h3>
          <button
            type="button"
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            aria-label="Close"
            data-testid="pw-token-close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Save-now banner — strong, red, with shield icon */}
        <div
          className="flex items-start gap-3 rounded-lg border-2 border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-900/40 p-4 text-sm text-red-900 dark:text-red-200"
          data-testid="pw-token-save-warning"
        >
          <ShieldAlert size={20} className="mt-0.5 shrink-0 text-red-600 dark:text-red-400" />
          <div className="space-y-1">
            <p className="font-semibold">Save this token now — it will never be shown again.</p>
            <p className="text-xs text-red-800 dark:text-red-300">
              The token is only ever shown here. Copy it into a secrets store
              (1Password, Bitwarden, your vault) before you close this dialog.
              If you lose it, rotate the worker to mint a new one.
            </p>
          </div>
        </div>

        {/* Worker meta */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 text-sm">
          <div>
            <span className="text-xs text-gray-500 dark:text-gray-400">Name</span>
            <div className="text-gray-900 dark:text-gray-100">{secret.worker.name}</div>
          </div>
          <div>
            <span className="text-xs text-gray-500 dark:text-gray-400">Slug</span>
            <div className="font-mono text-gray-900 dark:text-gray-100 break-all">
              {secret.worker.slug}
            </div>
          </div>
          <div>
            <span className="text-xs text-gray-500 dark:text-gray-400">Cluster routing port</span>
            <div className="font-mono text-gray-900 dark:text-gray-100">
              {secret.worker.exposedPort}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div
          role="tablist"
          aria-label="Token and snippets"
          className="flex border-b border-gray-200 dark:border-gray-700"
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`pw-tabpanel-${t.id}`}
              id={`pw-tab-${t.id}`}
              onClick={() => setTab(t.id)}
              data-testid={`pw-tab-${t.id}`}
              className={clsx(
                '-mb-px px-3 py-2 text-sm font-medium border-b-2 transition-colors',
                tab === t.id
                  ? 'border-brand-500 text-brand-600 dark:text-brand-400'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Active tab panel */}
        <div
          role="tabpanel"
          id={`pw-tabpanel-${active.id}`}
          aria-labelledby={`pw-tab-${active.id}`}
        >
          <div className="flex items-center justify-between mb-1">
            <label
              htmlFor={active.textareaTestId}
              className="block text-xs font-medium text-gray-600 dark:text-gray-400"
            >
              {active.label}
            </label>
            <button
              type="button"
              onClick={() => copy(active.id, active.value)}
              className={clsx(
                'inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors',
                copied === active.id
                  ? 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/30'
                  : 'text-brand-600 dark:text-brand-400 hover:bg-brand-50 dark:hover:bg-brand-900/30',
              )}
              data-testid={active.copyTestId}
            >
              {copied === active.id ? <Check size={12} /> : <Copy size={12} />}
              {copied === active.id ? 'Copied ✓' : `Copy ${active.label}`}
            </button>
          </div>
          <textarea
            id={active.textareaTestId}
            data-testid={active.textareaTestId}
            readOnly
            value={active.value}
            rows={active.rows}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 px-3 py-2 font-mono text-xs text-gray-900 dark:text-gray-100 break-all"
            style={{ wordBreak: 'break-all' }}
          />
        </div>

        {/* What now? footer */}
        <div className="rounded-lg bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 p-4 text-sm text-gray-700 dark:text-gray-300">
          <p className="font-semibold text-gray-900 dark:text-gray-100 mb-2">What now?</p>
          <ol className="list-decimal pl-5 space-y-1 text-xs">
            <li>
              Start a service on your machine on whatever port suits you (e.g.{' '}
              <code className="rounded bg-gray-200 dark:bg-gray-700 px-1 py-0.5 font-mono">
                8080
              </code>
              ).
            </li>
            <li>
              In the docker-compose snippet, set{' '}
              <code className="rounded bg-gray-200 dark:bg-gray-700 px-1 py-0.5 font-mono">
                PRIVATE_WORKER_TARGET
              </code>
              {' '}to where that service is reachable from the agent (e.g.{' '}
              <code className="rounded bg-gray-200 dark:bg-gray-700 px-1 py-0.5 font-mono">
                host.docker.internal:8080
              </code>
              ).
            </li>
            <li>
              Paste the docker-compose snippet into a directory and run{' '}
              <code className="rounded bg-gray-200 dark:bg-gray-700 px-1 py-0.5 font-mono">
                docker compose up -d
              </code>
              .
            </li>
            <li>
              Create an Ingress route in <strong>Domains → Routes</strong>{' '}
              pointing at this private worker.
            </li>
          </ol>
        </div>

        {/* Dismiss-confirmation footer */}
        {confirmDismiss && (
          <div
            className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 p-3 text-sm text-amber-900 dark:text-amber-200"
            data-testid="pw-token-dismiss-confirm"
          >
            <p className="font-medium">
              Have you saved the token? It cannot be recovered.
            </p>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDismiss(false)}
                className="rounded-lg border border-amber-300 dark:border-amber-700 px-3 py-1.5 text-xs font-medium text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/50"
                data-testid="pw-token-dismiss-cancel"
              >
                Keep it open
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
                data-testid="pw-token-dismiss-confirm-btn"
              >
                Yes, close
              </button>
            </div>
          </div>
        )}

        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={handleClose}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
            data-testid="pw-token-done"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
