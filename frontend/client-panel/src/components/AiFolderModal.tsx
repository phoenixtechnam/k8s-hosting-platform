import { useState, useEffect, useCallback } from 'react';
import { Loader2, X, Check, XCircle, Eye, EyeOff, FileText, Sparkles, AlertCircle } from 'lucide-react';
import { useAiFolderPlan, useAiFolderExecute, useAiModels } from '@/hooks/use-ai-editor';
import type { AiEditChange } from '@/hooks/use-ai-editor';
import { useWriteFile } from '@/hooks/use-file-manager';

type Step = 'prompt' | 'planning' | 'reading' | 'executing' | 'review';

interface AiFolderModalProps {
  folderPath: string;
  onClose: () => void;
  onApplied: () => void;
}

export default function AiFolderModal({ folderPath, onClose, onApplied }: AiFolderModalProps) {
  const [step, setStep] = useState<Step>('prompt');
  const [prompt, setPrompt] = useState('');
  const [modelId, setModelId] = useState('');
  const [approved, setApproved] = useState<Set<number>>(new Set());
  const [expandedFile, setExpandedFile] = useState<number | null>(null);
  const [applying, setApplying] = useState(false);

  const aiModels = useAiModels();
  const planner = useAiFolderPlan();
  const executor = useAiFolderExecute();
  const writeFile = useWriteFile();

  const models = aiModels.data?.data ?? [];

  // Auto-select first model
  useEffect(() => {
    if (!modelId && models.length) setModelId(models[0].id);
  }, [models, modelId]);

  const error = planner.error ?? executor.error;
  const changes = executor.result?.changes ?? [];

  // Auto-approve all when changes arrive
  useEffect(() => {
    if (changes.length > 0) {
      setApproved(new Set(changes.map((_, i) => i)));
    }
  }, [changes.length]);

  const handleSubmit = useCallback(async () => {
    if (!prompt.trim() || !modelId) return;
    setStep('planning');

    const planResult = await planner.plan(folderPath, prompt.trim(), modelId);
    if (!planResult) { setStep('prompt'); return; }

    setStep('reading');
    // Brief pause to show the reading step
    await new Promise((r) => setTimeout(r, 500));

    setStep('executing');
    await executor.execute(folderPath, prompt.trim(), modelId, planResult.filesToRead, planResult.plan);
    setStep('review');
  }, [prompt, modelId, folderPath, planner, executor]);

  const handleApplySelected = useCallback(async () => {
    setApplying(true);
    try {
      for (const idx of approved) {
        const change = changes[idx];
        if (change?.modifiedContent != null) {
          await writeFile.mutateAsync({ path: change.path, content: change.modifiedContent });
        }
      }
      onApplied();
      onClose();
    } catch {
      // writeFile error handled by mutation
    } finally {
      setApplying(false);
    }
  }, [approved, changes, writeFile, onApplied, onClose]);

  const toggleFile = (idx: number) => {
    setApproved((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  const approveAll = () => setApproved(new Set(changes.map((_, i) => i)));
  const denyAll = () => setApproved(new Set());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={(e) => { if (e.target === e.currentTarget && step !== 'planning' && step !== 'executing') onClose(); }}>
      <div className="w-full max-w-3xl max-h-[85vh] rounded-xl bg-white dark:bg-gray-800 shadow-xl overflow-hidden flex flex-col">

        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles size={18} className="text-purple-500" />
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">AI Folder Edit</h3>
            </div>
            <button onClick={onClose} disabled={step === 'planning' || step === 'executing'} className="rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30">
              <X size={18} />
            </button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Folder: <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">{folderPath}</code>
          </p>
          {step !== 'prompt' && prompt && (
            <p className="text-sm text-gray-700 dark:text-gray-300 mt-2 italic">"{prompt}"</p>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 min-h-0">

          {/* Step 1: Prompt */}
          {step === 'prompt' && (
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5 block">What would you like to change?</label>
                <textarea
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500 resize-none"
                  placeholder="e.g., Add responsive dark mode to all HTML files, update the navigation menu..."
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && prompt.trim()) { e.preventDefault(); handleSubmit(); } }}
                  rows={3}
                  autoFocus
                />
              </div>
              {models.length > 1 && (
                <div>
                  <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5 block">Model</label>
                  <select className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                    value={modelId} onChange={(e) => setModelId(e.target.value)}>
                    {models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
                  </select>
                </div>
              )}
              {models.length === 0 && (
                <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
                  <AlertCircle size={14} /> No AI models configured. Go to Admin → Settings → AI.
                </div>
              )}
            </div>
          )}

          {/* Step 2: Planning */}
          {step === 'planning' && (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 size={32} className="animate-spin text-purple-500 mb-4" />
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">AI is analyzing your files...</p>
              <p className="text-xs text-gray-400 mt-1">Determining which files need to be modified</p>
            </div>
          )}

          {/* Step 3: Reading */}
          {step === 'reading' && planner.result && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Reading files...</p>
              <div className="space-y-1">
                {planner.result.filesToRead.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-50 dark:bg-blue-900/20">
                    <span className="rounded px-1.5 py-0.5 text-[10px] font-bold bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400">READ</span>
                    <FileText size={14} className="text-blue-500" />
                    <span className="text-sm text-gray-900 dark:text-gray-100">{f}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-2">Plan: {planner.result.plan}</p>
            </div>
          )}

          {/* Step 4: Executing */}
          {step === 'executing' && (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 size={32} className="animate-spin text-purple-500 mb-4" />
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">AI is editing files...</p>
              <p className="text-xs text-gray-400 mt-1">Generating changes for {planner.result?.filesToRead.length ?? 0} file(s)</p>
            </div>
          )}

          {/* Step 5: Review */}
          {step === 'review' && (
            <div className="space-y-3">
              {changes.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-sm text-gray-500 dark:text-gray-400">No changes proposed. Try a different instruction.</p>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      {changes.length} file(s) modified — {approved.size} approved
                    </p>
                    <div className="flex gap-2">
                      <button onClick={approveAll} className="text-xs text-green-600 dark:text-green-400 hover:underline">Approve All</button>
                      <button onClick={denyAll} className="text-xs text-red-600 dark:text-red-400 hover:underline">Deny All</button>
                    </div>
                  </div>

                  {changes.map((change, i) => (
                    <div key={i} className={`rounded-lg border overflow-hidden transition-colors ${
                      approved.has(i) ? 'border-green-300 dark:border-green-700' : 'border-gray-200 dark:border-gray-700 opacity-60'
                    }`}>
                      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-700/50 cursor-pointer"
                        onClick={() => toggleFile(i)}>
                        <input type="checkbox" checked={approved.has(i)} onChange={() => toggleFile(i)}
                          className="rounded border-gray-300 text-green-500 focus:ring-green-500" />
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          change.action === 'create' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                          : change.action === 'delete' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                          : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                        }`}>{change.action.toUpperCase()}</span>
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100 flex-1">{change.path}</span>
                        <button onClick={(e) => { e.stopPropagation(); setExpandedFile(expandedFile === i ? null : i); }}
                          className="rounded p-1 text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600">
                          {expandedFile === i ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                      {expandedFile === i && (
                        <div className="bg-gray-900 p-3 font-mono text-xs text-gray-300 max-h-48 overflow-y-auto whitespace-pre-wrap">
                          {change.modifiedContent?.slice(0, 5000) ?? '(no content)'}
                          {(change.modifiedContent?.length ?? 0) > 5000 && <span className="text-gray-500">... truncated</span>}
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {/* Error display */}
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
          </div>
          <div className="flex gap-2">
            {step === 'prompt' && (
              <>
                <button onClick={onClose} className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
                  Cancel
                </button>
                <button onClick={handleSubmit} disabled={!prompt.trim() || !modelId || models.length === 0}
                  className="rounded-lg bg-purple-500 px-4 py-2 text-sm font-medium text-white hover:bg-purple-600 disabled:opacity-50">
                  Analyze & Edit
                </button>
              </>
            )}
            {step === 'review' && changes.length > 0 && (
              <>
                <button onClick={() => { planner.clear(); executor.clear(); setStep('prompt'); }}
                  className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
                  Try Again
                </button>
                <button onClick={onClose}
                  className="rounded-lg border border-red-300 dark:border-red-700 px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">
                  Deny All
                </button>
                <button onClick={handleApplySelected} disabled={approved.size === 0 || applying}
                  className="rounded-lg bg-green-500 px-4 py-2 text-sm font-medium text-white hover:bg-green-600 disabled:opacity-50">
                  {applying ? <><Loader2 size={14} className="animate-spin inline mr-1" /> Applying...</> : <>
                    <Check size={14} className="inline mr-1" /> Apply {approved.size} file(s)
                  </>}
                </button>
              </>
            )}
            {step === 'review' && changes.length === 0 && (
              <button onClick={onClose} className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
                Close
              </button>
            )}
            {(step === 'planning' || step === 'reading' || step === 'executing') && error && (
              <button onClick={() => setStep('prompt')} className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
                Back
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
