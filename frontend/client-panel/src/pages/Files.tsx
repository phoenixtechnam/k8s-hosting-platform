/* eslint-disable @typescript-eslint/no-explicit-any */
// Webkit File System API types (non-standard, used for folder drag & drop)
interface FileSystemEntry { readonly isFile: boolean; readonly isDirectory: boolean; readonly name: string; }
interface FileSystemFileEntry extends FileSystemEntry { file(cb: (f: File) => void, err?: () => void): void; }
interface FileSystemDirectoryEntry extends FileSystemEntry { createReader(): FileSystemDirectoryReader; }
interface FileSystemDirectoryReader { readEntries(cb: (entries: FileSystemEntry[]) => void, err?: () => void): void; }
/* eslint-enable @typescript-eslint/no-explicit-any */

import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FolderOpen, File, FilePlus, ChevronRight, ArrowLeft, Trash2, Edit3,
  Download, FolderPlus, Loader2, RefreshCw, Home, X, Save, AlertTriangle, Upload,
  Copy, Move, GitBranch, Image as ImageIcon, CheckSquare, Square,
  FileArchive, PackageOpen, Check, MoreVertical, Database, Calculator, HardDrive, ChevronDown,
  Shield, UserCheck, Sparkles, X as XIcon,
} from 'lucide-react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import {
  useFileManagerStatus, useStartFileManager, useDirectoryListing,
  useFileContent, useCreateDirectory, useWriteFile, useRenameFile,
  useDeleteFile, useDownloadFile, useUploadFiles, useCopyFile,
  useArchiveFiles, useExtractArchive, useGitClone, useAuthenticatedBlobUrl,
  useDiskUsage, useFolderSize, useChmod, useChown,
} from '@/hooks/use-file-manager';
import type { FileEntry, UploadProgress } from '@/hooks/use-file-manager';
import { useAiFileEdit, useAiFolderEdit, useAiModels } from '@/hooks/use-ai-editor';

// ─── Constants ───────────────────────────────────────────────────────────────

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

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.bmp', '.ico', '.avif']);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.tar.gz', '.tgz']);
const SQLITE_EXTENSIONS = new Set(['.sqlite', '.db', '.sqlite3']);

type FileSortColumn = 'name' | 'size' | 'modifiedAt';

function getExtension(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.tar.gz')) return '.tar.gz';
  const dot = lower.lastIndexOf('.');
  return dot >= 0 ? lower.slice(dot) : '';
}

function isImageFile(filename: string): boolean { return IMAGE_EXTENSIONS.has(getExtension(filename)); }
function isArchiveFile(filename: string): boolean { return ARCHIVE_EXTENSIONS.has(getExtension(filename)); }
function isSqliteFile(filename: string): boolean { return SQLITE_EXTENSIONS.has(getExtension(filename)); }

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

function joinPath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

