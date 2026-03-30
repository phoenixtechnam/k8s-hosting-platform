import { useState, useEffect } from 'react';
import {
  FolderOpen, File, ChevronRight, ArrowLeft, Plus, Trash2, Edit3,
  Download, FolderPlus, Loader2, RefreshCw, Home, X, Save, AlertTriangle,
} from 'lucide-react';
import {
  useFileManagerStatus, useStartFileManager, useDirectoryListing,
  useFileContent, useCreateDirectory, useWriteFile, useRenameFile,
  useDeleteFile, useDownloadUrl,
} from '@/hooks/use-file-manager';
import type { FileEntry } from '@/hooks/use-file-manager';

// ─── File extension → Monaco language mapping ────────────────────────────────

const LANG_MAP: Record<string, string> = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.json': 'json', '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.php': 'php', '.py': 'python', '.rb': 'ruby',
  '.yaml': 'yaml', '.yml': 'yaml', '.xml': 'xml',
  '.md': 'markdown', '.sh': 'shell', '.bash': 'shell',
  '.sql': 'sql', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'cpp',
  '.env': 'ini', '.ini': 'ini', '.toml': 'ini',
  '.dockerfile': 'dockerfile',
};

function getLanguage(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  const ext = '.' + lower.split('.').pop();
  return LANG_MAP[ext] ?? 'plaintext';
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function Files() {
  const [currentPath, setCurrentPath] = useState('/');
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [newDirOpen, setNewDirOpen] = useState(false);
  const [newDirName, setNewDirName] = useState('');
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameName, setRenameName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const fmStatus = useFileManagerStatus();
  const startFm = useStartFileManager();
  const dirListing = useDirectoryListing(currentPath, fmStatus.data?.ready === true);
  const createDir = useCreateDirectory();
  const renameFile = useRenameFile();
  const deleteFile = useDeleteFile();

  // Auto-start file manager when page opens
  useEffect(() => {
    if (fmStatus.data && fmStatus.data.phase === 'not_deployed' && !startFm.isPending) {
      startFm.mutate();
    }
  }, [fmStatus.data?.phase]);

  // ─── Loading / Starting state ────────────────────────────────────────────

  if (!fmStatus.data || fmStatus.data.phase === 'not_deployed' || fmStatus.data.phase === 'starting') {
    return (
      <div className="space-y-6">
        <FilePageHeader />
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
          <div className="px-6 py-16 text-center">
            <Loader2 size={48} className="mx-auto animate-spin text-brand-500" />
            <h2 className="mt-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
              Starting File Manager
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-gray-500 dark:text-gray-400">
              Deploying file manager to your namespace. This usually takes 10-30 seconds...
            </p>
            <div className="mx-auto mt-6 h-2 w-64 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden">
              <div className="h-2 rounded-full bg-brand-500 animate-pulse" style={{ width: '60%' }} />
            </div>
            <p className="mt-3 text-xs text-gray-400 dark:text-gray-500">
              {fmStatus.data?.message ?? 'Waiting for pod to start...'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (fmStatus.data.phase === 'failed') {
    return (
      <div className="space-y-6">
        <FilePageHeader />
        <div className="rounded-xl border border-red-200 dark:border-red-800 bg-white dark:bg-gray-800 shadow-sm">
          <div className="px-6 py-16 text-center">
            <AlertTriangle size={48} className="mx-auto text-red-400" />
            <h2 className="mt-4 text-lg font-semibold text-gray-900 dark:text-gray-100">File Manager Failed</h2>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{fmStatus.data.message}</p>
            <button onClick={() => startFm.mutate()} className="mt-4 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600">
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Editor view ─────────────────────────────────────────────────────────

  if (editingFile) {
    return (
      <div className="space-y-4">
        <FilePageHeader />
        <FileEditor path={editingFile} onClose={() => setEditingFile(null)} />
      </div>
    );
  }

  // ─── File browser view ───────────────────────────────────────────────────

  const pathParts = currentPath.split('/').filter(Boolean);

  return (
    <div className="space-y-4">
      <FilePageHeader />

      {/* Breadcrumbs + Actions */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1 text-sm overflow-x-auto">
          <button onClick={() => setCurrentPath('/')} className="flex items-center gap-1 text-gray-500 hover:text-brand-600 dark:text-gray-400 dark:hover:text-brand-400">
            <Home size={14} />
          </button>
          {pathParts.map((part, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight size={12} className="text-gray-300 dark:text-gray-600" />
              <button
                onClick={() => setCurrentPath('/' + pathParts.slice(0, i + 1).join('/'))}
                className="text-gray-600 hover:text-brand-600 dark:text-gray-300 dark:hover:text-brand-400"
              >
                {part}
              </button>
            </span>
          ))}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => dirListing.refetch()}
            className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={() => { setNewDirOpen(true); setNewDirName(''); }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600"
          >
            <FolderPlus size={14} />
            New Folder
          </button>
        </div>
      </div>

      {/* New directory input */}
      {newDirOpen && (
        <div className="flex items-center gap-2 rounded-lg border border-brand-200 dark:border-brand-800 bg-brand-50 dark:bg-brand-900/20 p-3">
          <FolderPlus size={16} className="text-brand-500" />
          <input
            type="text"
            value={newDirName}
            onChange={(e) => setNewDirName(e.target.value)}
            placeholder="Folder name"
            className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newDirName.trim()) {
                const fullPath = currentPath === '/' ? `/${newDirName}` : `${currentPath}/${newDirName}`;
                createDir.mutate(fullPath, { onSuccess: () => { setNewDirOpen(false); } });
              }
              if (e.key === 'Escape') setNewDirOpen(false);
            }}
          />
          <button
            onClick={() => {
              if (newDirName.trim()) {
                const fullPath = currentPath === '/' ? `/${newDirName}` : `${currentPath}/${newDirName}`;
                createDir.mutate(fullPath, { onSuccess: () => { setNewDirOpen(false); } });
              }
            }}
            disabled={!newDirName.trim() || createDir.isPending}
            className="rounded bg-brand-500 px-3 py-1 text-xs text-white hover:bg-brand-600 disabled:opacity-50"
          >
            Create
          </button>
          <button onClick={() => setNewDirOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X size={14} />
          </button>
        </div>
      )}

      {/* File list */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm overflow-hidden">
        {dirListing.isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin text-gray-400" />
          </div>
        )}

        {dirListing.error && (
          <div className="px-6 py-8 text-center text-sm text-red-600 dark:text-red-400">
            {dirListing.error instanceof Error ? dirListing.error.message : 'Failed to load files'}
          </div>
        )}

        {dirListing.data && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 text-left text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3 w-24">Size</th>
                <th className="px-4 py-3 w-40 hidden sm:table-cell">Modified</th>
                <th className="px-4 py-3 w-32 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {/* Parent directory */}
              {currentPath !== '/' && (
                <tr
                  className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 cursor-pointer"
                  onClick={() => {
                    const parts = currentPath.split('/').filter(Boolean);
                    parts.pop();
                    setCurrentPath('/' + parts.join('/'));
                  }}
                >
                  <td className="px-4 py-2.5 flex items-center gap-2">
                    <ArrowLeft size={14} className="text-gray-400" />
                    <span className="text-gray-500 dark:text-gray-400">..</span>
                  </td>
                  <td /><td className="hidden sm:table-cell" /><td />
                </tr>
              )}

              {dirListing.data.entries.map((entry) => (
                <FileRow
                  key={entry.name}
                  entry={entry}
                  currentPath={currentPath}
                  onNavigate={(path) => setCurrentPath(path)}
                  onEdit={(path) => setEditingFile(path)}
                  onRename={(name) => { setRenameTarget(name); setRenameName(name); }}
                  onDelete={(name) => setDeleteTarget(name)}
                />
              ))}

              {dirListing.data.entries.length === 0 && currentPath === '/' && (
                <tr>
                  <td colSpan={4} className="px-4 py-12 text-center text-gray-400 dark:text-gray-500">
                    <FolderOpen size={32} className="mx-auto mb-2" />
                    Empty directory
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Rename dialog */}
      {renameTarget && (
        <SimpleDialog
          title="Rename"
          onClose={() => setRenameTarget(null)}
          onConfirm={() => {
            const oldPath = currentPath === '/' ? `/${renameTarget}` : `${currentPath}/${renameTarget}`;
            const newPath = currentPath === '/' ? `/${renameName}` : `${currentPath}/${renameName}`;
            renameFile.mutate({ oldPath, newPath }, { onSuccess: () => setRenameTarget(null) });
          }}
          isPending={renameFile.isPending}
          confirmLabel="Rename"
        >
          <input
            type="text"
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            autoFocus
          />
        </SimpleDialog>
      )}

      {/* Delete dialog */}
      {deleteTarget && (
        <SimpleDialog
          title="Delete"
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => {
            const path = currentPath === '/' ? `/${deleteTarget}` : `${currentPath}/${deleteTarget}`;
            deleteFile.mutate(path, { onSuccess: () => setDeleteTarget(null) });
          }}
          isPending={deleteFile.isPending}
          confirmLabel="Delete"
          destructive
        >
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Are you sure you want to delete <strong className="text-gray-900 dark:text-gray-100">{deleteTarget}</strong>? This cannot be undone.
          </p>
        </SimpleDialog>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function FilePageHeader() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400">
        <FolderOpen size={20} />
      </div>
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="files-heading">Files</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">Manage your website files and directories.</p>
      </div>
    </div>
  );
}

function FileRow({
  entry, currentPath, onNavigate, onEdit, onRename, onDelete,
}: {
  readonly entry: FileEntry;
  readonly currentPath: string;
  readonly onNavigate: (path: string) => void;
  readonly onEdit: (path: string) => void;
  readonly onRename: (name: string) => void;
  readonly onDelete: (name: string) => void;
}) {
  const fullPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
  const downloadUrl = useDownloadUrl(fullPath);
  const isDir = entry.type === 'directory';
  const isEditable = !isDir && entry.size < 10 * 1024 * 1024; // <10MB

  return (
    <tr className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 group">
      <td className="px-4 py-2.5">
        <button
          onClick={() => isDir ? onNavigate(fullPath) : (isEditable ? onEdit(fullPath) : undefined)}
          className="flex items-center gap-2 text-left"
        >
          {isDir
            ? <FolderOpen size={16} className="text-amber-500 dark:text-amber-400 shrink-0" />
            : <File size={16} className="text-gray-400 dark:text-gray-500 shrink-0" />
          }
          <span className={isDir ? 'font-medium text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300'}>
            {entry.name}
          </span>
        </button>
      </td>
      <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-gray-400">
        {isDir ? '-' : formatSize(entry.size)}
      </td>
      <td className="px-4 py-2.5 text-xs text-gray-500 dark:text-gray-400 hidden sm:table-cell">
        {entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : '-'}
      </td>
      <td className="px-4 py-2.5 text-right">
        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {isEditable && (
            <button onClick={() => onEdit(fullPath)} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-brand-600 dark:hover:bg-gray-700" title="Edit">
              <Edit3 size={14} />
            </button>
          )}
          {!isDir && (
            <a href={downloadUrl} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-brand-600 dark:hover:bg-gray-700" title="Download" target="_blank" rel="noreferrer">
              <Download size={14} />
            </a>
          )}
          <button onClick={() => onRename(entry.name)} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-brand-600 dark:hover:bg-gray-700" title="Rename">
            <Edit3 size={14} />
          </button>
          <button onClick={() => onDelete(entry.name)} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-red-600 dark:hover:bg-gray-700" title="Delete">
            <Trash2 size={14} />
          </button>
        </div>
      </td>
    </tr>
  );
}

function FileEditor({ path, onClose }: { readonly path: string; readonly onClose: () => void }) {
  const fileContent = useFileContent(path);
  const writeFile = useWriteFile();
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (fileContent.data) {
      setContent(fileContent.data.content);
      setDirty(false);
    }
  }, [fileContent.data]);

  const filename = path.split('/').pop() ?? '';
  const language = getLanguage(filename);

  const handleSave = () => {
    writeFile.mutate({ path, content }, {
      onSuccess: () => setDirty(false),
    });
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm overflow-hidden">
      {/* Editor header */}
      <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-4 py-2">
        <div className="flex items-center gap-2">
          <File size={14} className="text-gray-400" />
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{path}</span>
          {dirty && <span className="text-xs text-amber-500">Modified</span>}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">{language}</span>
          <button
            onClick={handleSave}
            disabled={!dirty || writeFile.isPending}
            className="inline-flex items-center gap-1 rounded-lg bg-brand-500 px-3 py-1 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {writeFile.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            Save
          </button>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Editor body */}
      {fileContent.isLoading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-gray-400" />
        </div>
      )}

      {fileContent.data && (
        <textarea
          value={content}
          onChange={(e) => { setContent(e.target.value); setDirty(true); }}
          className="w-full h-[500px] px-4 py-3 font-mono text-sm text-gray-800 dark:text-gray-200 bg-gray-50 dark:bg-gray-900 border-0 focus:outline-none resize-none"
          spellCheck={false}
        />
      )}
    </div>
  );
}

function SimpleDialog({
  title, onClose, onConfirm, isPending, confirmLabel, destructive, children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
  readonly isPending: boolean;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">{title}</h3>
        {children}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isPending}
            className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
              destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-brand-500 hover:bg-brand-600'
            }`}
          >
            {isPending && <Loader2 size={14} className="animate-spin inline mr-1" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
