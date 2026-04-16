import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { RefreshCw } from 'lucide-react';
import { useTerminal, useDeploymentComponents } from '../hooks/use-container-console';

interface WebTerminalProps {
  deploymentId: string;
  defaultComponent?: string;
}

export default function WebTerminal({ deploymentId, defaultComponent }: WebTerminalProps) {
  const { components } = useDeploymentComponents(deploymentId);
  const [selectedComponent, setSelectedComponent] = useState(defaultComponent ?? '');
  const [shell, setShell] = useState('/bin/sh');

  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const activeComponent = selectedComponent || components[0]?.name || '';

  const { connect, send, resize, disconnect, connected, error } = useTerminal(
    deploymentId,
    { component: activeComponent, shell, enabled: false },
  );

  const startSession = useCallback(() => {
    if (xtermRef.current) {
      xtermRef.current.clear();
    }
    disconnect();
    connect((data) => {
      xtermRef.current?.write(data);
    });
  }, [connect, disconnect]);

  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        selectionBackground: '#364a82',
      },
      fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(terminalRef.current);
    fitAddon.fit();

    term.onData((data) => send(data));

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      resize(term.cols, term.rows);
    });
    observer.observe(terminalRef.current);

    return () => {
      observer.disconnect();
      term.dispose();
      disconnect();
    };
  }, [send, resize, disconnect]);

  useEffect(() => {
    if (activeComponent && !connected) {
      startSession();
    }
  }, [activeComponent, shell, startSession]);

  return (
    <div className="flex flex-col h-full" data-testid="web-terminal">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <select
          className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm px-2 py-1 text-gray-900 dark:text-gray-100"
          value={activeComponent}
          onChange={(e) => setSelectedComponent(e.target.value)}
          data-testid="terminal-component-selector"
        >
          {components.map((c) => (
            <option key={c.name} value={c.name}>{c.name}</option>
          ))}
        </select>

        <select
          className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm px-2 py-1 text-gray-900 dark:text-gray-100"
          value={shell}
          onChange={(e) => setShell(e.target.value)}
        >
          <option value="/bin/sh">/bin/sh</option>
          <option value="/bin/bash">/bin/bash</option>
          <option value="/bin/ash">/bin/ash</option>
        </select>

        <button
          onClick={startSession}
          className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
          title="Reconnect"
        >
          <RefreshCw size={16} />
        </button>

        <div className="flex-1" />

        <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}
          title={connected ? 'Connected' : 'Disconnected'} />
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-3 py-1 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 text-xs">
          {error}
          <button onClick={startSession} className="ml-2 underline">Retry</button>
        </div>
      )}

      {/* Terminal */}
      <div
        ref={terminalRef}
        className="flex-1 bg-[#1a1b26]"
        data-testid="terminal-container"
      />
    </div>
  );
}
