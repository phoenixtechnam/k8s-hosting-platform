import { ReactNode } from 'react';
import { Loader2, Pencil, Trash2, Plus } from 'lucide-react';

export interface ProviderRow {
  readonly id: string;
  readonly name: string;
  readonly subtitle?: string;
  readonly consumerCount: number;
  readonly extraCells?: ReactNode;
}

interface Props<T extends ProviderRow> {
  readonly title: string;
  readonly emptyMessage: string;
  readonly rows: ReadonlyArray<T> | undefined;
  readonly isLoading: boolean;
  readonly onCreate: () => void;
  readonly onEdit: (row: T) => void;
  readonly onDelete: (row: T) => void;
  readonly extraColumns?: ReadonlyArray<{ header: string; width?: string }>;
  readonly testIdPrefix: string;
}

/**
 * Generic providers list table used by the OIDC, OpenZiti, and Zrok
 * settings pages. Renders a header row, body rows with consumer-count,
 * and edit/delete action buttons. The Delete button is disabled when
 * `consumerCount > 0` so providers in use cannot be removed.
 */
export default function ProvidersTable<T extends ProviderRow>({
  title,
  emptyMessage,
  rows,
  isLoading,
  onCreate,
  onEdit,
  onDelete,
  extraColumns,
  testIdPrefix,
}: Props<T>) {
  return (
    <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-5 shadow-sm" data-testid={`${testIdPrefix}-section`}>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          data-testid={`${testIdPrefix}-create-btn`}
        >
          <Plus size={14} /> New Provider
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 py-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      )}

      {!isLoading && (!rows || rows.length === 0) && (
        <p className="text-sm text-gray-500 dark:text-gray-400" data-testid={`${testIdPrefix}-empty`}>
          {emptyMessage}
        </p>
      )}

      {!isLoading && rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid={`${testIdPrefix}-table`}>
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                <th className="px-2 py-2">Name</th>
                {(extraColumns ?? []).map((c) => (
                  <th key={c.header} className="px-2 py-2" style={c.width ? { width: c.width } : undefined}>
                    {c.header}
                  </th>
                ))}
                <th className="px-2 py-2">In use</th>
                <th className="px-2 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {rows.map((row) => (
                <tr key={row.id} className="text-gray-900 dark:text-gray-100" data-testid={`${testIdPrefix}-row-${row.id}`}>
                  <td className="px-2 py-2">
                    <div className="font-medium">{row.name}</div>
                    {row.subtitle && (
                      <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-md">{row.subtitle}</div>
                    )}
                  </td>
                  {row.extraCells}
                  <td className="px-2 py-2">
                    <span
                      className={
                        row.consumerCount > 0
                          ? 'inline-flex items-center rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 px-2 py-0.5 text-xs font-medium'
                          : 'text-xs text-gray-500 dark:text-gray-400'
                      }
                    >
                      {row.consumerCount > 0 ? `${row.consumerCount} ingress${row.consumerCount === 1 ? '' : 'es'}` : 'unused'}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right">
                    <div className="inline-flex gap-1">
                      <button
                        type="button"
                        onClick={() => onEdit(row)}
                        className="rounded p-1.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
                        title="Edit"
                        data-testid={`${testIdPrefix}-edit-${row.id}`}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(row)}
                        disabled={row.consumerCount > 0}
                        className="rounded p-1.5 text-gray-500 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-700"
                        title={row.consumerCount > 0 ? 'In use — detach all consumers first' : 'Delete'}
                        data-testid={`${testIdPrefix}-delete-${row.id}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
