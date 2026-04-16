import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Play, Square } from 'lucide-react';
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

  const handleConnect = useCallback(() => {
    if (xtermRef.current) {
      xtermRef.current.clear();
      xtermRef.current.writeln('\x1b[33mConnecting...\x1b[0m');
    }
    disconnect();
    connect((data) => {
      xtermRef.current?.write(data);
    });
  }, [connect, disconnect]);

  const handleDisconnect = useCallback(() => {
    disconnect();
    xtermRef.current?.writeln('\r\n\x1b[31mDisconnected.\x1b[0m');
  }, [disconnect]);

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

    term.writeln('\x1b[90mPress Connect to start a terminal session.\x1b[0m');

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      if (connected) resize(term.cols, term.rows);
    });
    observer.observe(terminalRef.current);

    return () => {
      observer.disconnect();
      term.dispose();
      disconnect();
    };
  }, []);

  return (
    <div className="flex flex-col h-full" data-testid="web-terminal">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <select
          className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm px-2 py-1 text-gray-900 dark:text-gray-100"
          value={activeComponent}
          onChange={(e) => setSelectedComponent(e.target.value)}
          disabled={connected}
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
          disabled={connected}
        >
          <option value="/bin/sh">/bin/sh</option>
          <option value="/bin/bash">/bin/bash</option>
          <option value="/bin/ash">/bin/ash</option>
        </select>

        {connected ? (
          <button
            onClick={handleDisconnect}
            className="inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50 transition-colors"
            data-testid="terminal-disconnect"
          >
            <Square size={12} />
            Disconnect
          </button>
        ) : (
          <button
            onClick={handleConnect}
            disabled={!activeComponent}
            className="inline-flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50 transition-colors disabled:opacity-50"
            data-testid="terminal-connect"
          >
            <Play size={12} />
            Connect
          </button>
        )}

        <div className="flex-1" />

        <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-gray-400'}`}
          title={connected ? 'Connected' : 'Disconnected'} />
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-3 py-1 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 text-xs">
          {error}
          <button onClick={handleConnect} className="ml-2 underline">Retry</button>
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
