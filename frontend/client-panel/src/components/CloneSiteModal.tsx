import { useState, useRef, useEffect } from 'react';
import { Loader2, X, Globe, CheckCircle, XCircle, FileText, Image as ImageIcon } from 'lucide-react';
import { useClientContext } from '@/hooks/use-client-context';
import { config } from '@/lib/runtime-config';

interface CloneSiteModalProps {
  currentPath: string;
  onClose: () => void;
  onComplete: () => void;
}

interface ProgressEvent {
  type: string;
  message?: string;
  url?: string;
  path?: string;
  pagesDownloaded?: number;
  assetsDownloaded?: number;
  totalDiscovered?: number;
  totalFiles?: number;
  current?: number;
  total?: number;
  depth?: number;
  size?: number;
}

export default function CloneSiteModal({ currentPath, onClose, onComplete }: CloneSiteModalProps) {
  const { clientId } = useClientContext();
  const [url, setUrl] = useState('');
  const [destFolder, setDestFolder] = useState('');
  const [maxPages, setMaxPages] = useState(50);
  const [maxDepth, setMaxDepth] = useState(3);
  const [cloning, setCloning] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [stats, setStats] = useState({ pages: 0, assets: 0, currentUrl: '' });
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight); }, [events.length]);

  const handleClone = async () => {
    if (!url.trim() || !clientId) return;
    setCloning(true);
    setError(null);
    setEvents([]);
    setCompleted(false);
    setStats({ pages: 0, assets: 0, currentUrl: '' });

    const abortCtrl = new AbortController();
    abortRef.current = abortCtrl;

    try {
      const folder = destFolder.trim() || new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '-');
      const destPath = `${currentPath}/${folder}`.replace(/\/\//g, '/');
      const token = localStorage.getItem('auth_token');
      const base = config.API_URL || '';

      const response = await fetch(`${base}/api/v1/clients/${clientId}/files/clone-site`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ url: url.trim(), path: destPath, maxPages, maxDepth }),
        signal: abortCtrl.signal,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: { message: response.statusText } }));
        throw new Error(err.error?.message ?? 'Clone failed');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line) as ProgressEvent;
            setEvents((prev) => [...prev.slice(-200), evt]);

            if (evt.type === 'page') {
              setStats((s) => ({ ...s, pages: evt.pagesDownloaded ?? s.pages, currentUrl: evt.url ?? '' }));
            } else if (evt.type === 'asset') {
              setStats((s) => ({ ...s, assets: (evt.current ?? s.assets), currentUrl: evt.url ?? '' }));
            } else if (evt.type === 'crawling') {
              setStats((s) => ({ ...s, currentUrl: evt.url ?? '' }));
            } else if (evt.type === 'complete') {
              setStats({ pages: evt.pagesDownloaded ?? 0, assets: evt.assetsDownloaded ?? 0, currentUrl: '' });
              setCompleted(true);
            } else if (evt.type === 'error') {
              setError(evt.message ?? 'Unknown error');
            }
          } catch { /* skip parse errors */ }
        }
      }

      if (!error) { setCompleted(true); onComplete(); }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('Clone aborted');
      } else {
        setError(err instanceof Error ? err.message : 'Clone failed');
      }
    } finally {
      setCloning(false);
      abortRef.current = null;
    }
  };

  const canClose = !cloning;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={(e) => { if (e.target === e.currentTarget && canClose) onClose(); }}>
      <div className="w-full max-w-2xl max-h-[85vh] rounded-xl bg-white dark:bg-gray-800 shadow-xl overflow-hidden flex flex-col">

        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Globe size={18} className="text-brand-500" />
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Clone Website</h3>
            </div>
            <button onClick={() => { if (cloning) abortRef.current?.abort(); else onClose(); }}
              className="rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
              <X size={18} />
            </button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Download an entire website with all pages and assets for local hosting
          </p>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 min-h-0 space-y-4">

          {/* Form (shown when not cloning) */}
          {!cloning && !completed && (
            <>
              <div>
                <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">Website URL</label>
                <input className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400"
                  value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" autoFocus />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">Destination folder (optional)</label>
                <input className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400"
                  value={destFolder} onChange={(e) => setDestFolder(e.target.value)} placeholder="Auto-detect from domain" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">Max pages</label>
                  <input type="number" min={1} max={500}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                    value={maxPages} onChange={(e) => setMaxPages(parseInt(e.target.value) || 50)} />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">Max depth</label>
                  <input type="number" min={1} max={10}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
                    value={maxDepth} onChange={(e) => setMaxDepth(parseInt(e.target.value) || 3)} />
                </div>
              </div>
            </>
          )}

          {/* Progress (shown while cloning) */}
          {(cloning || completed) && (
            <>
              {/* Stats bar */}
              <div className="flex items-center gap-4 text-sm">
                <div className="flex items-center gap-1.5 text-blue-600 dark:text-blue-400">
                  <FileText size={14} />
                  <span className="font-medium">{stats.pages}</span>
                  <span className="text-gray-500 dark:text-gray-400">pages</span>
                </div>
                <div className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
                  <ImageIcon size={14} />
                  <span className="font-medium">{stats.assets}</span>
                  <span className="text-gray-500 dark:text-gray-400">assets</span>
                </div>
                {cloning && (
                  <div className="flex items-center gap-1.5 text-purple-500">
                    <Loader2 size={14} className="animate-spin" />
                    <span className="text-xs">Cloning...</span>
                  </div>
                )}
                {completed && !error && (
                  <div className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
                    <CheckCircle size={14} />
                    <span className="text-xs font-medium">Complete</span>
                  </div>
                )}
              </div>

              {/* Current URL */}
              {stats.currentUrl && cloning && (
                <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {stats.currentUrl}
                </div>
              )}

              {/* Progress log */}
              <div ref={logRef} className="rounded-lg bg-gray-900 p-3 font-mono text-xs text-gray-300 max-h-64 overflow-y-auto">
                {events.map((evt, i) => (
                  <div key={i} className="py-0.5 flex gap-2">
                    {evt.type === 'page' && <><span className="text-blue-400 shrink-0">PAGE</span><span className="truncate">{evt.path}</span></>}
                    {evt.type === 'asset' && <><span className="text-green-400 shrink-0">ASSET</span><span className="text-gray-500">[{evt.current}/{evt.total}]</span><span className="truncate">{evt.path}</span></>}
                    {evt.type === 'crawling' && <><span className="text-yellow-400 shrink-0">SCAN</span><span className="truncate">{evt.url}</span></>}
                    {evt.type === 'status' && <><span className="text-purple-400 shrink-0">INFO</span><span>{evt.message}</span></>}
                    {evt.type === 'complete' && <><span className="text-green-400 shrink-0">DONE</span><span>{evt.message}</span></>}
                    {evt.type === 'error' && <><span className="text-red-400 shrink-0">ERR</span><span className="text-red-300">{evt.message}</span></>}
                  </div>
                ))}
                {events.length === 0 && cloning && <span className="text-gray-500">Starting...</span>}
              </div>
            </>
          )}

          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-700 dark:text-red-400">
              <XCircle size={14} /> {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 shrink-0 flex justify-end gap-2">
          {!cloning && !completed && (
            <>
              <button onClick={onClose} className="rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">Cancel</button>
              <button onClick={handleClone} disabled={!url.trim()}
                className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">
                <Globe size={14} className="inline mr-1" /> Clone Website
              </button>
            </>
          )}
          {cloning && (
            <button onClick={() => abortRef.current?.abort()}
              className="rounded-lg border border-red-300 dark:border-red-700 px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">
              Abort
            </button>
          )}
          {completed && (
            <button onClick={onClose} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600">
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
