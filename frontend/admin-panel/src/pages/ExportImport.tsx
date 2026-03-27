import { useState, useRef } from 'react';
import { Download, Upload, Loader2, AlertCircle, CheckCircle } from 'lucide-react';
import { useExport, useImport } from '@/hooks/use-export-import';

export default function ExportImport() {
  const exportMut = useExport();
  const importMut = useImport();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importData, setImportData] = useState<Record<string, unknown> | null>(null);
  const [fileName, setFileName] = useState<string>('');

  const handleExport = async () => {
    try {
      const result = await exportMut.mutateAsync();
      const json = JSON.stringify(result.data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `platform-export-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* error shown via exportMut.error */ }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        setImportData(parsed);
      } catch {
        setImportData(null);
      }
    };
    reader.readAsText(file);
  };

  const handleImport = async (dryRun: boolean) => {
    if (!importData) return;
    try {
      await importMut.mutateAsync({ data: importData, dryRun });
    } catch { /* error shown via importMut.error */ }
  };

  const importResult = importMut.data?.data;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900" data-testid="export-import-heading">Export / Import</h1>

      {/* Export Section */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-3 mb-3">
          <Download size={20} className="text-green-600" />
          <h2 className="text-lg font-semibold text-gray-900">Export</h2>
        </div>
        <p className="text-sm text-gray-500 mb-4">Download all clients, domains, plans, and DNS servers as a JSON file.</p>
        <button
          type="button"
          onClick={handleExport}
          disabled={exportMut.isPending}
          className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          data-testid="export-button"
        >
          {exportMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          Export Data
        </button>
        {exportMut.error && (
          <div className="mt-2 flex items-center gap-2 text-sm text-red-600"><AlertCircle size={14} />{exportMut.error instanceof Error ? exportMut.error.message : 'Export failed'}</div>
        )}
      </div>

      {/* Import Section */}
      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-3 mb-3">
          <Upload size={20} className="text-blue-600" />
          <h2 className="text-lg font-semibold text-gray-900">Import</h2>
        </div>
        <p className="text-sm text-gray-500 mb-4">Upload a previously exported JSON file to restore or migrate data.</p>

        <div className="mb-4">
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            onChange={handleFileChange}
            className="hidden"
            data-testid="import-file-input"
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            data-testid="import-file-button"
          >
            <Upload size={14} />
            {fileName || 'Choose File'}
          </button>
        </div>

        {importData && (
          <div className="space-y-3">
            <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
              <p>Version: {(importData as Record<string, unknown>).version as string ?? 'unknown'}</p>
              <p>Clients: {((importData as Record<string, unknown>).clients as unknown[])?.length ?? 0}</p>
              <p>Domains: {((importData as Record<string, unknown>).domains as unknown[])?.length ?? 0}</p>
              <p>Plans: {((importData as Record<string, unknown>).hostingPlans as unknown[])?.length ?? 0}</p>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleImport(true)}
                disabled={importMut.isPending}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                data-testid="import-dry-run"
              >
                {importMut.isPending && <Loader2 size={14} className="animate-spin" />}
                Dry Run (Preview)
              </button>
              <button
                type="button"
                onClick={() => handleImport(false)}
                disabled={importMut.isPending}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                data-testid="import-execute"
              >
                {importMut.isPending && <Loader2 size={14} className="animate-spin" />}
                Import Data
              </button>
            </div>
          </div>
        )}

        {importResult && (
          <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4" data-testid="import-result">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle size={16} className="text-green-500" />
              <span className="font-medium text-gray-900">{importResult.dryRun ? 'Dry Run Result' : 'Import Complete'}</span>
            </div>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div><span className="text-green-600 font-medium">{importResult.created}</span> <span className="text-gray-500">created</span></div>
              <div><span className="text-blue-600 font-medium">{importResult.updated}</span> <span className="text-gray-500">updated</span></div>
              <div><span className="text-gray-600 font-medium">{importResult.skipped}</span> <span className="text-gray-500">skipped</span></div>
            </div>
            {importResult.errors.length > 0 && (
              <div className="mt-2 text-xs text-red-600">
                {importResult.errors.map((e, i) => (
                  <p key={i}>{e.resource} {e.id}: {e.error}</p>
                ))}
              </div>
            )}
          </div>
        )}

        {importMut.error && (
          <div className="mt-2 flex items-center gap-2 text-sm text-red-600"><AlertCircle size={14} />{importMut.error instanceof Error ? importMut.error.message : 'Import failed'}</div>
        )}
      </div>
    </div>
  );
}
