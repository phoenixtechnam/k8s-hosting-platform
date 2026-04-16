import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Pause, Play, Trash2, Download, Search, Radio, Square } from 'lucide-react';
import type { LogLine } from '../hooks/use-container-console';
import { useLogStream, useDeploymentComponents } from '../hooks/use-container-console';
import { useDeploymentLogs } from '../hooks/use-deployments';
import { useClientContext } from '../hooks/use-client-context';

interface UnifiedLogLine {
  source: string;
  text: string;
  timestamp: string;
  level: string;
}

const LEVEL_COLORS: Record<string, string> = {
  info: 'text-gray-300',
  warning: 'text-yellow-400',
  error: 'text-red-400',
};

const SOURCE_COLORS: Record<string, string> = {
  K8S: 'text-blue-400',
  APP: 'text-green-400',
};

const COMPONENT_COLORS = [
  'text-cyan-400', 'text-purple-400', 'text-orange-400', 'text-pink-400',
];

interface LogViewerProps {
  deploymentId: string;
  clientId?: string;
}

export default function LogViewer({ deploymentId, clientId: propClientId }: LogViewerProps) {
  const { clientId: contextClientId } = useClientContext();
  const clientId = propClientId ?? contextClientId;

  const [streaming, setStreaming] = useState(false);
  const [paused, setPaused] = useState(false);
  const [levelFilter, setLevelFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [selectedComponent, setSelectedComponent] = useState('*');

  const { components } = useDeploymentComponents(deploymentId);
  const staticLogs = useDeploymentLogs(clientId ?? undefined, deploymentId, !streaming);
  const { lines: liveLines, connected, error: liveError, disconnect, clear, reconnect } = useLogStream(
    deploymentId,
    { component: selectedComponent, tailLines: 200, enabled: streaming },
  );

  const bottomRef = useRef<HTMLDivElement>(null);

  const startStream = useCallback(() => {
    clear();
    setStreaming(true);
  }, [clear]);

  const stopStream = useCallback(() => {
    disconnect();
    setStreaming(false);
  }, [disconnect]);

  const unifiedLines: readonly UnifiedLogLine[] = useMemo(() => {
    if (streaming) {
      return liveLines.map((l: LogLine) => ({
        source: l.component,
        text: l.text,
        timestamp: l.timestamp,
        level: l.level,
      }));
    }

    const raw = staticLogs.data?.data?.lines ?? [];
    return [...raw].sort((a, b) => {
      const ta = typeof a === 'object' ? (a as UnifiedLogLine).timestamp ?? '' : '';
      const tb = typeof b === 'object' ? (b as UnifiedLogLine).timestamp ?? '' : '';
      return ta.localeCompare(tb);
    }).map((line) => {
      if (typeof line === 'object' && line !== null) {
        const l = line as { source?: string; text?: string; timestamp?: string; level?: string };
        return {
          source: l.source ?? 'APP',
          text: l.text ?? String(line),
          timestamp: l.timestamp ?? '',
          level: l.level ?? 'info',
        };
      }
      return { source: 'APP', text: String(line), timestamp: '', level: 'info' };
    });
  }, [streaming, liveLines, staticLogs.data]);

  const filteredLines = useMemo(() => {
    let result = unifiedLines;
    if (levelFilter) result = result.filter((l) => l.level === levelFilter);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((l) => l.text.toLowerCase().includes(q) || l.source.toLowerCase().includes(q));
    }
    return result;
  }, [unifiedLines, levelFilter, searchQuery]);

  useEffect(() => {
    if (!paused && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [filteredLines.length, paused]);

  const componentColorMap = useMemo(() => {
    const map = new Map<string, string>();
    components.forEach((c, i) => map.set(c.name, COMPONENT_COLORS[i % COMPONENT_COLORS.length]));
    return map;
  }, [components]);

  const sourceColor = (source: string) =>
    SOURCE_COLORS[source] ?? componentColorMap.get(source) ?? 'text-gray-400';

  const handleDownload = () => {
    const text = filteredLines
      .map((l) => `[${l.timestamp}] [${l.source}] [${l.level.toUpperCase()}] ${l.text}`)
      .join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logs-${deploymentId}-${new Date().toISOString().slice(0, 19)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const terminationReason = staticLogs.data?.data?.terminationReason;
  const isLoading = !streaming && staticLogs.isLoading;
  const error = streaming ? liveError : (staticLogs.isError ? 'Failed to load logs' : null);

  return (
    <div className="flex flex-col h-full" data-testid="log-viewer">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        {/* Stream toggle */}
        {streaming ? (
          <button
            onClick={stopStream}
            className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50 transition-colors"
            data-testid="stop-stream"
          >
            <Square size={12} />
            Stop Stream
          </button>
        ) : (
          <button
            onClick={startStream}
            className="inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50 transition-colors"
            data-testid="start-stream"
          >
            <Radio size={12} />
            Stream Live
          </button>
        )}

        {/* Component selector (live mode only) */}
        {streaming && components.length > 1 && (
          <select
            className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-xs px-2 py-1 text-gray-900 dark:text-gray-100"
            value={selectedComponent}
            onChange={(e) => setSelectedComponent(e.target.value)}
            data-testid="component-selector"
          >
            <option value="*">All components</option>
            {components.map((c) => (
              <option key={c.name} value={c.name}>{c.name}</option>
            ))}
          </select>
        )}

        {/* Level filters */}
        <div className="flex gap-1">
          {(['info', 'warning', 'error'] as const).map((level) => (
            <button
              key={level}
              onClick={() => setLevelFilter(levelFilter === level ? null : level)}
              className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                levelFilter === level
                  ? (level === 'error' ? 'bg-red-900/50 text-red-400 ring-1 ring-red-500/30' :
                     level === 'warning' ? 'bg-yellow-900/50 text-yellow-400 ring-1 ring-yellow-500/30' :
                     'bg-gray-700 text-gray-300 ring-1 ring-white/20')
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
              }`}
            >
              {level.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Actions */}
        <button onClick={() => setShowSearch(!showSearch)} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400" title="Search">
          <Search size={14} />
        </button>
        {streaming && (
          <button onClick={() => setPaused(!paused)} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400" title={paused ? 'Resume' : 'Pause'}>
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </button>
        )}
        <button onClick={handleDownload} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400" title="Download">
          <Download size={14} />
        </button>

        {/* Status indicator */}
        {streaming && (
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}
            title={connected ? 'Streaming' : 'Disconnected'} />
        )}
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="px-3 py-1 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
          <input
            type="text"
            placeholder="Filter logs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-transparent text-sm text-gray-900 dark:text-gray-100 outline-none placeholder:text-gray-400"
            autoFocus
          />
        </div>
      )}

      {/* Error / termination banner */}
      {error && (
        <div className="px-3 py-1 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 text-xs">
          {error}
          {streaming && <button onClick={reconnect} className="ml-2 underline">Reconnect</button>}
        </div>
      )}
      {terminationReason && !streaming && (
        <div className="px-3 py-1 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 text-xs font-medium">
          Pod terminated: {terminationReason}
        </div>
      )}

      {/* Log output */}
      <div
        className="flex-1 overflow-y-auto bg-gray-900 font-mono text-xs leading-5 p-2"
        data-testid="log-output"
      >
        {isLoading && (
          <div className="text-gray-500 py-4 text-center">Loading logs...</div>
        )}
        {!isLoading && filteredLines.length === 0 && !error && (
          <div className="text-gray-500 py-4 text-center">
            {streaming ? (connected ? 'Waiting for logs...' : 'Connecting...') : 'No logs available'}
          </div>
        )}
        {filteredLines.map((line, i) => (
          <div key={i} className="flex gap-2 hover:bg-gray-800/50 px-1">
            <span className="text-gray-600 shrink-0 select-none w-20">
              {line.timestamp ? line.timestamp.slice(11, 23) : ''}
            </span>
            <span className={`shrink-0 w-16 truncate ${sourceColor(line.source)}`}>
              {line.source}
            </span>
            <span className={LEVEL_COLORS[line.level] ?? 'text-gray-300'}>
              {line.text}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Footer */}
      <div className="px-3 py-1 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs text-gray-500 dark:text-gray-400 flex justify-between">
        <span>{filteredLines.length} lines {streaming ? (paused ? '(paused)' : '(live)') : '(snapshot)'}</span>
        <span>{streaming && connected ? 'streaming' : ''}</span>
      </div>
    </div>
  );
}