function modeToRwx(octal: string): string {
  const num = parseInt(octal, 8);
  const rwx = (n: number) =>
    (n & 4 ? 'r' : '-') + (n & 2 ? 'w' : '-') + (n & 1 ? 'x' : '-');
  return rwx((num >> 6) & 7) + rwx((num >> 3) & 7) + rwx(num & 7);
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function Files() {
  const navigate = useNavigate();
  const [currentPath, setCurrentPath] = useState('/');
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  const [newDirOpen, setNewDirOpen] = useState(false);
  const [newDirName, setNewDirName] = useState('');
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameName, setRenameName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveFormat, setArchiveFormat] = useState<'zip' | 'tar.gz' | 'tar'>('tar.gz');
  const [archiveName, setArchiveName] = useState('');
  const [gitCloneOpen, setGitCloneOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState('');
  const [gitDest, setGitDest] = useState('');
  const [moveTarget, setMoveTarget] = useState<{ paths: string[]; mode: 'copy' | 'move' } | null>(null);
  const [extractTarget, setExtractTarget] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  const [chmodTarget, setChmodTarget] = useState<{ path: string; currentMode: string; isDir: boolean } | null>(null);
  const [chmodMode, setChmodMode] = useState('');
  const [chmodRecursive, setChmodRecursive] = useState(false);
  const [chownTarget, setChownTarget] = useState<{ path: string; currentUid: number; currentGid: number; isDir: boolean } | null>(null);
  const [chownUid, setChownUid] = useState('');
  const [chownGid, setChownGid] = useState('');
  const [chownRecursive, setChownRecursive] = useState(false);
  const [chownOwnerName, setChownOwnerName] = useState('');
  const [chownGroupName, setChownGroupName] = useState('');

  // Folder AI state
  const [showFolderAi, setShowFolderAi] = useState(false);
  const [folderAiPrompt, setFolderAiPrompt] = useState('');
  const folderAiEdit = useAiFolderEdit('');
  const folderAiModels = useAiModels();
  const [folderAiModelId, setFolderAiModelId] = useState('');

  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fmStatus = useFileManagerStatus();
  const startFm = useStartFileManager();
  const dirListing = useDirectoryListing(currentPath, fmStatus.data?.ready === true);
  const createDir = useCreateDirectory();
  const createFile = useWriteFile();
  const renameFile = useRenameFile();
  const deleteFile = useDeleteFile();
  const downloadFile = useDownloadFile();
  const { uploads, uploadFiles, clearUploads, visible: uploadModalVisible } = useUploadFiles();
  const copyFile = useCopyFile();
  const archiveFiles = useArchiveFiles();
  const gitClone = useGitClone();
  const { data: diskUsage } = useDiskUsage();
  const folderSize = useFolderSize();
  const chmod = useChmod();
  const chown = useChown();
  const [folderSizes, setFolderSizes] = useState<Record<string, { size: string; loading: boolean }>>({});
  const [sortCol, setSortCol] = useState<FileSortColumn>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const handleSort = useCallback((col: FileSortColumn) => {
    setSortCol(prev => {
      if (prev === col) {
        setSortDir(d => d === 'asc' ? 'desc' : 'asc');
      } else {
        setSortDir('asc');
      }
      return col;
    });
  }, []);

  const sortedEntries = useMemo(() => {
    if (!dirListing.data) return [];
    const entries = [...dirListing.data.entries];
    const dir = sortDir === 'asc' ? 1 : -1;

    entries.sort((a, b) => {
      // Directories always come first
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;

      // Within same type, sort by selected column
      switch (sortCol) {
        case 'name':
          return dir * a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        case 'size':
          return dir * (a.size - b.size);
        case 'modifiedAt': {
          const aTime = a.modifiedAt ? new Date(a.modifiedAt).getTime() : 0;
          const bTime = b.modifiedAt ? new Date(b.modifiedAt).getTime() : 0;
          return dir * (aTime - bTime);
        }
        default:
          return 0;
      }
    });
    return entries;
  }, [dirListing.data, sortCol, sortDir]);

  const calculateFolderSize = useCallback(async (dirPath: string) => {
    setFolderSizes(prev => ({ ...prev, [dirPath]: { size: '', loading: true } }));
    try {
      const result = await folderSize.mutateAsync(dirPath);
      setFolderSizes(prev => ({ ...prev, [dirPath]: { size: result.data.sizeFormatted, loading: false } }));
    } catch {
      setFolderSizes(prev => ({ ...prev, [dirPath]: { size: 'Error', loading: false } }));
    }
  }, [folderSize]);

  // Clear selection on navigate
  useEffect(() => { setSelected(new Set()); }, [currentPath]);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current <= 0) { dragCounter.current = 0; setDragging(false); }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setDragging(false);

    // Try to handle folder drops via DataTransferItem.webkitGetAsEntry
    const items = e.dataTransfer.items;
    if (items && items.length > 0) {
      const allFiles: { file: File; relativePath: string }[] = [];

      const readEntry = (entry: FileSystemEntry, path: string): Promise<void> => {
        return new Promise((resolve) => {
          if (entry.isFile) {
            (entry as FileSystemFileEntry).file((file) => {
              allFiles.push({ file, relativePath: path + file.name });
              resolve();
            }, () => resolve());
          } else if (entry.isDirectory) {
            const reader = (entry as FileSystemDirectoryEntry).createReader();
            reader.readEntries(async (entries) => {
              for (const child of entries) {
                await readEntry(child, path + entry.name + '/');
              }
              resolve();
            }, () => resolve());
          } else {
            resolve();
          }
        });
      };

      const entryPromises: Promise<void>[] = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry?.();
        if (entry) {
          entryPromises.push(readEntry(entry, ''));
        }
      }

      if (entryPromises.length > 0) {
        await Promise.all(entryPromises);
        if (allFiles.length > 0) {
          for (const { file, relativePath } of allFiles) {
            const dir = relativePath.includes('/')
              ? joinPath(currentPath, relativePath.substring(0, relativePath.lastIndexOf('/')))
              : currentPath;
            uploadFiles([file], dir);
          }
          return;
        }
      }
    }

    // Fallback: plain file drop
    if (e.dataTransfer.files.length > 0) {
      uploadFiles(e.dataTransfer.files, currentPath);
    }
  }, [uploadFiles, currentPath]);

  // Auto-start file manager
  useEffect(() => {
    if (fmStatus.data && fmStatus.data.phase === 'not_deployed' && !startFm.isPending) {
      startFm.mutate();
    }
  }, [fmStatus.data?.phase]);

  const toggleSelect = useCallback((name: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (!dirListing.data) return;
    const allNames = dirListing.data.entries.map(e => e.name);
    setSelected(prev => prev.size === allNames.length ? new Set() : new Set(allNames));
  }, [dirListing.data]);

  const selectedPaths = useMemo(() => Array.from(selected).map(name => joinPath(currentPath, name)), [selected, currentPath]);

  const handleFileClick = useCallback((entry: FileEntry) => {
    const fullPath = joinPath(currentPath, entry.name);
    if (entry.type === 'directory') {
      setCurrentPath(fullPath);
    } else if (isSqliteFile(entry.name)) {
      navigate(`/database-manager?file=${encodeURIComponent(fullPath.replace(/^\//, ''))}`);
    } else if (isImageFile(entry.name)) {
      setViewingImage(fullPath);
    } else if (isArchiveFile(entry.name)) {
      setExtractTarget(fullPath);
    } else if (entry.size < 10 * 1024 * 1024) {
      setEditingFile(fullPath);
    }
  }, [currentPath, navigate]);

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  // Directories in current listing (for extract dialog)
  const currentDirs = useMemo(() =>
    dirListing.data?.entries.filter(e => e.type === 'directory').map(e => e.name) ?? [],
    [dirListing.data],
  );

  // ─── Loading states ──────────────────────────────────────────────────────

  if (!fmStatus.data || fmStatus.data.phase === 'not_deployed' || fmStatus.data.phase === 'starting') {
    return (
      <div className="space-y-6">
        <FilePageHeader />
        <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
          <div className="px-6 py-16 text-center">
            <Loader2 size={48} className="mx-auto animate-spin text-brand-500" />
            <h2 className="mt-4 text-lg font-semibold text-gray-900 dark:text-gray-100">Starting File Manager</h2>
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
            <button onClick={() => startFm.mutate()} className="mt-4 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600">Retry</button>
          </div>
        </div>
      </div>
    );
  }

  if (editingFile) {
    return <div className="space-y-4"><FileEditor path={editingFile} onClose={() => setEditingFile(null)} /></div>;
  }

  if (viewingImage) {
    return <div className="space-y-4"><FilePageHeader /><ImageViewer path={viewingImage} onClose={() => setViewingImage(null)} onDownload={() => downloadFile(viewingImage)} /></div>;
  }

  // ─── File browser view ───────────────────────────────────────────────────

  const pathParts = currentPath.split('/').filter(Boolean);

  const used = diskUsage?.data?.usedFormatted ?? '\u2014';
  const total = diskUsage?.data?.totalFormatted ?? '\u2014';
  const usagePct = diskUsage?.data ? (diskUsage.data.usedBytes / diskUsage.data.totalBytes) * 100 : 0;

  return (
    <div className="space-y-4">
      <FilePageHeader />

      {/* Storage usage bar */}
      <div className="flex items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
        <HardDrive size={16} />
        <div className="flex-1 max-w-xs">
          <div className="flex justify-between text-xs mb-1">
            <span>{used} used</span>
            <span>{total} total</span>
          </div>
          <div className="h-1.5 rounded-full bg-gray-200 dark:bg-gray-700">
            <div
              className={`h-1.5 rounded-full ${usagePct > 90 ? 'bg-red-500' : usagePct > 70 ? 'bg-amber-500' : 'bg-brand-500'}`}
              style={{ width: `${Math.min(usagePct, 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* Breadcrumbs + Actions */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-1 text-sm overflow-x-auto">
          <button onClick={() => setCurrentPath('/')} className="flex items-center gap-1 text-gray-500 hover:text-brand-600 dark:text-gray-400 dark:hover:text-brand-400"><Home size={14} /></button>
          {pathParts.map((part, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight size={12} className="text-gray-300 dark:text-gray-600" />
              <button onClick={() => setCurrentPath('/' + pathParts.slice(0, i + 1).join('/'))} className="text-gray-600 hover:text-brand-600 dark:text-gray-300 dark:hover:text-brand-400">{part}</button>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <button onClick={() => dirListing.refetch()} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300" title="Refresh"><RefreshCw size={14} /></button>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) uploadFiles(e.target.files, currentPath); e.target.value = ''; }} />
          <button onClick={() => fileInputRef.current?.click()} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50">
            <Upload size={14} /> Upload
          </button>
          <button onClick={() => { setGitCloneOpen(true); setGitUrl(''); setGitDest(''); }} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50">
            <GitBranch size={14} /> Git Clone
          </button>
          <button onClick={() => { setNewFileOpen(true); setNewFileName(''); }} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50">
            <FilePlus size={14} /> New File
          </button>
          <button onClick={() => { setNewDirOpen(true); setNewDirName(''); }} className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600">
            <FolderPlus size={14} /> New Folder
          </button>
          <button onClick={() => setShowFolderAi(!showFolderAi)}
            className={`rounded-lg p-2 transition-colors ${showFolderAi ? 'text-purple-500 bg-purple-50 dark:bg-purple-900/20' : 'text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-300'}`}
            title="AI Edit (folder)">
            <Sparkles size={16} />
          </button>
        </div>
      </div>

      {/* Bulk action toolbar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-brand-200 dark:border-brand-800 bg-brand-50 dark:bg-brand-900/20 px-4 py-2.5 flex-wrap">
          <span className="text-base font-medium text-brand-700 dark:text-brand-300">{selected.size} selected</span>
          <div className="mx-2 h-4 w-px bg-brand-200 dark:bg-brand-700" />
          <button onClick={() => { setMoveTarget({ paths: selectedPaths, mode: 'copy' }); }} className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm font-medium text-gray-700 hover:bg-brand-100 dark:text-gray-300 dark:hover:bg-brand-800/50"><Copy size={16} /> Copy</button>
          <button onClick={() => { setMoveTarget({ paths: selectedPaths, mode: 'move' }); }} className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm font-medium text-gray-700 hover:bg-brand-100 dark:text-gray-300 dark:hover:bg-brand-800/50"><Move size={16} /> Move</button>
          <button onClick={() => { setArchiveOpen(true); setArchiveName(`archive-${Date.now()}`); }} className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm font-medium text-gray-700 hover:bg-brand-100 dark:text-gray-300 dark:hover:bg-brand-800/50"><FileArchive size={16} /> Archive</button>
          <button
            onClick={() => {
              const firstEntry = dirListing.data?.entries.find(e => selected.has(e.name));
              if (firstEntry) {
                setChmodTarget({
                  path: joinPath(currentPath, firstEntry.name),
                  currentMode: firstEntry.permissions,
                  isDir: firstEntry.type === 'directory',
                });
                setChmodMode(firstEntry.permissions);
              }
            }}
            className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm font-medium text-gray-700 hover:bg-brand-100 dark:text-gray-300 dark:hover:bg-brand-800/50"
          ><Shield size={16} /> Permissions</button>
          <button
            onClick={() => {
              const firstEntry = dirListing.data?.entries.find(e => selected.has(e.name));
              if (firstEntry) {
                setChownTarget({
                  path: joinPath(currentPath, firstEntry.name),
                  currentUid: firstEntry.uid,
                  currentGid: firstEntry.gid,
                  isDir: firstEntry.type === 'directory',
                });
                setChownUid(String(firstEntry.uid));
                setChownGid(String(firstEntry.gid));
                setChownOwnerName('');
                setChownGroupName('');
              }
            }}
            className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm font-medium text-gray-700 hover:bg-brand-100 dark:text-gray-300 dark:hover:bg-brand-800/50"
          ><UserCheck size={16} /> Ownership</button>
          {dirListing.data?.entries.some(e => e.type === 'directory' && selected.has(e.name)) && (
            <button
              onClick={() => {
                const selectedDirs = dirListing.data?.entries.filter(e => e.type === 'directory' && selected.has(e.name)) ?? [];
                for (const dir of selectedDirs) {
                  const fullPath = joinPath(currentPath, dir.name);
                  calculateFolderSize(fullPath);
                }
              }}
              className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm font-medium text-gray-700 hover:bg-brand-100 dark:text-gray-300 dark:hover:bg-brand-800/50"
            ><Calculator size={16} /> Calculate Sizes</button>
          )}
          <button onClick={() => setBulkDeleteOpen(true)} className="inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/30"><Trash2 size={16} /> Delete</button>
          <div className="flex-1" />
          <button onClick={() => setSelected(new Set())} className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">Clear</button>
        </div>
      )}

      {/* New file input */}
      {newFileOpen && (
        <div className="flex items-center gap-2 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-3">
          <FilePlus size={16} className="text-blue-500" />
          <input type="text" value={newFileName} onChange={(e) => setNewFileName(e.target.value)} placeholder="filename.txt"
            className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newFileName.trim()) createFile.mutate({ path: joinPath(currentPath, newFileName), content: '' }, { onSuccess: () => setNewFileOpen(false) });
              if (e.key === 'Escape') setNewFileOpen(false);
            }}
          />
          <button onClick={() => { if (newFileName.trim()) createFile.mutate({ path: joinPath(currentPath, newFileName), content: '' }, { onSuccess: () => setNewFileOpen(false) }); }} disabled={!newFileName.trim() || createFile.isPending} className="rounded bg-blue-500 px-3 py-1 text-xs text-white hover:bg-blue-600 disabled:opacity-50">Create</button>
          <button onClick={() => setNewFileOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><X size={14} /></button>
        </div>
      )}

      {/* New directory input */}
      {newDirOpen && (
        <div className="flex items-center gap-2 rounded-lg border border-brand-200 dark:border-brand-800 bg-brand-50 dark:bg-brand-900/20 p-3">
          <FolderPlus size={16} className="text-brand-500" />
          <input type="text" value={newDirName} onChange={(e) => setNewDirName(e.target.value)} placeholder="Folder name"
            className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newDirName.trim()) createDir.mutate(joinPath(currentPath, newDirName), { onSuccess: () => setNewDirOpen(false) });
              if (e.key === 'Escape') setNewDirOpen(false);
            }}
          />
          <button onClick={() => { if (newDirName.trim()) createDir.mutate(joinPath(currentPath, newDirName), { onSuccess: () => setNewDirOpen(false) }); }} disabled={!newDirName.trim() || createDir.isPending} className="rounded bg-brand-500 px-3 py-1 text-xs text-white hover:bg-brand-600 disabled:opacity-50">Create</button>
          <button onClick={() => setNewDirOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><X size={14} /></button>
        </div>
      )}

      {/* File list with drag-and-drop */}
      <div
        className={`rounded-xl border-2 ${dragging ? 'border-dashed border-brand-400 bg-brand-50 dark:bg-brand-900/20' : 'border-gray-200 dark:border-gray-700'} bg-white dark:bg-gray-800 shadow-sm overflow-hidden transition-colors`}
        onDragEnter={handleDragEnter}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dragging && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm font-medium text-brand-600 dark:text-brand-400 pointer-events-none">
            <Upload size={20} /> Drop files here to upload
          </div>
        )}
        {dirListing.isLoading && (
          <div className="flex items-center justify-center py-12"><Loader2 size={24} className="animate-spin text-gray-400" /></div>
        )}
        {dirListing.error && (
          <div className="px-6 py-8 text-center text-sm text-red-600 dark:text-red-400">{dirListing.error instanceof Error ? dirListing.error.message : 'Failed to load files'}</div>
        )}

        {dirListing.data && (
          <table className="w-full text-[15px]">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 text-left text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
                <th className="px-3 py-3 w-8">
                  <button onClick={toggleSelectAll} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
                    {dirListing.data.entries.length > 0 && selected.size === dirListing.data.entries.length ? <CheckSquare size={14} /> : <Square size={14} />}
                  </button>
                </th>
                <th className="px-3 py-3">
                  <button onClick={() => handleSort('name')} className="inline-flex items-center gap-1 hover:text-gray-700 dark:hover:text-gray-200">
                    Name
                    {sortCol === 'name' && <ChevronDown size={14} className={`transition-transform ${sortDir === 'asc' ? 'rotate-180' : ''}`} />}
                  </button>
                </th>
                <th className="px-3 py-3 w-24">
                  <button onClick={() => handleSort('size')} className="inline-flex items-center gap-1 hover:text-gray-700 dark:hover:text-gray-200">
                    Size
                    {sortCol === 'size' && <ChevronDown size={14} className={`transition-transform ${sortDir === 'asc' ? 'rotate-180' : ''}`} />}
                  </button>
                </th>
                <th className="px-3 py-3 w-40 hidden sm:table-cell">
                  <button onClick={() => handleSort('modifiedAt')} className="inline-flex items-center gap-1 hover:text-gray-700 dark:hover:text-gray-200">
                    Modified
                    {sortCol === 'modifiedAt' && <ChevronDown size={14} className={`transition-transform ${sortDir === 'asc' ? 'rotate-180' : ''}`} />}
                  </button>
                </th>
                <th className="px-3 py-3 w-28 hidden md:table-cell">Permissions</th>
                <th className="px-3 py-3 w-36 hidden lg:table-cell">Owner</th>
                <th className="px-3 py-3 w-10" />
              </tr>
            </thead>
            <tbody>
              {currentPath !== '/' && (
                <tr className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 cursor-pointer"
                  onClick={() => { const parts = currentPath.split('/').filter(Boolean); parts.pop(); setCurrentPath('/' + parts.join('/')); }}>
                  <td className="px-3 py-2.5" />
                  <td className="px-3 py-2.5 flex items-center gap-2"><ArrowLeft size={14} className="text-gray-400" /><span className="text-gray-500 dark:text-gray-400">..</span></td>
                  <td /><td className="hidden sm:table-cell" /><td className="hidden md:table-cell" /><td className="hidden lg:table-cell" /><td />
                </tr>
              )}

              {sortedEntries.map((entry) => {
                const fullPath = joinPath(currentPath, entry.name);
                return (
                  <FileRow
                    key={entry.name} entry={entry}
                    isSelected={selected.has(entry.name)}
                    onToggleSelect={() => toggleSelect(entry.name)}
                    onClick={() => handleFileClick(entry)}
                    onContextMenu={(e) => handleContextMenu(e, entry)}
                    onActionClick={(entry) => setContextMenu({ x: 0, y: 0, entry })}
                    folderSizeInfo={entry.type === 'directory' ? folderSizes[fullPath] : undefined}
                    onCalculateSize={entry.type === 'directory' ? () => calculateFolderSize(fullPath) : undefined}
                  />
                );
              })}

              {dirListing.data.entries.length === 0 && currentPath === '/' && (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-gray-400 dark:text-gray-500"><FolderOpen size={32} className="mx-auto mb-2" />Empty directory</td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Folder AI Chat */}
      {showFolderAi && (
        <div className="rounded-xl border border-purple-200 dark:border-purple-800 bg-purple-50/50 dark:bg-purple-900/10 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <Sparkles size={14} className="text-purple-500" /> AI Folder Edit
            </h3>
            <button onClick={() => setShowFolderAi(false)} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">Hide</button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            AI can read and modify files in <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">{currentPath}</code>. Describe what you want to change.
          </p>
          {folderAiEdit.error && (
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-1.5 text-xs text-red-700 dark:text-red-400">{folderAiEdit.error}</div>
          )}
          <div className="flex gap-2 items-end">
            {(folderAiModels.data?.data ?? []).length > 1 && (
              <select className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1.5 text-xs text-gray-900 dark:text-gray-100 w-28 shrink-0"
                value={folderAiModelId || (folderAiModels.data?.data?.[0]?.id ?? '')}
                onChange={(e) => setFolderAiModelId(e.target.value)}>
                {(folderAiModels.data?.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
              </select>
            )}
            <textarea
              className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500 resize-none"
              placeholder="e.g., Add dark mode to all HTML files..."
              value={folderAiPrompt}
              onChange={(e) => setFolderAiPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (folderAiPrompt.trim() && !folderAiEdit.loading) {
                    const modelId = folderAiModelId || folderAiModels.data?.data?.[0]?.id || '';
                    if (modelId) folderAiEdit.edit(currentPath, folderAiPrompt.trim(), modelId);
                  }
                }
              }}
              disabled={folderAiEdit.loading || (folderAiModels.data?.data ?? []).length === 0}
              rows={2}
            />
            <button
              onClick={() => {
                const modelId = folderAiModelId || folderAiModels.data?.data?.[0]?.id || '';
                if (folderAiPrompt.trim() && modelId) folderAiEdit.edit(currentPath, folderAiPrompt.trim(), modelId);
              }}
              disabled={!folderAiPrompt.trim() || folderAiEdit.loading || (folderAiModels.data?.data ?? []).length === 0}
              className="rounded-lg bg-purple-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-purple-600 disabled:opacity-50 shrink-0 self-end">
              {folderAiEdit.loading ? <Loader2 size={14} className="animate-spin" /> : 'Send'}
            </button>
          </div>
          {(folderAiModels.data?.data ?? []).length === 0 && (
            <p className="text-[10px] text-gray-400">No AI models configured. Go to Admin → Settings → AI.</p>
          )}
        </div>
      )}

      {/* Folder AI Change Plan Modal */}
      {folderAiEdit.result && folderAiEdit.result.changes.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={(e) => { if (e.target === e.currentTarget) folderAiEdit.clear(); }}>
          <div className="w-full max-w-3xl max-h-[80vh] rounded-xl bg-white dark:bg-gray-800 shadow-xl overflow-hidden flex flex-col">
            <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">AI Change Plan</h3>
              {folderAiEdit.result.planSummary && (
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{folderAiEdit.result.planSummary}</p>
              )}
              <p className="text-xs text-gray-400 mt-1">
                {folderAiEdit.result.changes.length} file(s) modified |
                {folderAiEdit.result.tokensUsed.input + folderAiEdit.result.tokensUsed.output} tokens used
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {folderAiEdit.result.changes.map((change, i) => (
                <details key={i} className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                  <summary className="flex items-center gap-2 px-4 py-2.5 cursor-pointer bg-gray-50 dark:bg-gray-700/50 hover:bg-gray-100 dark:hover:bg-gray-700">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                      change.action === 'create' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                      : change.action === 'delete' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                      : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                    }`}>{change.action.toUpperCase()}</span>
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{change.path}</span>
                  </summary>
                  <div className="bg-gray-900 p-3 font-mono text-xs text-gray-300 max-h-64 overflow-y-auto whitespace-pre-wrap">
                    {change.modifiedContent?.slice(0, 3000) ?? '(no content)'}
                    {(change.modifiedContent?.length ?? 0) > 3000 && <span className="text-gray-500">... ({change.modifiedContent!.length} chars total)</span>}
                  </div>
                </details>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
              <button onClick={() => folderAiEdit.clear()}
                className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
                Cancel
              </button>
              <button
                onClick={async () => {
                  for (const change of folderAiEdit.result!.changes) {
                    if (change.modifiedContent != null) {
                      await createFile.mutateAsync({ path: change.path, content: change.modifiedContent });
                    }
                  }
                  folderAiEdit.clear();
                  setFolderAiPrompt('');
                  dirListing.refetch();
                }}
                className="rounded-lg bg-green-500 px-4 py-2 text-sm font-medium text-white hover:bg-green-600">
                <Check size={14} className="inline mr-1" /> Apply All ({folderAiEdit.result.changes.length} files)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          entry={contextMenu.entry}
          position={contextMenu.x > 0 ? { x: contextMenu.x, y: contextMenu.y } : undefined}
          currentPath={currentPath}
          onClose={() => setContextMenu(null)}
          onEdit={(path) => { setEditingFile(path); setContextMenu(null); }}
          onViewImage={(path) => { setViewingImage(path); setContextMenu(null); }}
          onDownload={(path) => { downloadFile(path); setContextMenu(null); }}
          onRename={(name) => { setRenameTarget(name); setRenameName(name); setContextMenu(null); }}
          onDelete={(name) => { setDeleteTarget(name); setContextMenu(null); }}
          onCopy={(path) => { setMoveTarget({ paths: [path], mode: 'copy' }); setContextMenu(null); }}
          onMove={(path) => { setMoveTarget({ paths: [path], mode: 'move' }); setContextMenu(null); }}
          onExtract={(path) => { setExtractTarget(path); setContextMenu(null); }}
          onNavigate={(path) => { setCurrentPath(path); setContextMenu(null); }}
          onOpenSqlite={(path) => {
            // Strip leading / to get relative path for SQLite manager
            const relPath = path.startsWith('/') ? path.slice(1) : path;
            navigate(`/database-manager?file=${encodeURIComponent(relPath)}`);
            setContextMenu(null);
          }}
          onCalculateFolderSize={(path) => { calculateFolderSize(path); setContextMenu(null); }}
          onChmod={(entry) => {
            setChmodTarget({
              path: joinPath(currentPath, entry.name),
              currentMode: entry.permissions,
              isDir: entry.type === 'directory',
            });
            setChmodMode(entry.permissions);
            setContextMenu(null);
          }}
          onChown={(entry) => {
            setChownTarget({
              path: joinPath(currentPath, entry.name),
              currentUid: entry.uid,
              currentGid: entry.gid,
              isDir: entry.type === 'directory',
            });
            setChownUid(String(entry.uid));
            setChownGid(String(entry.gid));
            setChownOwnerName('');
            setChownGroupName('');
            setContextMenu(null);
          }}
        />
      )}

      {/* Upload progress modal */}
      {uploadModalVisible && <UploadProgressModal uploads={uploads} onClose={clearUploads} />}

      {/* ─── Dialogs ──────────────────────────────────────────────────── */}

      {renameTarget && (
        <SimpleDialog title="Rename" onClose={() => setRenameTarget(null)}
          onConfirm={() => { renameFile.mutate({ oldPath: joinPath(currentPath, renameTarget), newPath: joinPath(currentPath, renameName) }, { onSuccess: () => setRenameTarget(null) }); }}
          isPending={renameFile.isPending} confirmLabel="Rename">
          <input type="text" value={renameName} onChange={(e) => setRenameName(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" autoFocus />
        </SimpleDialog>
      )}

      {deleteTarget && (
        <SimpleDialog title="Delete" onClose={() => setDeleteTarget(null)}
          onConfirm={() => { deleteFile.mutate(joinPath(currentPath, deleteTarget), { onSuccess: () => setDeleteTarget(null) }); }}
          isPending={deleteFile.isPending} confirmLabel="Delete" destructive>
          <p className="text-sm text-gray-600 dark:text-gray-400">Delete <strong className="text-gray-900 dark:text-gray-100">{deleteTarget}</strong>? This cannot be undone.</p>
        </SimpleDialog>
      )}

      {bulkDeleteOpen && <BulkDeleteDialog paths={selectedPaths} onClose={() => setBulkDeleteOpen(false)} onSuccess={() => { setBulkDeleteOpen(false); setSelected(new Set()); }} />}

      {archiveOpen && (
        <SimpleDialog title="Create Archive" onClose={() => setArchiveOpen(false)}
          onConfirm={() => {
            const ext = archiveFormat === 'zip' ? '.zip' : archiveFormat === 'tar.gz' ? '.tar.gz' : '.tar';
            archiveFiles.mutate({ paths: selectedPaths, destPath: joinPath(currentPath, archiveName + ext), format: archiveFormat }, { onSuccess: () => { setArchiveOpen(false); setSelected(new Set()); } });
          }} isPending={archiveFiles.isPending} confirmLabel="Create">
          <div className="space-y-3">
            <p className="text-sm text-gray-600 dark:text-gray-400">Archive {selected.size} item{selected.size > 1 ? 's' : ''}</p>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Archive name</label>
              <input type="text" value={archiveName} onChange={(e) => setArchiveName(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" autoFocus />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Format</label>
              <select value={archiveFormat} onChange={(e) => setArchiveFormat(e.target.value as 'zip' | 'tar.gz' | 'tar')} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100">
                <option value="tar.gz">.tar.gz</option>
                <option value="zip">.zip</option>
                <option value="tar">.tar</option>
              </select>
            </div>
          </div>
        </SimpleDialog>
      )}

      {extractTarget && (
        <ExtractDialog archivePath={extractTarget} currentPath={currentPath} currentDirs={currentDirs}
          onClose={() => setExtractTarget(null)} />
      )}

      {gitCloneOpen && (
        <SimpleDialog title="Clone Git Repository" onClose={() => setGitCloneOpen(false)}
          onConfirm={() => {
            const dest = gitDest.trim() || joinPath(currentPath, gitUrl.split('/').pop()?.replace(/\.git$/, '') || 'repo');
            gitClone.mutate({ url: gitUrl, destPath: dest }, { onSuccess: () => setGitCloneOpen(false) });
          }} isPending={gitClone.isPending} confirmLabel="Clone">
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Repository URL</label>
              <input type="url" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder="https://github.com/user/repo.git" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" autoFocus />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Target folder (optional)</label>
              <input type="text" value={gitDest} onChange={(e) => setGitDest(e.target.value)} placeholder={`${currentPath === '/' ? '' : currentPath}/repo-name`} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
            </div>
          </div>
        </SimpleDialog>
      )}

      {/* Chmod modal */}
      {chmodTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/50" onClick={() => setChmodTarget(null)} />
          <div className="relative w-full max-w-sm rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-4">Change Permissions</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3 font-mono truncate">{chmodTarget.path}</p>
            {selected.size > 1 && (
              <p className="text-xs text-brand-600 dark:text-brand-400 mb-3">Applying to {selected.size} selected items</p>
            )}
            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                Mode (octal)
              </label>
              <input
                type="text"
                value={chmodMode}
                onChange={(e) => setChmodMode(e.target.value.replace(/[^0-7]/g, '').slice(0, 4))}
                placeholder="755"
                maxLength={4}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm font-mono text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                autoFocus
              />
              {chmodMode.length >= 3 && (
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500 font-mono">{modeToRwx(chmodMode)}</p>
              )}
            </div>
            {/* rwx checkboxes */}
            <div className="mb-4">
              <div className="grid grid-cols-4 gap-1 text-xs text-center">
                <div />
                <span className="font-medium text-gray-600 dark:text-gray-400">Read</span>
                <span className="font-medium text-gray-600 dark:text-gray-400">Write</span>
                <span className="font-medium text-gray-600 dark:text-gray-400">Execute</span>
                {(['Owner', 'Group', 'Others'] as const).map((label, rowIdx) => {
                  const shift = (2 - rowIdx) * 3;
                  const modeNum = parseInt(chmodMode.padStart(3, '0'), 8) || 0;
                  return (
                    <Fragment key={label}>
                      <span className="text-right pr-2 font-medium text-gray-600 dark:text-gray-400 py-1">{label}</span>
                      {[4, 2, 1].map(bit => {
                        const isSet = (modeNum >> shift & bit) !== 0;
                        return (
                          <label key={bit} className="flex items-center justify-center py-1 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={isSet}
                              onChange={(e) => {
                                const newMode = e.target.checked
                                  ? modeNum | (bit << shift)
                                  : modeNum & ~(bit << shift);
                                setChmodMode(newMode.toString(8).padStart(3, '0'));
                              }}
                              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-600 focus:ring-brand-500"
                            />
                          </label>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </div>
            </div>
            {chmodTarget.isDir && (
              <label className="flex items-center gap-2 mb-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={chmodRecursive}
                  onChange={(e) => setChmodRecursive(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-600 focus:ring-brand-500"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">Apply recursively to all contents</span>
              </label>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setChmodTarget(null)} className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>
              <button
                onClick={async () => {
                  if (!chmodMode || chmodMode.length < 3) return;
                  if (selected.size > 1) {
                    for (const name of selected) {
                      await chmod.mutateAsync({ path: joinPath(currentPath, name), mode: chmodMode, recursive: chmodRecursive });
                    }
                  } else {
                    await chmod.mutateAsync({ path: chmodTarget.path, mode: chmodMode, recursive: chmodRecursive });
                  }
                  setChmodTarget(null);
                  setChmodRecursive(false);
                }}
                disabled={chmod.isPending || !chmodMode || chmodMode.length < 3}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              >
                {chmod.isPending ? 'Applying...' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chown modal */}
      {chownTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/50" onClick={() => { setChownTarget(null); setChownOwnerName(''); setChownGroupName(''); }} />
          <div className="relative w-full max-w-sm rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100 mb-4">Change Ownership</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-3 font-mono truncate">{chownTarget.path}</p>
            {selected.size > 1 && (
              <p className="text-xs text-brand-600 dark:text-brand-400 mb-3">Applying to {selected.size} selected items</p>
            )}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Owner Name</label>
                <input
                  type="text"
                  value={chownOwnerName}
                  onChange={(e) => setChownOwnerName(e.target.value)}
                  placeholder="www-data"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Group Name</label>
                <input
                  type="text"
                  value={chownGroupName}
                  onChange={(e) => setChownGroupName(e.target.value)}
                  placeholder="www-data"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
              </div>
            </div>
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-3">Use names or numeric IDs (names take precedence)</p>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">UID</label>
                <input type="number" value={chownUid} onChange={(e) => setChownUid(e.target.value)} min="0"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">GID</label>
                <input type="number" value={chownGid} onChange={(e) => setChownGid(e.target.value)} min="0"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:bg-gray-700 dark:text-gray-100 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500" />
              </div>
            </div>
            {chownTarget.isDir && (
              <label className="flex items-center gap-2 mb-4 cursor-pointer">
                <input type="checkbox" checked={chownRecursive} onChange={(e) => setChownRecursive(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-brand-600 focus:ring-brand-500" />
                <span className="text-sm text-gray-700 dark:text-gray-300">Apply recursively to all contents</span>
              </label>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => { setChownTarget(null); setChownOwnerName(''); setChownGroupName(''); }} className="rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50">Cancel</button>
              <button
                onClick={async () => {
                  const hasNames = !!(chownOwnerName || chownGroupName);
                  const uid = chownUid ? parseInt(chownUid, 10) : undefined;
                  const gid = chownGid ? parseInt(chownGid, 10) : undefined;
                  if (!hasNames && uid === undefined && gid === undefined) return;
                  const makeArgs = (path: string) =>
                    hasNames
                      ? { path, owner: chownOwnerName || undefined, group: chownGroupName || undefined, recursive: chownRecursive }
                      : { path, uid, gid, recursive: chownRecursive };
                  if (selected.size > 1) {
                    for (const name of selected) {
                      await chown.mutateAsync(makeArgs(joinPath(currentPath, name)));
                    }
                  } else {
                    await chown.mutateAsync(makeArgs(chownTarget.path));
                  }
                  setChownTarget(null);
                  setChownRecursive(false);
                  setChownOwnerName('');
                  setChownGroupName('');
                }}
                disabled={chown.isPending || (!chownUid && !chownGid && !chownOwnerName && !chownGroupName)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
              >
                {chown.isPending ? 'Applying...' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}

      {moveTarget && (
        <FolderPickerDialog
          title={moveTarget.mode === 'copy' ? 'Copy To' : 'Move To'}
          description={`${moveTarget.mode === 'copy' ? 'Copy' : 'Move'} ${moveTarget.paths.length} item${moveTarget.paths.length > 1 ? 's' : ''} to:`}
          initialPath={currentPath}
          confirmLabel={moveTarget.mode === 'copy' ? 'Copy Here' : 'Move Here'}
          isPending={copyFile.isPending || renameFile.isPending}
          onClose={() => setMoveTarget(null)}
          onConfirm={(destPath) => {
            const promises = moveTarget.paths.map(sourcePath => {
              const name = sourcePath.split('/').pop() || '';
              const dest = joinPath(destPath, name);
              return moveTarget.mode === 'copy' ? copyFile.mutateAsync({ sourcePath, destPath: dest }) : renameFile.mutateAsync({ oldPath: sourcePath, newPath: dest });
            });
            Promise.all(promises).then(() => { setMoveTarget(null); setSelected(new Set()); });
          }}
        />
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function FilePageHeader() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400"><FolderOpen size={20} /></div>
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100" data-testid="files-heading">Files</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">Manage your website files and directories.</p>
      </div>
    </div>
  );
}

function FileRow({
  entry, isSelected, onToggleSelect, onClick, onContextMenu, onActionClick, folderSizeInfo, onCalculateSize,
}: {
  readonly entry: FileEntry;
  readonly isSelected: boolean;
  readonly onToggleSelect: () => void;
  readonly onClick: () => void;
  readonly onContextMenu: (e: React.MouseEvent) => void;
  readonly onActionClick: (entry: FileEntry) => void;
  readonly folderSizeInfo?: { size: string; loading: boolean };
  readonly onCalculateSize?: () => void;
}) {
  const isDir = entry.type === 'directory';
  const isImage = !isDir && isImageFile(entry.name);
  const isArchive = !isDir && isArchiveFile(entry.name);
  const isSqlite = !isDir && isSqliteFile(entry.name);

  return (
    <tr
      className={`border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-gray-700/30 group cursor-pointer ${isSelected ? 'bg-brand-50 dark:bg-brand-900/20' : ''}`}
      onClick={(e) => { if ((e.target as HTMLElement).closest('[data-action]')) return; onClick(); }}
      onContextMenu={onContextMenu}
    >
      <td className="px-3 py-3" data-action="select">
        <button onClick={(e) => { e.stopPropagation(); onToggleSelect(); }} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          {isSelected ? <CheckSquare size={16} className="text-brand-500" /> : <Square size={16} />}
        </button>
      </td>
      <td className="px-3 py-3">
        <div className="flex items-center gap-2.5">
          {isDir ? <FolderOpen size={20} className="text-amber-500 dark:text-amber-400 shrink-0" />
            : isImage ? <ImageIcon size={20} className="text-purple-500 dark:text-purple-400 shrink-0" />
            : isArchive ? <FileArchive size={20} className="text-orange-500 dark:text-orange-400 shrink-0" />
            : isSqlite ? <Database size={20} className="text-blue-500 dark:text-blue-400 shrink-0" />
            : <File size={20} className="text-gray-400 dark:text-gray-500 shrink-0" />}
          <span className={isDir ? 'font-medium text-gray-900 dark:text-gray-100 text-[15px]' : 'text-gray-700 dark:text-gray-300 text-[15px]'}>{entry.name}</span>
        </div>
      </td>
      <td className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400">
        {isDir ? (
          folderSizeInfo?.loading ? (
            <Loader2 size={14} className="animate-spin text-gray-400" />
          ) : folderSizeInfo?.size ? (
            <span className="inline-flex items-center gap-1">
              {folderSizeInfo.size}
              {onCalculateSize && (
                <button onClick={(e) => { e.stopPropagation(); onCalculateSize(); }} className="text-gray-300 hover:text-gray-500 dark:text-gray-600 dark:hover:text-gray-400" title="Recalculate size" data-action="calc-size">
                  <RefreshCw size={12} />
                </button>
              )}
            </span>
          ) : (
            onCalculateSize ? (
              <button onClick={(e) => { e.stopPropagation(); onCalculateSize(); }} className="text-gray-300 hover:text-gray-500 dark:text-gray-600 dark:hover:text-gray-400" title="Calculate folder size" data-action="calc-size">
                <Calculator size={14} />
              </button>
            ) : '-'
          )
        ) : formatSize(entry.size)}
      </td>
      <td className="px-3 py-3 text-sm text-gray-500 dark:text-gray-400 hidden sm:table-cell">{entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : '-'}</td>
      <td className="px-3 py-3 text-sm hidden md:table-cell">
        <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{modeToRwx(entry.permissions)}</span>
      </td>
      <td className="px-3 py-3 text-sm hidden lg:table-cell">
        <span className="text-xs text-gray-500 dark:text-gray-400">{entry.owner ?? entry.uid}:{entry.group ?? entry.gid}</span>
      </td>
      <td className="px-3 py-3 text-right" data-action="actions">
        <button onClick={(e) => { e.stopPropagation(); onActionClick(entry); }} className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 opacity-0 group-hover:opacity-100 transition-opacity" title="Actions">
          <MoreVertical size={16} />
        </button>
      </td>
    </tr>
  );
}

function ContextMenu({
  entry, position, currentPath, onClose, onEdit, onViewImage, onDownload, onRename, onDelete, onCopy, onMove, onExtract, onNavigate, onOpenSqlite, onCalculateFolderSize, onChmod, onChown,
}: {
  readonly entry: FileEntry;
  readonly position?: { x: number; y: number };
  readonly currentPath: string;
  readonly onClose: () => void;
  readonly onEdit: (path: string) => void;
  readonly onViewImage: (path: string) => void;
  readonly onDownload: (path: string) => void;
  readonly onRename: (name: string) => void;
  readonly onDelete: (name: string) => void;
  readonly onCopy: (path: string) => void;
  readonly onMove: (path: string) => void;
  readonly onExtract: (path: string) => void;
  readonly onNavigate: (path: string) => void;
  readonly onOpenSqlite: (path: string) => void;
  readonly onCalculateFolderSize: (path: string) => void;
  readonly onChmod: (entry: FileEntry) => void;
  readonly onChown: (entry: FileEntry) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const fullPath = joinPath(currentPath, entry.name);
  const isDir = entry.type === 'directory';
  const isEditable = !isDir && !isImageFile(entry.name) && entry.size < 10 * 1024 * 1024;
  const isImage = !isDir && isImageFile(entry.name);
  const isArchive = !isDir && isArchiveFile(entry.name);
  const isSqlite = !isDir && isSqliteFile(entry.name);

  // Position the menu (if from right-click, use mouse pos; if from button, show as dropdown)
  const style: React.CSSProperties = position
    ? { position: 'fixed', left: position.x, top: position.y, zIndex: 100 }
    : { position: 'fixed', right: 40, top: '50%', transform: 'translateY(-50%)', zIndex: 100 };

  const itemClass = "flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700";

  return (
    <>
      <div className="fixed inset-0 z-[99]" onClick={onClose} />
      <div ref={menuRef} style={style} className="min-w-[180px] rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800">
        {isDir && <button className={itemClass} onClick={() => onNavigate(fullPath)}><FolderOpen size={14} /> Open</button>}
        {isDir && <button className={itemClass} onClick={() => onCalculateFolderSize(fullPath)}><Calculator size={14} /> Calculate Folder Size</button>}
        {isImage && <button className={itemClass} onClick={() => onViewImage(fullPath)}><ImageIcon size={14} /> View Image</button>}
        {isEditable && <button className={itemClass} onClick={() => onEdit(fullPath)}><Edit3 size={14} /> Edit</button>}
        {!isDir && <button className={itemClass} onClick={() => onDownload(fullPath)}><Download size={14} /> Download</button>}
        {isArchive && <button className={itemClass} onClick={() => onExtract(fullPath)}><PackageOpen size={14} /> Extract</button>}
        {isSqlite && <button className={itemClass} onClick={() => onOpenSqlite(fullPath)}><Database size={14} /> Open in SQL Manager</button>}
        <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
        <button className={itemClass} onClick={() => onChmod(entry)}><Shield size={14} /> Change Permissions</button>
        <button className={itemClass} onClick={() => onChown(entry)}><UserCheck size={14} /> Change Ownership</button>
        <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
        <button className={itemClass} onClick={() => onCopy(fullPath)}><Copy size={14} /> Copy to...</button>
        <button className={itemClass} onClick={() => onMove(fullPath)}><Move size={14} /> Move to...</button>
        <button className={itemClass} onClick={() => onRename(entry.name)}><Edit3 size={14} /> Rename</button>
        <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
        <button className={`${itemClass} !text-red-600 dark:!text-red-400`} onClick={() => onDelete(entry.name)}><Trash2 size={14} /> Delete</button>
      </div>
    </>
  );
}

function ImageViewer({ path, onClose, onDownload }: { readonly path: string; readonly onClose: () => void; readonly onDownload: () => void }) {
  const blobUrl = useAuthenticatedBlobUrl(path);
  const filename = path.split('/').pop() ?? '';

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm overflow-hidden">
      <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-4 py-2">
        <div className="flex items-center gap-2">
          <ImageIcon size={14} className="text-purple-500" />
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{path}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onDownload} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"><Download size={12} /> Download</button>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><X size={16} /></button>
        </div>
      </div>
      <div className="flex items-center justify-center p-4 min-h-[300px] bg-gray-50 dark:bg-gray-900/50">
        {blobUrl.isLoading && <Loader2 size={24} className="animate-spin text-gray-400" />}
        {blobUrl.error && <p className="text-sm text-red-500">Failed to load image</p>}
        {blobUrl.data && (
          getExtension(filename) === '.svg'
            ? <img src={blobUrl.data} alt={filename} className="max-w-full max-h-[600px] object-contain" />
            : <img src={blobUrl.data} alt={filename} className="max-w-full max-h-[600px] object-contain rounded" />
        )}
      </div>
    </div>
  );
}

function ExtractDialog({
  archivePath, currentPath, currentDirs, onClose,
}: {
  readonly archivePath: string;
  readonly currentPath: string;
  readonly currentDirs: string[];
  readonly onClose: () => void;
}) {
  const [dest, setDest] = useState(currentPath);
  const [status, setStatus] = useState<'idle' | 'extracting' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const extractArchive = useExtractArchive();

  const handleExtract = () => {
    setStatus('extracting');
    extractArchive.mutate({ path: archivePath, destPath: dest }, {
      onSuccess: () => setStatus('done'),
      onError: (err) => { setStatus('error'); setErrorMsg(err instanceof Error ? err.message : 'Extraction failed'); },
    });
  };

  const filename = archivePath.split('/').pop() ?? '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={(e) => { if (e.target === e.currentTarget && status !== 'extracting') onClose(); }}>
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">
          Extract Archive
        </h3>

        {status === 'done' ? (
          <div className="text-center py-4">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
              <Check size={24} className="text-green-600 dark:text-green-400" />
            </div>
            <p className="mt-3 text-sm font-medium text-gray-900 dark:text-gray-100">Extraction complete</p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{filename} extracted to {dest}</p>
            <button onClick={onClose} className="mt-4 rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600">Done</button>
          </div>
        ) : status === 'error' ? (
          <div className="text-center py-4">
            <AlertTriangle size={32} className="mx-auto text-red-400" />
            <p className="mt-2 text-sm text-red-600 dark:text-red-400">{errorMsg}</p>
            <button onClick={onClose} className="mt-4 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">Close</button>
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
              Extract <strong>{filename}</strong> to:
            </p>

            <div className="space-y-2 mb-3">
              <button onClick={() => setDest(currentPath)} className={`w-full text-left px-3 py-2 rounded-lg border text-sm ${dest === currentPath ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20' : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50'}`}>
                Current folder ({currentPath})
              </button>
              {currentDirs.map(dir => {
                const dirPath = joinPath(currentPath, dir);
                return (
                  <button key={dir} onClick={() => setDest(dirPath)} className={`w-full text-left px-3 py-2 rounded-lg border text-sm flex items-center gap-2 ${dest === dirPath ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20' : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50'}`}>
                    <FolderOpen size={14} className="text-amber-500 shrink-0" /> {dir}/
                  </button>
                );
              })}
            </div>

            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">Or enter custom path</label>
              <input type="text" value={dest} onChange={(e) => setDest(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100" />
            </div>

            {status === 'extracting' && (
              <div className="mb-4">
                <div className="flex items-center gap-2 text-sm text-brand-600 dark:text-brand-400">
                  <Loader2 size={14} className="animate-spin" /> Extracting...
                </div>
                <div className="mt-2 h-2 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden">
                  <div className="h-2 rounded-full bg-brand-500 animate-pulse" style={{ width: '70%' }} />
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button onClick={onClose} disabled={status === 'extracting'} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700 disabled:opacity-50">Cancel</button>
              <button onClick={handleExtract} disabled={status === 'extracting' || !dest.trim()} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">
                {status === 'extracting' ? <><Loader2 size={14} className="animate-spin inline mr-1" />Extracting...</> : 'Extract'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function UploadProgressModal({ uploads, onClose }: { readonly uploads: readonly UploadProgress[]; readonly onClose: () => void }) {
  const allDone = uploads.every(u => u.status === 'done' || u.status === 'error' || u.status === 'cancelled');
  const totalFiles = uploads.length;
  const completedFiles = uploads.filter(u => u.status === 'done').length;
  const failedFiles = uploads.filter(u => u.status === 'error').length;
  const cancelledFiles = uploads.filter(u => u.status === 'cancelled').length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={(e) => { if (e.target === e.currentTarget && allDone) onClose(); }}>
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {allDone ? 'Upload Complete' : 'Uploading Files'}
          </h3>
          {allDone && <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"><X size={16} /></button>}
        </div>

        {allDone && (
          <div className="text-center py-2 mb-3">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30">
              <Check size={20} className="text-green-600 dark:text-green-400" />
            </div>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              {completedFiles} of {totalFiles} file{totalFiles > 1 ? 's' : ''} uploaded
              {failedFiles > 0 && <span className="text-red-500"> ({failedFiles} failed)</span>}
              {cancelledFiles > 0 && <span className="text-gray-400"> ({cancelledFiles} cancelled)</span>}
            </p>
          </div>
        )}

        <div className="space-y-2 max-h-60 overflow-y-auto">
          {uploads.map((u, i) => (
            <div key={i} className={`rounded-lg border p-2 ${u.status === 'cancelled' ? 'border-gray-200 dark:border-gray-600 opacity-60' : 'border-gray-100 dark:border-gray-700'}`}>
              <div className="flex items-center justify-between text-sm">
                <span className={`truncate max-w-[200px] ${u.status === 'cancelled' ? 'text-gray-400 dark:text-gray-500 line-through' : 'text-gray-700 dark:text-gray-300'}`}>{u.filename}</span>
                <span className="flex items-center gap-1 text-xs shrink-0 ml-2">
                  {u.status === 'done' && <span className="text-green-600">Done</span>}
                  {u.status === 'error' && <span className="text-red-500">{u.error}</span>}
                  {u.status === 'cancelled' && <span className="text-gray-400">Cancelled</span>}
                  {u.status === 'uploading' && (
                    <>
                      <span className="text-brand-600">{u.percent}%</span>
                      {u.abort && (
                        <button
                          onClick={() => u.abort?.()}
                          className="rounded p-1 text-gray-400 hover:text-red-500 transition-colors"
                          title="Cancel upload"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </>
                  )}
                </span>
              </div>
              {u.status === 'uploading' && (
                <div className="mt-1 h-1.5 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden">
                  <div className="h-1.5 rounded-full bg-brand-500 transition-all" style={{ width: `${u.percent}%` }} />
                </div>
              )}
              {u.status === 'done' && (
                <div className="mt-1 h-1.5 rounded-full bg-green-500" />
              )}
              {u.status === 'cancelled' && (
                <div className="mt-1 h-1.5 rounded-full bg-gray-300 dark:bg-gray-600" />
              )}
            </div>
          ))}
        </div>

        {allDone && (
          <div className="mt-4 flex justify-end">
            <button onClick={onClose} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600">Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

function FileEditor({ path, onClose }: { readonly path: string; readonly onClose: () => void }) {
  const fileContent = useFileContent(path);
  const writeFile = useWriteFile();
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);

  // AI edit state
  const [showAiChat, setShowAiChat] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiModelId, setAiModelId] = useState('');
  const [aiProposal, setAiProposal] = useState<string | null>(null);
  const aiEdit = useAiFileEdit('');
  const aiModels = useAiModels();

  // Chat history (persisted in sessionStorage per file)
  type ChatMsg = { role: 'user' | 'assistant' | 'error'; text: string; tokens?: { input: number; output: number } };
  const chatKey = `ai-chat:${path}`;
  const [chatHistory, setChatHistory] = useState<ChatMsg[]>(() => {
    try { return JSON.parse(sessionStorage.getItem(chatKey) ?? '[]'); } catch { return []; }
  });
  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { sessionStorage.setItem(chatKey, JSON.stringify(chatHistory)); }, [chatHistory, chatKey]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatHistory.length]);

  useEffect(() => {
    if (fileContent.data) { setContent(fileContent.data.content); setDirty(false); }
  }, [fileContent.data]);

  // Auto-select first model
  useEffect(() => {
    if (!aiModelId && aiModels.data?.data?.length) {
      setAiModelId(aiModels.data.data[0].id);
    }
  }, [aiModels.data, aiModelId]);

  const handleSave = useCallback(() => {
    if (!dirty || writeFile.isPending) return;
    writeFile.mutate({ path, content }, { onSuccess: () => setDirty(false) });
  }, [dirty, writeFile, path, content]);

  const handleClose = useCallback(() => {
    if (dirty) { setShowUnsavedDialog(true); } else { onClose(); }
  }, [dirty, onClose]);

  const handleAiSubmit = useCallback(() => {
    if (!aiPrompt.trim() || !aiModelId || aiEdit.loading) return;
    setChatHistory((prev) => [...prev, { role: 'user', text: aiPrompt.trim() }]);
    aiEdit.edit(path, content, aiPrompt.trim(), aiModelId);
    setAiPrompt('');
  }, [aiPrompt, aiModelId, aiEdit, path, content]);

  // When AI result arrives, show the proposal + add to chat
  useEffect(() => {
    if (aiEdit.result?.changes[0]?.modifiedContent) {
      setAiProposal(aiEdit.result.changes[0].modifiedContent);
      setChatHistory((prev) => [...prev, {
        role: 'assistant',
        text: aiEdit.result!.changes[0].summary ?? 'Changes proposed — review the diff above.',
        tokens: aiEdit.result!.tokensUsed,
      }]);
    } else if (aiEdit.result?.changes[0]?.summary) {
      setChatHistory((prev) => [...prev, { role: 'assistant', text: aiEdit.result!.changes[0].summary! }]);
    }
  }, [aiEdit.result]);

  useEffect(() => {
    if (aiEdit.error) {
      setChatHistory((prev) => [...prev, { role: 'error', text: aiEdit.error! }]);
    }
  }, [aiEdit.error]);

  const handleAcceptAi = useCallback(() => {
    if (aiProposal) {
      setContent(aiProposal);
      setDirty(true);
      setAiProposal(null);
      setAiPrompt('');
      aiEdit.clear();
    }
  }, [aiProposal, aiEdit]);

  const handleRejectAi = useCallback(() => {
    setAiProposal(null);
    aiEdit.clear();
  }, [aiEdit]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (aiProposal) handleRejectAi();
        else handleClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave, handleClose, aiProposal, handleRejectAi]);

  const filename = path.split('/').pop() ?? '';
  const language = getLanguage(filename);
  const models = aiModels.data?.data ?? [];
  const isDiffMode = aiProposal !== null;
  const editorHeight = showAiChat ? 'calc(100% - 200px)' : '100%';

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm overflow-hidden flex flex-col" style={{ height: 'calc(100vh - 120px)' }}>
      <div className="flex items-center justify-between border-b border-gray-200 dark:border-gray-700 px-4 py-2.5 shrink-0">
        <div className="flex items-center gap-2">
          <File size={16} className="text-gray-400" />
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{path}</span>
          <span className="rounded-md px-2 py-0.5 text-[10px] font-bold tracking-wide bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400">{language.toUpperCase()}</span>
          {dirty && <span className="rounded-md px-2 py-0.5 text-[10px] font-medium bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400">Modified</span>}
          {isDiffMode && <span className="rounded-md px-2 py-0.5 text-[10px] font-medium bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400">AI Diff</span>}
        </div>
        <div className="flex items-center gap-2">
          {isDiffMode ? (
            <>
              <button onClick={handleAcceptAi} className="inline-flex items-center gap-1.5 rounded-lg bg-green-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-600">
                <Check size={14} /> Accept
              </button>
              <button onClick={handleRejectAi} className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 dark:border-red-700 px-4 py-1.5 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">
                <XIcon size={14} /> Reject
              </button>
            </>
          ) : (
            <button onClick={handleSave} disabled={!dirty || writeFile.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">
              {writeFile.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
            </button>
          )}
          <button onClick={() => setShowAiChat(!showAiChat)}
            className={`rounded-lg p-1.5 transition-colors ${showAiChat ? 'text-purple-500 bg-purple-50 dark:bg-purple-900/20' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
            title="AI Assistant">
            <Sparkles size={18} />
          </button>
          <button onClick={handleClose} className="rounded-lg p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700" title="Close (Esc)"><X size={18} /></button>
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 min-h-0">
        {fileContent.isLoading && <div className="flex items-center justify-center py-20"><Loader2 size={24} className="animate-spin text-gray-400" /></div>}
        {fileContent.data && !isDiffMode && (
          <Editor height="100%" language={language} value={content}
            onChange={(val) => { setContent(val ?? ''); setDirty(true); }}
            theme={document.documentElement.classList.contains('dark') ? 'vs-dark' : 'light'}
            options={{ minimap: { enabled: false }, fontSize: 13, lineNumbers: 'on', scrollBeyondLastLine: false, wordWrap: 'on', tabSize: 2, automaticLayout: true }} />
        )}
        {fileContent.data && isDiffMode && (
          <DiffEditor height="100%" language={language}
            original={content}
            modified={aiProposal}
            theme={document.documentElement.classList.contains('dark') ? 'vs-dark' : 'light'}
            options={{ minimap: { enabled: false }, fontSize: 13, readOnly: true, renderSideBySide: true, automaticLayout: true }} />
        )}
      </div>

      {/* AI Chat Panel */}
      {showAiChat && (
        <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex flex-col shrink-0" style={{ height: '180px' }}>
          {/* Chat history */}
          <div className="flex-1 overflow-y-auto px-4 py-2 space-y-2 min-h-0">
            {chatHistory.length === 0 && (
              <p className="text-xs text-gray-400 py-2 text-center">Ask AI to edit this file. Chat history is preserved during your session.</p>
            )}
            {chatHistory.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-lg px-3 py-1.5 text-xs ${
                  msg.role === 'user'
                    ? 'bg-purple-500 text-white'
                    : msg.role === 'error'
                    ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
                    : 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-600'
                }`}>
                  <p className="whitespace-pre-wrap">{msg.text}</p>
                  {msg.tokens && <p className="text-[10px] opacity-60 mt-1">{msg.tokens.input + msg.tokens.output} tokens</p>}
                </div>
              </div>
            ))}
            {aiEdit.loading && (
              <div className="flex justify-start">
                <div className="rounded-lg px-3 py-1.5 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600">
                  <Loader2 size={14} className="animate-spin text-purple-500" />
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Input area */}
          <div className="border-t border-gray-200 dark:border-gray-700 px-4 py-2">
            {models.length === 0 ? (
              <p className="text-[10px] text-gray-400 text-center py-1">No AI models configured. Go to Admin → Settings → AI to add providers and models.</p>
            ) : (
              <div className="flex gap-2 items-end">
                {models.length > 1 && (
                  <select className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1.5 text-xs text-gray-900 dark:text-gray-100 w-28 shrink-0"
                    value={aiModelId} onChange={(e) => setAiModelId(e.target.value)}>
                    {models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
                  </select>
                )}
                <textarea
                  className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1.5 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500 resize-none"
                  placeholder="Ask AI to edit this file..."
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAiSubmit(); } }}
                  disabled={aiEdit.loading}
                  rows={1}
                  style={{ minHeight: '36px', maxHeight: '80px' }}
                  onInput={(e) => { const t = e.target as HTMLTextAreaElement; t.style.height = '36px'; t.style.height = Math.min(t.scrollHeight, 80) + 'px'; }}
                />
                <button onClick={handleAiSubmit} disabled={!aiPrompt.trim() || aiEdit.loading}
                  className="rounded-lg bg-purple-500 px-4 py-1.5 text-xs font-medium text-white hover:bg-purple-600 disabled:opacity-50 shrink-0 self-end">
                  {aiEdit.loading ? <Loader2 size={14} className="animate-spin" /> : 'Send'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Unsaved changes dialog */}
      {showUnsavedDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={(e) => { if (e.target === e.currentTarget) setShowUnsavedDialog(false); }}>
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">Unsaved Changes</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
              You have unsaved changes to <span className="font-medium text-gray-700 dark:text-gray-300">{filename}</span>. What would you like to do?
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowUnsavedDialog(false)}
                className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
                Cancel
              </button>
              <button onClick={() => { setShowUnsavedDialog(false); onClose(); }}
                className="rounded-lg border border-red-300 dark:border-red-700 px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">
                Discard
              </button>
              <button onClick={() => { writeFile.mutate({ path, content }, { onSuccess: () => { setDirty(false); setShowUnsavedDialog(false); onClose(); } }); }}
                disabled={writeFile.isPending}
                className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">
                {writeFile.isPending ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FolderPickerDialog({
  title, description, initialPath, confirmLabel, isPending, onClose, onConfirm,
}: {
  readonly title: string;
  readonly description: string;
  readonly initialPath: string;
  readonly confirmLabel: string;
  readonly isPending: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (path: string) => void;
}) {
  const [browsePath, setBrowsePath] = useState(initialPath);
  const listing = useDirectoryListing(browsePath, true);
  const folders = listing.data?.entries.filter(e => e.type === 'directory') ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">{title}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">{description}</p>

        {/* Current path breadcrumb */}
        <div className="flex items-center gap-1 text-sm mb-2 overflow-x-auto">
          <button onClick={() => setBrowsePath('/')} className="text-brand-600 hover:underline dark:text-brand-400">/</button>
          {browsePath.split('/').filter(Boolean).map((part, i, arr) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight size={12} className="text-gray-400" />
              <button onClick={() => setBrowsePath('/' + arr.slice(0, i + 1).join('/'))} className="text-brand-600 hover:underline dark:text-brand-400">{part}</button>
            </span>
          ))}
        </div>

        {/* Selected destination */}
        <div className="rounded-lg border-2 border-brand-500 bg-brand-50 dark:bg-brand-900/20 px-3 py-2 mb-3 text-sm font-medium text-brand-700 dark:text-brand-300">
          Destination: {browsePath}
        </div>

        {/* Folder list */}
        <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 mb-3">
          {browsePath !== '/' && (
            <button onClick={() => { const parts = browsePath.split('/').filter(Boolean); parts.pop(); setBrowsePath('/' + parts.join('/')); }}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700">
              <ArrowLeft size={14} className="text-gray-400" /> ..
            </button>
          )}
          {listing.isLoading && <div className="flex items-center justify-center py-4"><Loader2 size={16} className="animate-spin text-gray-400" /></div>}
          {folders.length === 0 && !listing.isLoading && (
            <div className="px-3 py-4 text-sm text-gray-400 text-center">No subfolders</div>
          )}
          {folders.map(f => (
            <button key={f.name} onClick={() => setBrowsePath(joinPath(browsePath, f.name))}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 border-b border-gray-100 dark:border-gray-700 last:border-b-0">
              <FolderOpen size={16} className="text-amber-500 shrink-0" />
              <span className="text-gray-700 dark:text-gray-300">{f.name}</span>
            </button>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">Cancel</button>
          <button onClick={() => onConfirm(browsePath)} disabled={isPending} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">
            {isPending && <Loader2 size={14} className="animate-spin inline mr-1" />}{confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function BulkDeleteDialog({ paths, onClose, onSuccess }: { readonly paths: string[]; readonly onClose: () => void; readonly onSuccess: () => void }) {
  const deleteFile = useDeleteFile();
  const [pending, setPending] = useState(false);

  const handleDelete = async () => {
    setPending(true);
    try { for (const path of paths) await deleteFile.mutateAsync(path); onSuccess(); } finally { setPending(false); }
  };

  return (
    <SimpleDialog title="Delete Selected" onClose={onClose} onConfirm={handleDelete} isPending={pending} confirmLabel="Delete All" destructive>
      <p className="text-sm text-gray-600 dark:text-gray-400">Delete <strong className="text-gray-900 dark:text-gray-100">{paths.length} item{paths.length > 1 ? 's' : ''}</strong>? This cannot be undone.</p>
      <ul className="mt-2 max-h-40 overflow-y-auto text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
        {paths.map(p => <li key={p} className="truncate">{p}</li>)}
      </ul>
    </SimpleDialog>
  );
}

function SimpleDialog({
  title, onClose, onConfirm, isPending, confirmLabel, destructive, children,
}: {
  readonly title: string; readonly onClose: () => void; readonly onConfirm: () => void;
  readonly isPending: boolean; readonly confirmLabel: string; readonly destructive?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl dark:bg-gray-800">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3">{title}</h3>
        {children}
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700">Cancel</button>
          <button onClick={onConfirm} disabled={isPending} className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${destructive ? 'bg-red-600 hover:bg-red-700' : 'bg-brand-500 hover:bg-brand-600'}`}>
            {isPending && <Loader2 size={14} className="animate-spin inline mr-1" />}{confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
