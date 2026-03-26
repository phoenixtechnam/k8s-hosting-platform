import { useState } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';

interface DeleteConfirmDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<void>;
  readonly clientName: string;
  readonly isPending: boolean;
}

export default function DeleteConfirmDialog({
  open,
  onClose,
  onConfirm,
  clientName,
  isPending,
}: DeleteConfirmDialogProps) {
  const [errorMessage, setErrorMessage] = useState('');

  if (!open) return null;

  const handleConfirm = async () => {
    setErrorMessage('');
    try {
      await onConfirm();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Failed to delete client. Please try again.',
      );
    }
  };

  const handleClose = () => {
    if (isPending) return;
    setErrorMessage('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-testid="delete-confirm-dialog">
      <div className="fixed inset-0 bg-black/50" onClick={handleClose} />
      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100">
            <AlertTriangle size={20} className="text-red-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Delete Client</h2>
            <p className="mt-2 text-sm text-gray-600" data-testid="delete-warning-text">
              Are you sure you want to delete <strong>{clientName}</strong>? This cannot be undone.
            </p>
          </div>
        </div>

        {errorMessage && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3" data-testid="delete-error">
            <p className="text-sm text-red-700">{errorMessage}</p>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={handleClose}
            disabled={isPending}
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            data-testid="delete-cancel-button"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            data-testid="delete-confirm-button"
          >
            {isPending && <Loader2 size={14} className="animate-spin" />}
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
