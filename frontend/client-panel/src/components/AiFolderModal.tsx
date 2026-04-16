import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, X, Check, XCircle, Eye, EyeOff, FileText, FolderPlus, Sparkles, AlertCircle, Download, Trash2, ArrowRight } from 'lucide-react';
import { DiffEditor } from '@monaco-editor/react';
import { useAiFolderPlan, useAiFolderExecute, useAiModels, useAiTokenBudget } from '@/hooks/use-ai-editor';
import type { AiEditChange } from '@/hooks/use-ai-editor';
import { useWriteFile, useDeleteFile, useRenameFile } from '@/hooks/use-file-manager';
import { useClientContext } from '@/hooks/use-client-context';
import { config } from '@/lib/runtime-config';

type Step = 'prompt' | 'planning' | 'approve-plan' | 'executing' | 'approve-changes';

const OP_BADGES: Record<string, { label: string; bg: string; icon: typeof FileText }> = {
  read: { label: 'READ', bg: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400', icon: Eye },
  create: { label: 'CREATE', bg: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400', icon: FileText },
  modify: { label: 'MODIFY', bg: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400', icon: FileText },
  delete: { label: 'DELETE', bg: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400', icon: Trash2 },
  rename: { label: 'RENAME', bg: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400', icon: ArrowRight },
  download: { label: 'DOWNLOAD', bg: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-400', icon: Download },
  mkdir: { label: 'MKDIR', bg: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-400', icon: FolderPlus },
};

interface AiFolderModalProps {
  folderPath: string;
  onClose: () => void;
  onApplied: () => void;
}

export default function AiFolderModal({ folderPath, onClose, onApplied }: AiFolderModalProps) {
  const [step, setStep] = useState<Step>('prompt');
  const [prompt, setPrompt] = useState('');
  const [modelId, setModelId] = useState(() => localStorage.getItem('ai-model-id') ?? '');
  const [selectedOps, setSelectedOps] = useState<Set<number>>(new Set());
  const [selectedChanges, setSelectedChanges] = useState<Set<number>>(new Set());
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);
  const [progressLog, setProgressLog] = useState<string[]>([]);

  const { clientId } = useClientContext();
  const aiModels = useAiModels();
  const aiBudget = useAiTokenBudget();
  const planner = useAiFolderPlan();
  const executor = useAiFolderExecute();
  const writeFile = useWriteFile();
  const deleteFile = useDeleteFile();
  const renameFile = useRenameFile();

  const models = aiModels.data?.data ?? [];
  const error = planner.error ?? executor.error;
  const operations = planner.result?.operations ?? [];
  const changes = executor.result?.changes ?? [];

  useEffect(() => {
    if (models.length) {
      const savedId = modelId || localStorage.getItem('ai-model-id') || '';
      const savedValid = models.some((m) => m.id === savedId);
      if (!savedValid) {
        const defaultModel = models.find((m) => m.isDefault) ?? models[0];
        setModelId(defaultModel.id);
        localStorage.setItem('ai-model-id', defaultModel.id);
      }
    }
  }, [models, modelId]);
  useEffect(() => { setSelectedOps(new Set(operations.map((_, i) => i))); }, [operations.length]);
  useEffect(() => { setSelectedChanges(new Set(changes.map((_, i) => i))); setExpandedIdx(null); }, [changes.length]);

  const addLog = useCallback((msg: string) => setProgressLog((prev) => [...prev, msg]), []);

  const handleSubmit = useCallback(async () => {
    if (!prompt.trim() || !modelId) return;
    setProgressLog([]);
    setStep('planning');
    addLog('Analyzing files and creating plan...');
    const result = await planner.plan(folderPath, prompt.trim(), modelId);
    if (!result) { setStep('prompt'); return; }
    addLog(`Plan ready: ${result.operations.length} operations`);
    setStep('approve-plan');
  }, [prompt, modelId, folderPath, planner, addLog]);

  const handleExecute = useCallback(async () => {
    if (!planner.result) return;
    const approvedOps = planner.result.operations.filter((_, i) => selectedOps.has(i));
    if (approvedOps.length === 0) return;

    setStep('executing');
    const readOps = approvedOps.filter((o) => o.op === 'read');
    const modifyOps = approvedOps.filter((o) => o.op === 'modify');
    const createOps = approvedOps.filter((o) => o.op === 'create');
    const otherOps = approvedOps.filter((o) => !['read', 'modify', 'create'].includes(o.op));

    if (readOps.length) addLog(`Reading ${readOps.length} file(s)...`);
    if (modifyOps.length) addLog(`Will modify ${modifyOps.length} file(s)...`);
    if (createOps.length) addLog(`Will create ${createOps.length} file(s)...`);
    if (otherOps.length) addLog(`${otherOps.length} additional operation(s)`);

    await executor.execute(
      folderPath, prompt.trim(), modelId,
      approvedOps, planner.result.plan,
    );
    addLog(`Done — ${executor.result?.changes.length ?? 0} changes proposed`);
    setStep('approve-changes');
  }, [planner.result, selectedOps, folderPath, prompt, modelId, executor, addLog]);

  const handleApply = useCallback(async () => {
    setApplying(true);
    try {
      const approvedChanges = changes.filter((_, i) => selectedChanges.has(i));
      for (let i = 0; i < approvedChanges.length; i++) {
        const change = approvedChanges[i];
        addLog(`Applying ${i + 1}/${approvedChanges.length}: ${change.path}`);

        if (change.action === 'delete') {
          await deleteFile.mutateAsync(change.path);
        } else if (change.action === 'modify' && change.summary?.startsWith('Rename →')) {
          const toPath = change.modifiedContent ?? '';
          await renameFile.mutateAsync({ oldPath: change.path, newPath: toPath });
        } else if (change.action === 'create' && change.modifiedContent?.startsWith('__DOWNLOAD__:')) {
          const url = change.modifiedContent.slice('__DOWNLOAD__:'.length);
          addLog(`Downloading ${url}...`);
          const token = localStorage.getItem('auth_token');
          const base = config.API_URL || '';
          await fetch(`${base}/api/v1/clients/${clientId}/files/fetch-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ url, path: change.path }),
          });
        } else if (change.action === 'create' && change.summary === 'Create directory') {
          // mkdir via write empty file then delete? Actually just skip — dirs created by write
        } else if (change.modifiedContent != null) {
          await writeFile.mutateAsync({ path: change.path, content: change.modifiedContent });
        }
      }
      addLog(`Applied ${approvedChanges.length} change(s)`);
      onApplied();
      onClose();
    } catch (err) {
      addLog(`Error: ${err instanceof Error ? err.message : 'Failed'}`);
    } finally {
      setApplying(false);
    }
  }, [changes, selectedChanges, deleteFile, renameFile, writeFile, clientId, addLog, onApplied, onClose]);

  const toggleOp = (i: number) => setSelectedOps((prev) => { const s = new Set(prev); if (s.has(i)) s.delete(i); else s.add(i); return s; });
  const toggleChange = (i: number) => setSelectedChanges((prev) => { const s = new Set(prev); if (s.has(i)) s.delete(i); else s.add(i); return s; });

  const canClose = step !== 'planning' && step !== 'executing' && !applying;
  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={(e) => { if (e.target === e.currentTarget && canClose) onClose(); }}>
      <div className="w-full max-w-4xl max-h-[90vh] rounded-xl bg-white dark:bg-gray-800 shadow-xl overflow-hidden flex flex-col">

        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles size={18} className="text-purple-500" />
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">AI Folder Edit</h3>
            </div>
            <button onClick={onClose} disabled={!canClose} className="rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30"><X size={18} /></button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Folder: <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">{folderPath}</code>
          </p>
          {step !== 'prompt' && prompt && <p className="text-sm text-gray-700 dark:text-gray-300 mt-2 italic">"{prompt}"</p>}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 min-h-0">

          {/* Prompt */}
          {step === 'prompt' && (
            <div className="space-y-4">
              <textarea className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500 resize-none"
                placeholder="e.g., Create a responsive portfolio site with gallery, about, and contact pages..."
                value={prompt} onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && prompt.trim()) { e.preventDefault(); handleSubmit(); } }}
                rows={3} autoFocus />
              {models.length > 1 && (
                <select className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                  value={modelId} onChange={(e) => { setModelId(e.target.value); localStorage.setItem('ai-model-id', e.target.value); }}>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
                </select>
              )}
              {models.length === 0 && <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400"><AlertCircle size={14} /> No AI models configured.</div>}
            </div>
          )}

          {/* Planning spinner */}
          {step === 'planning' && (
            <div className="flex flex-col items-center justify-center py-8">
              <Loader2 size={32} className="animate-spin text-purple-500 mb-4" />
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">AI is analyzing your files...</p>
            </div>
          )}

          {/* Approve plan — per-op checkboxes */}
          {step === 'approve-plan' && operations.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {operations.length} operations planned — {selectedOps.size} selected
                </p>
                <div className="flex gap-3">
                  <button onClick={() => setSelectedOps(new Set(operations.map((_, i) => i)))} className="text-xs text-green-600 dark:text-green-400 hover:underline">Select All</button>
                  <button onClick={() => setSelectedOps(new Set())} className="text-xs text-red-600 dark:text-red-400 hover:underline">Deny All</button>
                </div>
              </div>
              {planner.result?.plan && (
                <div className="rounded-lg bg-gray-50 dark:bg-gray-700/50 px-3 py-2 text-sm text-gray-700 dark:text-gray-300">{planner.result.plan}</div>
              )}
              <div className="space-y-1">
                {operations.map((op, i) => {
                  const badge = OP_BADGES[op.op] ?? OP_BADGES.read;
                  const BadgeIcon = badge.icon;
                  const path = 'path' in op ? (op as { path: string }).path : ('from' in op ? `${(op as { from: string }).from} → ${(op as { to: string }).to}` : '');
                  const url = 'url' in op ? (op as { url: string }).url : null;
                  return (
                    <div key={i} className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${selectedOps.has(i) ? 'bg-gray-50 dark:bg-gray-700/50' : 'bg-gray-50/50 dark:bg-gray-800/30 opacity-50'}`}>
                      <input type="checkbox" checked={selectedOps.has(i)} onChange={() => toggleOp(i)}
                        className="rounded border-gray-300 text-purple-500 focus:ring-purple-500 shrink-0" />
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${badge.bg}`}>{badge.label}</span>
                      <BadgeIcon size={14} className="text-gray-400 shrink-0" />
                      <span className="text-sm text-gray-900 dark:text-gray-100 truncate">{path}</span>
                      {url && <span className="text-xs text-gray-400 truncate ml-auto">{url}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Executing with progress log */}
          {step === 'executing' && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 py-4">
                <Loader2 size={24} className="animate-spin text-purple-500 shrink-0" />
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">AI is generating changes...</p>
              </div>
              <div className="rounded-lg bg-gray-900 p-3 font-mono text-xs text-gray-300 max-h-40 overflow-y-auto">
                {progressLog.map((msg, i) => (
                  <div key={i} className="py-0.5">
                    <span className="text-green-400 mr-1">{i === progressLog.length - 1 ? '⟳' : '✓'}</span> {msg}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Approve changes — per-file with diff viewer */}
          {step === 'approve-changes' && (
            <div className="space-y-3">
              {changes.length === 0 ? (
                <div className="text-center py-8 text-sm text-gray-500 dark:text-gray-400">No changes proposed. Try a different instruction.</div>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      {changes.length} change(s) — {selectedChanges.size} approved
                    </p>
                    <div className="flex gap-3">
                      <button onClick={() => setSelectedChanges(new Set(changes.map((_, i) => i)))} className="text-xs text-green-600 dark:text-green-400 hover:underline">Select All</button>
                      <button onClick={() => setSelectedChanges(new Set())} className="text-xs text-red-600 dark:text-red-400 hover:underline">Deny All</button>
                    </div>
                  </div>

                  {/* Delete operations highlighted */}
                  {changes.some((c) => c.action === 'delete') && (
                    <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10 p-2">
                      <p className="text-xs font-medium text-red-700 dark:text-red-400 mb-1">Destructive operations:</p>
                      {changes.map((c, i) => c.action === 'delete' && (
                        <div key={i} className="flex items-center gap-2 px-2 py-1">
                          <input type="checkbox" checked={selectedChanges.has(i)} onChange={() => toggleChange(i)}
                            className="rounded border-red-300 text-red-500 focus:ring-red-500 shrink-0" />
                          <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400">DELETE</span>
                          <Trash2 size={14} className="text-red-400" />
                          <span className="text-sm text-red-700 dark:text-red-400">{c.path}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Non-delete changes */}
                  {changes.map((change, i) => {
                    if (change.action === 'delete') return null;
                    const isDownload = change.modifiedContent?.startsWith('__DOWNLOAD__:');
                    const isRename = change.summary?.startsWith('Rename →');
                    const isMkdir = change.summary === 'Create directory';
                    const isExpanded = expandedIdx === i;
                    const showDiff = change.action === 'modify' && change.originalContent && change.modifiedContent && !isRename;

                    return (
                      <div key={i} className={`rounded-lg border overflow-hidden transition-colors ${
                        selectedChanges.has(i) ? 'border-gray-200 dark:border-gray-700' : 'border-gray-200 dark:border-gray-700 opacity-50'
                      }`}>
                        <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-700/50">
                          <input type="checkbox" checked={selectedChanges.has(i)} onChange={() => toggleChange(i)}
                            className="rounded border-gray-300 text-green-500 focus:ring-green-500 shrink-0" />
                          <div className="flex items-center gap-2 flex-1 cursor-pointer min-w-0"
                            onClick={() => setExpandedIdx(isExpanded ? null : i)}>
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold shrink-0 ${
                              change.action === 'create' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                              : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                            }`}>{isDownload ? 'DOWNLOAD' : isRename ? 'RENAME' : isMkdir ? 'MKDIR' : change.action.toUpperCase()}</span>
                            <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{change.path}</span>
                            {change.summary && <span className="text-xs text-gray-400 truncate">{change.summary}</span>}
                          </div>
                          <button onClick={() => setExpandedIdx(isExpanded ? null : i)}
                            className="rounded p-1 text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600 shrink-0">
                            {isExpanded ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>

                        {/* Expanded view */}
                        {isExpanded && showDiff && (
                          <div style={{ height: '300px' }}>
                            <DiffEditor
                              original={change.originalContent ?? ''}
                              modified={change.modifiedContent ?? ''}
                              language={getLanguageFromPath(change.path)}
                              theme={isDark ? 'vs-dark' : 'light'}
                              options={{ minimap: { enabled: false }, fontSize: 12, readOnly: true, renderSideBySide: true, automaticLayout: true }}
                              height="100%"
                            />
                          </div>
                        )}
                        {isExpanded && !showDiff && change.modifiedContent && !isDownload && (
                          <div className="bg-gray-900 p-3 font-mono text-xs text-gray-300 max-h-64 overflow-y-auto whitespace-pre-wrap">
                            {change.modifiedContent.slice(0, 5000)}
                            {change.modifiedContent.length > 5000 && <span className="text-gray-500">... truncated</span>}
                          </div>
                        )}
                        {isExpanded && isDownload && (
                          <div className="px-3 py-2 bg-cyan-50 dark:bg-cyan-900/10 text-xs text-cyan-700 dark:text-cyan-400">
                            Source: {change.modifiedContent?.slice('__DOWNLOAD__:'.length)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          )}

          {/* Progress log (visible during apply) */}
          {applying && (
            <div className="mt-4 rounded-lg bg-gray-900 p-3 font-mono text-xs text-gray-300 max-h-40 overflow-y-auto">
              {progressLog.map((msg, i) => (
                <div key={i} className="py-0.5"><span className="text-green-400 mr-1">✓</span> {msg}</div>
              ))}
            </div>
          )}

          {error && (
            <div className="mt-4 flex items-center gap-2 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-400">
              <XCircle size={14} /> {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 shrink-0 flex justify-between items-center">
          <div className="text-xs text-gray-400">
            {planner.result?.tokensUsed && `Plan: ${planner.result.tokensUsed.input + planner.result.tokensUsed.output} tokens`}
            {executor.result?.tokensUsed && ` | Execute: ${executor.result.tokensUsed.input + executor.result.tokensUsed.output} tokens`}
            {aiBudget.data?.data && (
              <span className="ml-2">
                | Budget: {aiBudget.data.data.percentUsed}% ({(aiBudget.data.data.tokensUsed / 1000).toFixed(0)}k / {(aiBudget.data.data.tokenLimit / 1000).toFixed(0)}k)
                {aiBudget.data.data.exhausted && <span className="text-red-500 ml-1">Exhausted</span>}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {step === 'prompt' && (
              <>
                <button onClick={onClose} className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">Cancel</button>
                <button onClick={handleSubmit} disabled={!prompt.trim() || !modelId || models.length === 0}
                  className="rounded-lg bg-purple-500 px-4 py-2 text-sm font-medium text-white hover:bg-purple-600 disabled:opacity-50">Analyze & Edit</button>
              </>
            )}
            {step === 'approve-plan' && (
              <>
                <button onClick={() => { planner.clear(); setStep('prompt'); }} className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">Cancel</button>
                <button onClick={handleExecute} disabled={selectedOps.size === 0}
                  className="rounded-lg bg-purple-500 px-4 py-2 text-sm font-medium text-white hover:bg-purple-600 disabled:opacity-50">
                  Approve Selected ({selectedOps.size})
                </button>
              </>
            )}
            {step === 'approve-changes' && changes.length > 0 && (
              <>
                <button onClick={() => { planner.clear(); executor.clear(); setStep('prompt'); setProgressLog([]); }}
                  className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">Try Again</button>
                <button onClick={onClose} className="rounded-lg border border-red-300 dark:border-red-700 px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">Deny All</button>
                <button onClick={handleApply} disabled={selectedChanges.size === 0 || applying}
                  className="rounded-lg bg-green-500 px-4 py-2 text-sm font-medium text-white hover:bg-green-600 disabled:opacity-50">
                  {applying ? <><Loader2 size={14} className="animate-spin inline mr-1" /> Applying...</> : <>
                    <Check size={14} className="inline mr-1" /> Apply {selectedChanges.size} change(s)
                  </>}
                </button>
              </>
            )}
            {step === 'approve-changes' && changes.length === 0 && (
              <button onClick={onClose} className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">Close</button>
            )}
            {(step === 'planning' || step === 'executing') && error && (
              <button onClick={() => setStep('prompt')} className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">Back</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    html: 'html', htm: 'html',
    css: 'css', scss: 'scss',
    json: 'json', md: 'markdown',
    php: 'php', py: 'python',
    sh: 'shell', bash: 'shell',
    xml: 'xml', svg: 'xml',
    yaml: 'yaml', yml: 'yaml',
  };
  return map[ext] ?? 'plaintext';
}
