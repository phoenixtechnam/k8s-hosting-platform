import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { X, RotateCw, ShieldAlert, Key, Fingerprint, AlertCircle, Loader2 } from 'lucide-react';
import { useNodeTerminal } from '@/hooks/use-node-terminal';

interface NodeTerminalModalProps {
  readonly nodeName: string;
  readonly onClose: () => void;
}

// Tokyo-Night theme parity with frontend/tenant-panel/src/components/WebTerminal.tsx
const TERMINAL_THEME = {
  background: '#1a1b26',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  selectionBackground: '#364a82',
};

export default function NodeTerminalModal({ nodeName, onClose }: NodeTerminalModalProps) {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const term = useNodeTerminal(nodeName);
  const { connect, send, resize, disconnect, connected, connecting, error, stepUpRequired,
    verifyStepUpPassword, verifyStepUpPasskey } = term;

  // ── Auto-connect on mount; tear down on unmount.
  // Mount the xterm into the DOM first so the connect() onData callback
  // has a place to write into.
  useEffect(() => {
    if (!terminalRef.current) return;
    const x = new Terminal({
      theme: TERMINAL_THEME,
      fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    x.loadAddon(fit);
    x.loadAddon(links);
    x.open(terminalRef.current);
    fit.fit();
    x.onData((data) => send(data));
    xtermRef.current = x;
    fitAddonRef.current = fit;

    const observer = new ResizeObserver(() => {
      fit.fit();
      if (term.connected) resize(x.cols, x.rows);
    });
    observer.observe(terminalRef.current);

    x.writeln('\x1b[90mEstablishing root shell — please wait…\x1b[0m');

    // Kick off the connection. The hook handles step-up internally;
    // when stepUpRequired is set, render the step-up dialog instead.
    void connect((data) => {
      xtermRef.current?.write(data);
    });

    return () => {
      observer.disconnect();
      x.dispose();
      xtermRef.current = null;
      disconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resize the terminal whenever the connection toggles — once we
  // come online, push the current cols/rows to the server.
  useEffect(() => {
    if (connected && xtermRef.current) {
      resize(xtermRef.current.cols, xtermRef.current.rows);
      xtermRef.current.focus();
    }
  }, [connected, resize]);

  const handleClose = useCallback(() => {
    disconnect();
    onClose();
  }, [disconnect, onClose]);

  // ESC closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClose]);

  const handleReconnect = useCallback(() => {
    if (!xtermRef.current) return;
    xtermRef.current.writeln('\r\n\x1b[33mReconnecting…\x1b[0m');
    void connect((data) => xtermRef.current?.write(data));
  }, [connect]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Root terminal on ${nodeName}`}
      className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4"
      data-testid={`node-terminal-modal-${nodeName}`}
    >
      {/* Header — break-glass banner stays sticky so the operator can't miss it. */}
      <div className="flex items-center justify-between gap-3 rounded-t-lg border border-b-0 border-red-600 bg-red-600/20 px-4 py-2 text-red-100">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ShieldAlert size={16} aria-hidden="true" />
          <span data-testid="node-terminal-banner">
            [BREAK-GLASS] root shell on <code className="rounded bg-red-900/40 px-1.5 py-0.5">{nodeName}</code> — every command is audited.
          </span>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill connected={connected} connecting={connecting} hasStepUp={!!stepUpRequired} />
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md p-1.5 text-red-100 hover:bg-red-800/30 focus:outline-none focus:ring-2 focus:ring-red-300"
            aria-label="Close terminal"
            data-testid={`node-terminal-close-${nodeName}`}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Body — either the terminal, the step-up prompt, or an error pane. */}
      <div className="flex-1 overflow-hidden rounded-b-lg border border-t-0 border-red-600 bg-[#1a1b26] p-2">
        {stepUpRequired ? (
          <StepUpDialog
            methods={stepUpRequired.methods}
            onPassword={async (pw) => {
              await verifyStepUpPassword(pw);
              // Caller (the dialog) clears its state; we re-fire connect()
              // once the hook's stepUpRequired drops to null.
            }}
            onPasskey={async () => {
              await verifyStepUpPasskey();
            }}
            error={error}
            onAfterSuccess={handleReconnect}
          />
        ) : error && !connected && !connecting ? (
          <DropPane message={error} onReconnect={handleReconnect} />
        ) : null}
        <div
          ref={terminalRef}
          className="h-full w-full"
          data-testid={`node-terminal-xterm-${nodeName}`}
          style={{ display: stepUpRequired ? 'none' : 'block' }}
        />
      </div>
    </div>
  );
}

function StatusPill({
  connected,
  connecting,
  hasStepUp,
}: { readonly connected: boolean; readonly connecting: boolean; readonly hasStepUp: boolean }) {
  if (hasStepUp) {
    return <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-900/40 px-2.5 py-1 text-xs text-amber-200">
      <Key size={12} aria-hidden="true" /> step-up required
    </span>;
  }
  if (connecting && !connected) {
    return <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-900/40 px-2.5 py-1 text-xs text-blue-200">
      <Loader2 size={12} className="animate-spin" aria-hidden="true" /> connecting…
    </span>;
  }
  if (connected) {
    return <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-900/40 px-2.5 py-1 text-xs text-emerald-200">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> connected
    </span>;
  }
  return <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-700/60 px-2.5 py-1 text-xs text-zinc-300">
    <span className="h-1.5 w-1.5 rounded-full bg-zinc-400" /> disconnected
  </span>;
}

function DropPane({ message, onReconnect }: { readonly message: string; readonly onReconnect: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-zinc-300">
      <div className="flex items-center gap-2 text-amber-300">
        <AlertCircle size={20} aria-hidden="true" />
        <span className="font-semibold">Connection lost</span>
      </div>
      <p className="max-w-md text-center text-sm">{message}</p>
      <button
        type="button"
        onClick={onReconnect}
        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-300"
        data-testid="node-terminal-reconnect"
      >
        <RotateCw size={14} aria-hidden="true" /> Reconnect
      </button>
    </div>
  );
}

interface StepUpDialogProps {
  readonly methods: readonly ('password' | 'passkey')[];
  readonly onPassword: (pw: string) => Promise<void>;
  readonly onPasskey: () => Promise<void>;
  readonly onAfterSuccess: () => void;
  readonly error: string | null;
}

function StepUpDialog({ methods, onPassword, onPasskey, onAfterSuccess, error }: StepUpDialogProps) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState<'password' | 'passkey' | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const canPassword = methods.includes('password');
  const canPasskey = methods.includes('passkey');

  const submitPassword = useCallback(async () => {
    setLocalError(null);
    setSubmitting('password');
    try {
      await onPassword(password);
      setPassword('');
      onAfterSuccess();
    } catch (e) {
      setLocalError((e as Error).message);
    } finally {
      setSubmitting(null);
    }
  }, [password, onPassword, onAfterSuccess]);

  const submitPasskey = useCallback(async () => {
    setLocalError(null);
    setSubmitting('passkey');
    try {
      await onPasskey();
      onAfterSuccess();
    } catch (e) {
      setLocalError((e as Error).message);
    } finally {
      setSubmitting(null);
    }
  }, [onPasskey, onAfterSuccess]);

  return (
    <div className="flex h-full items-center justify-center" data-testid="node-terminal-step-up">
      <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-6 text-zinc-100 shadow-xl">
        <div className="mb-4 flex items-center gap-2">
          <Key size={18} className="text-amber-400" aria-hidden="true" />
          <h2 className="text-lg font-semibold">Re-authenticate to open a root shell</h2>
        </div>
        <p className="mb-4 text-sm text-zinc-400">
          Opening a privileged terminal requires a fresh credential check. Your last
          successful authentication is older than 30 minutes.
        </p>

        {canPassword && (
          <div className="mb-4">
            <label className="mb-1 block text-sm font-medium text-zinc-200" htmlFor="step-up-password">
              Password
            </label>
            <input
              id="step-up-password"
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && password.length > 0) submitPassword(); }}
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
              data-testid="node-terminal-step-up-password-input"
            />
            <button
              type="button"
              onClick={submitPassword}
              disabled={password.length === 0 || submitting !== null}
              className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-60"
              data-testid="node-terminal-step-up-password-submit"
            >
              {submitting === 'password' ? <Loader2 size={14} className="animate-spin" /> : <Key size={14} />}
              Verify password
            </button>
          </div>
        )}

        {canPasskey && (
          <div className="mb-2">
            {canPassword && <div className="my-3 text-center text-xs text-zinc-500">or</div>}
            <button
              type="button"
              onClick={submitPasskey}
              disabled={submitting !== null}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-100 hover:bg-zinc-700 disabled:opacity-60"
              data-testid="node-terminal-step-up-passkey-submit"
            >
              {submitting === 'passkey' ? <Loader2 size={14} className="animate-spin" /> : <Fingerprint size={14} />}
              Verify with passkey
            </button>
          </div>
        )}

        {!canPassword && !canPasskey && (
          <div className="rounded-md bg-rose-900/30 px-3 py-2 text-sm text-rose-200">
            No step-up methods available for your account. Contact a super-admin to enable
            a password or passkey credential.
          </div>
        )}

        {(localError || error) && (
          <div className="mt-3 rounded-md bg-rose-900/30 px-3 py-2 text-xs text-rose-200" data-testid="node-terminal-step-up-error">
            {localError ?? error}
          </div>
        )}
      </div>
    </div>
  );
}
