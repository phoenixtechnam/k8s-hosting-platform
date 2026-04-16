import { useState, useRef, useEffect, useMemo } from 'react';
import { Terminal as TerminalIcon, Pause, Play, Trash2, Download, Search } from 'lucide-react';
import type { LogLine } from '../hooks/use-container-console';
import { useLogStream, useDeploymentComponents } from '../hooks/use-container-console';

const LEVEL_COLORS: Record<string, string> = {
  info: 'text-gray-300',
  warning: 'text-yellow-400',
  error: 'text-red-400',
};

const LEVEL_BADGE: Record<string, string> = {
  info: 'bg-gray-700 text-gray-300',
  warning: 'bg-yellow-900/50 text-yellow-400',
  error: 'bg-red-900/50 text-red-400',
};

const COMPONENT_COLORS = [
  'text-blue-400', 'text-green-400', 'text-purple-400',
  'text-cyan-400', 'text-orange-400', 'text-pink-400',
];

interface LogViewerProps {
  deploymentId: string;
  defaultComponent?: string;
}

export default function LogViewer({ deploymentId, defaultComponent }: LogViewerProps) {
  const { components } = useDeploymentComponents(deploymentId);
  const [selectedComponent, setSelectedComponent] = useState(defaultComponent ?? '*');
  const [paused, setPaused] = useState(false);
  const [levelFilter, setLevelFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);

  const { lines, connected, error, clear, reconnect } = useLogStream(
    deploymentId,
    { component: selectedComponent, tailLines: 200 },
  );

  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const filteredLines = useMemo(() => {
    let result = lines;
    if (levelFilter) result = result.filter((l) => l.level === levelFilter);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((l) => l.text.toLowerCase().includes(q));
    }
    return result;
  }, [lines, levelFilter, searchQuery]);

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

  const handleDownload = () => {
    const text = filteredLines
      .map((l) => `[${l.timestamp}] [${l.component}] [${l.level.toUpperCase()}] ${l.text}`)
      .join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logs-${deploymentId}-${new Date().toISOString().slice(0, 19)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col h-full" data-testid="log-viewer">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        {/* Component selector */}
        <select
          className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm px-2 py-1 text-gray-900 dark:text-gray-100"
          value={selectedComponent}
          onChange={(e) => setSelectedComponent(e.target.value)}
          data-testid="component-selector"
        >
          <option value="*">All components</option>
          {components.map((c) => (
            <option key={c.name} value={c.name}>{c.name} {c.ready ? '' : '(not ready)'}</option>
          ))}
        </select>

        {/* Level filters */}
        <div className="flex gap-1 ml-2">
          {(['info', 'warning', 'error'] as const).map((level) => (
            <button
              key={level}
              onClick={() => setLevelFilter(levelFilter === level ? null : level)}
              className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                levelFilter === level ? LEVEL_BADGE[level] + ' ring-1 ring-white/30' : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
              }`}
            >
              {level.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Actions */}
        <button onClick={() => setShowSearch(!showSearch)} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400" title="Search">
          <Search size={16} />
        </button>
        <button onClick={() => setPaused(!paused)} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400" title={paused ? 'Resume' : 'Pause'}>
          {paused ? <Play size={16} /> : <Pause size={16} />}
        </button>
        <button onClick={clear} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400" title="Clear">
          <Trash2 size={16} />
        </button>
        <button onClick={handleDownload} className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400" title="Download">
          <Download size={16} />
        </button>

        {/* Status */}
        <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} title={connected ? 'Connected' : 'Disconnected'} />
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

      {/* Error banner */}
      {error && (
        <div className="px-3 py-1 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 text-xs">
          {error}
          <button onClick={reconnect} className="ml-2 underline">Reconnect</button>
        </div>
      )}

      {/* Log output */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto bg-gray-900 font-mono text-xs leading-5 p-2"
        data-testid="log-output"
      >
        {filteredLines.length === 0 && !error && (
          <div className="text-gray-500 py-4 text-center">
            {connected ? 'Waiting for logs...' : 'Connecting...'}
          </div>
        )}
        {filteredLines.map((line, i) => (
          <div key={i} className="flex gap-2 hover:bg-gray-800/50 px-1">
            <span className="text-gray-600 shrink-0 select-none">
              {line.timestamp.slice(11, 23)}
            </span>
            {selectedComponent === '*' && (
              <span className={`shrink-0 w-20 truncate ${componentColorMap.get(line.component) ?? 'text-gray-400'}`}>
                {line.component}
              </span>
            )}
            <span className={LEVEL_COLORS[line.level] ?? 'text-gray-300'}>
              {line.text}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Footer */}
      <div className="px-3 py-1 border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-xs text-gray-500 dark:text-gray-400 flex justify-between">
        <span>{filteredLines.length} lines {paused && '(paused)'}</span>
        <span>{selectedComponent === '*' ? 'all components' : selectedComponent}</span>
      </div>
    </div>
  );
}
