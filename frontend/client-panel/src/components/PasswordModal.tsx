import { useState } from 'react';
import { X, Copy, Check, AlertTriangle } from 'lucide-react';

interface PasswordModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly databaseName: string;
  readonly password: string;
}

export default function PasswordModal({ open, onClose, databaseName, password }: PasswordModalProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-testid="password-modal">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-gray-900">
            New Password &mdash; {databaseName}
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
            <div className="flex items-center justify-between">
              <code className="text-sm font-mono text-gray-900 break-all" data-testid="password-modal-value">
                {password}
              </code>
              <button
                onClick={handleCopy}
                className="ml-3 shrink-0 rounded-md p-1.5 text-gray-500 hover:bg-gray-200 hover:text-gray-700"
                aria-label="Copy password"
                data-testid="password-modal-copy"
              >
                {copied ? <Check size={16} className="text-green-600" /> : <Copy size={16} />}
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-600" />
              <p className="text-sm text-amber-700">
                Save this password now. It cannot be retrieved again.
              </p>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
              data-testid="password-modal-close"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
