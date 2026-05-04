import { useState } from 'react';
import { AlertTriangle, Check, Copy, X } from 'lucide-react';
import type { PrivateWorkerSecretResponse } from '@k8s-hosting/api-contracts';

interface PrivateWorkerTokenModalProps {
  readonly secret: PrivateWorkerSecretResponse;
  readonly onClose: () => void;
}

type CopyTarget = 'token' | 'docker-run' | 'docker-compose';

function useCopyButton() {
  const [copied, setCopied] = useState<CopyTarget | null>(null);

  const copy = async (target: CopyTarget, value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Fallback for non-HTTPS dev origins.
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopied(target);
    setTimeout(() => setCopied((c) => (c === target ? null : c)), 2000);
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pw-token-title"
      data-testid="private-worker-token-modal"
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-2xl w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between">
          <h3
            id="pw-token-title"
            className="text-lg font-semibold text-gray-900 dark:text-gray-100"
          >
            Private worker token
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Save-now banner */}
        <div className="flex items-start gap-2 rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/30 p-3 text-sm text-red-800 dark:text-red-300">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <p className="font-medium">
            Save this token now — it will never be shown again. If you lose
            it, rotate the worker to mint a new one.
          </p>
        </div>

        {/* Worker meta — name + slug */}
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
            <span className="text-xs text-gray-500 dark:text-gray-400">Exposed port</span>
            <div className="font-mono text-gray-900 dark:text-gray-100">
              {secret.worker.exposedPort}
            </div>
          </div>
        </div>

        {/* Token */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label
              htmlFor="pw-token-textarea"
              className="block text-xs font-medium text-gray-600 dark:text-gray-400"
            >
              Token
            </label>
            <button
              type="button"
              onClick={() => copy('token', secret.token)}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-900/30"
              data-testid="copy-pw-token"
            >
              {copied === 'token' ? <Check size={12} /> : <Copy size={12} />}
              {copied === 'token' ? 'Copied' : 'Copy token'}
            </button>
          </div>
          <textarea
            id="pw-token-textarea"
            readOnly
            value={secret.token}
            rows={3}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 px-3 py-2 font-mono text-xs text-gray-900 dark:text-gray-100 break-all"
            style={{ wordBreak: 'break-all' }}
          />
        </div>

        {/* docker run */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label
              htmlFor="pw-docker-run"
              className="block text-xs font-medium text-gray-600 dark:text-gray-400"
            >
              docker run
            </label>
            <button
              type="button"
              onClick={() => copy('docker-run', secret.dockerRunCommand)}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-900/30"
              data-testid="copy-pw-docker-run"
            >
              {copied === 'docker-run' ? <Check size={12} /> : <Copy size={12} />}
              {copied === 'docker-run' ? 'Copied' : 'Copy docker run command'}
            </button>
          </div>
          <textarea
            id="pw-docker-run"
            readOnly
            value={secret.dockerRunCommand}
            rows={3}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 px-3 py-2 font-mono text-xs text-gray-900 dark:text-gray-100"
          />
        </div>

        {/* docker-compose */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label
              htmlFor="pw-docker-compose"
              className="block text-xs font-medium text-gray-600 dark:text-gray-400"
            >
              docker-compose.yml
            </label>
            <button
              type="button"
              onClick={() => copy('docker-compose', secret.dockerComposeYaml)}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-brand-600 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-900/30"
              data-testid="copy-pw-docker-compose"
            >
              {copied === 'docker-compose' ? <Check size={12} /> : <Copy size={12} />}
              {copied === 'docker-compose' ? 'Copied' : 'Copy docker-compose.yml'}
            </button>
          </div>
          <textarea
            id="pw-docker-compose"
            readOnly
            value={secret.dockerComposeYaml}
            rows={6}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900 px-3 py-2 font-mono text-xs text-gray-900 dark:text-gray-100"
          />
        </div>

        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
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
