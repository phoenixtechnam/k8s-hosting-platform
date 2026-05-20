import { useCallback, useEffect, useRef, useState } from 'react';
import {
  X, RotateCw, Key, Fingerprint, AlertCircle, Loader2,
  Maximize2, Minimize2, Terminal as TerminalIcon,
} from 'lucide-react';
import { useTerminalSessions, type StepUpMethod } from '@/stores/terminal-sessions';

interface NodeTerminalModalProps {
  readonly sessionId: string;
  readonly nodeName: string;
}

// Capitalize the first character so a node name like `k8s-local` renders
// as `K8s-local` in the title (operator request — node names are
// case-insensitive identifiers so this is purely cosmetic).
export function titleCase(name: string): string {
  if (!name) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Visible shell of an active terminal session. The xterm Terminal +
 * WebSocket live in the terminal-sessions store; this component is just
 * a viewport that appendChild's the session's DOM host into its body.
 *
 * Mount = move host into modal. Unmount (close OR minimize) = move host
 * back to the graveyard.
 */
export function NodeTerminalModal({ sessionId, nodeName }: NodeTerminalModalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  // Individual selectors — object-returning selectors trigger zustand v5's
  // reference-identity check on every render, causing an infinite loop.
  const attach = useTerminalSessions((s) => s.attach);
  const detach = useTerminalSessions((s) => s.detach);
  const fit = useTerminalSessions((s) => s.fit);
  const minimize = useTerminalSessions((s) => s.minimize);
  const terminate = useTerminalSessions((s) => s.terminate);
  const reconnect = useTerminalSessions((s) => s.reconnect);
  // Subscribe to this specific session's WS status (connecting /
  // connected / disconnected). Drives the title-bar status pill +
  // Reconnect button visibility.
  const status = useTerminalSessions(
    (s) => s.sessions.find((sess) => sess.id === sessionId)?.status ?? 'connecting',
  );

  // ── Attach xterm host on mount; detach on unmount.
  //
  // Depends on `status` too, NOT only sessionId. Reason: on a page
  // reload, restoreFromStorage seeds sessions in 'connecting' status
  // BEFORE the POST /ws-token + buildTerminal completes. At first mount
  // sessionRefs has no entry yet, so attach() early-returns (no host
  // element to move). Once the WS opens and bindWsLifecycle flips
  // status to 'connected', sessionRefs IS populated — this effect
  // re-runs and now attach() succeeds. Without this dep, the modal
  // would render an empty xterm pane until the next navigation.
  useEffect(() => {
    if (!containerRef.current) return;
    attach(sessionId, containerRef.current);
    // ResizeObserver — refits xterm whenever the container's box changes
    // (modal switches centered ↔ maximized, browser window resize, etc.).
    const ro = new ResizeObserver(() => fit(sessionId));
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      detach(sessionId);
    };
    // status included intentionally — see comment above. attach/detach/fit
    // are stable zustand actions; including them would not change behaviour
    // but ESLint can't verify zustand stability so we omit them.
  }, [sessionId, status]);

  // ── Re-fit when isMaximized toggles. The ResizeObserver eventually
  // catches it, but we kick fit on the next rAF for a snappy switch.
  useEffect(() => {
    const f = requestAnimationFrame(() => fit(sessionId));
    return () => cancelAnimationFrame(f);
  }, [isMaximized, sessionId, fit]);

  const handleClose = useCallback(() => terminate(sessionId), [terminate, sessionId]);
  const handleMinimize = useCallback(() => minimize(sessionId), [minimize, sessionId]);

  // ESC closes (terminates) the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClose]);

  const modalSizeClass = isMaximized
    ? 'h-screen w-screen rounded-none border-0'
    : 'h-[85vh] w-full max-w-5xl rounded-lg border border-zinc-700';

  return (
    <div
      className={
        isMaximized
          ? 'fixed inset-0 z-[60] flex'
          : 'fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm'
      }
      onClick={(e) => { if (!isMaximized && e.target === e.currentTarget) handleMinimize(); }}
      data-testid={`node-terminal-backdrop-${nodeName}`}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Root terminal on ${nodeName}`}
        className={`flex ${modalSizeClass} flex-col overflow-hidden shadow-2xl`}
        data-testid={`node-terminal-modal-${nodeName}`}
      >
        {/* Title bar — terminal icon, capitalized node name, status pill,
            window controls. Audit reminder kept as the operator-facing copy. */}
        <div className="flex items-center justify-between gap-3 border-b border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-200">
          <div className="flex items-center gap-2 text-sm font-medium">
            <TerminalIcon size={16} aria-hidden="true" className="text-zinc-400" />
            <span data-testid="node-terminal-banner">
              <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-100">{titleCase(nodeName)}</code>
              {' '}root shell — every command is audited.
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <StatusPill status={status} nodeName={nodeName} />
            {status === 'disconnected' && (
              <button
                type="button"
                onClick={() => void reconnect(sessionId)}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-700 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-300"
                aria-label="Reconnect to the same session"
                title="Reconnect — re-attach to this session (Pod still alive)"
                data-testid={`node-terminal-reconnect-${nodeName}`}
              >
                <RotateCw size={12} aria-hidden="true" />
                Reconnect
              </button>
            )}
            <button
              type="button"
              onClick={handleMinimize}
              className="rounded-md p-1.5 text-zinc-300 hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-500"
              aria-label="Minimize terminal (keep session running in background)"
              title="Minimize — keeps the session running while you navigate"
              data-testid={`node-terminal-minimize-${nodeName}`}
            >
              {/* Standard "minimize to taskbar" affordance — single underline. */}
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <line x1="3" y1="13" x2="13" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setIsMaximized((m) => !m)}
              className="rounded-md p-1.5 text-zinc-300 hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-500"
              aria-label={isMaximized ? 'Restore terminal to a smaller window' : 'Maximize terminal to full viewport'}
              title={isMaximized ? 'Restore' : 'Maximize'}
              data-testid={`node-terminal-toggle-size-${nodeName}`}
            >
              {isMaximized ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="rounded-md p-1.5 text-zinc-300 hover:bg-red-700/40 hover:text-red-200 focus:outline-none focus:ring-2 focus:ring-red-400"
              aria-label="Close terminal (ends the session)"
              title="Close — terminates the session"
              data-testid={`node-terminal-close-${nodeName}`}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Body — pure xterm container. min-h-0 so flex shrinks correctly;
            without it, flex children default to min-content and overflow. */}
        <div
          ref={containerRef}
          className="min-h-0 flex-1 bg-black p-2"
          data-testid={`node-terminal-xterm-${nodeName}`}
        />
      </div>
    </div>
  );
}

// ─── Step-up dialog ───────────────────────────────────────────────────
//
// Rendered when the store's pendingStepUp is set. Sits in front of any
// active terminal (operator may have one minimized while opening a new
// fresh session that needs step-up).

interface StepUpDialogProps {
  readonly nodeName: string;
  readonly methods: readonly StepUpMethod[];
  readonly error: string | null;
  readonly onVerifyPassword: (pw: string) => Promise<void>;
  readonly onVerifyPasskey: () => Promise<void>;
  readonly onCancel: () => void;
}

export function NodeTerminalStepUpDialog({
  nodeName, methods, error, onVerifyPassword, onVerifyPasskey, onCancel,
}: StepUpDialogProps) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState<'password' | 'passkey' | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const canPassword = methods.includes('password');
  const canPasskey = methods.includes('passkey');

  const submitPassword = useCallback(async () => {
    setLocalError(null);
    setSubmitting('password');
    try {
      await onVerifyPassword(password);
      setPassword('');
    } catch (e) {
      setLocalError((e as Error).message);
    } finally {
      setSubmitting(null);
    }
  }, [password, onVerifyPassword]);

  const submitPasskey = useCallback(async () => {
    setLocalError(null);
    setSubmitting('passkey');
    try {
      await onVerifyPasskey();
    } catch (e) {
      setLocalError((e as Error).message);
    } finally {
      setSubmitting(null);
    }
  }, [onVerifyPasskey]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      data-testid={`node-terminal-step-up-${nodeName}`}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Re-authenticate to open a root shell"
        className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-6 text-zinc-100 shadow-xl"
      >
        <div className="mb-4 flex items-center gap-2">
          <Key size={18} className="text-amber-400" aria-hidden="true" />
          <h2 className="text-lg font-semibold">Re-authenticate to open a root shell</h2>
        </div>
        <p className="mb-4 text-sm text-zinc-400">
          Opening a privileged terminal on <span className="font-mono">{titleCase(nodeName)}</span> requires a
          fresh credential check.
        </p>

        {canPassword && (
          <div className="mb-4">
            <label className="mb-1 block text-sm font-medium text-zinc-200" htmlFor="step-up-password">Password</label>
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
            No step-up methods available for your account. Contact a super-admin to enable a password or passkey.
          </div>
        )}

        {(localError || error) && (
          <div className="mt-3 rounded-md bg-rose-900/30 px-3 py-2 text-xs text-rose-200">
            {localError ?? error}
          </div>
        )}

        <button
          type="button"
          onClick={onCancel}
          className="mt-4 inline-flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200"
          data-testid={`node-terminal-step-up-cancel-${nodeName}`}
        >
          <X size={14} /> Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Title-bar status pill ────────────────────────────────────────────

interface StatusPillProps {
  readonly status: 'connecting' | 'connected' | 'disconnected';
  readonly nodeName: string;
}

function StatusPill({ status, nodeName }: StatusPillProps) {
  const isConnected = status === 'connected';
  const isConnecting = status === 'connecting';
  const isDisconnected = status === 'disconnected';

  return (
    <span
      className={
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium '
        + (isConnected ? 'bg-emerald-900/40 text-emerald-300 ring-1 ring-emerald-700/50 '
          : isConnecting ? 'bg-amber-900/40 text-amber-200 ring-1 ring-amber-700/50 '
          : 'bg-red-900/40 text-red-200 ring-1 ring-red-700/50 ')
      }
      data-testid={`node-terminal-status-${nodeName}`}
      data-status={status}
      aria-live="polite"
    >
      {isConnected && (
        <>
          <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden="true" />
          <span>connected</span>
        </>
      )}
      {isConnecting && (
        <>
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          <span>connecting…</span>
        </>
      )}
      {isDisconnected && (
        <>
          <span className="h-2 w-2 rounded-full bg-red-400" aria-hidden="true" />
          <span>disconnected</span>
        </>
      )}
    </span>
  );
}

// ─── Provisioning-loading overlay ─────────────────────────────────────
//
// Sits between the step-up dialog and the modal opening. After the
// operator's credential is verified, the backend still needs to spawn
// the privileged Pod and wait for it to reach Running (5-30s on a
// cold image pull). Without a visible state during that window the UI
// looks frozen.

interface OpeningOverlayProps {
  readonly nodeName: string;
}

export function NodeTerminalOpeningOverlay({ nodeName }: OpeningOverlayProps) {
  return (
    <div
      className="fixed inset-0 z-[65] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      data-testid={`node-terminal-opening-${nodeName}`}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-4 rounded-lg border border-zinc-700 bg-zinc-900 px-8 py-6 text-zinc-200 shadow-2xl">
        <Loader2 size={28} className="animate-spin text-zinc-400" aria-hidden="true" />
        <div className="text-sm">
          Opening shell on <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-zinc-100">{titleCase(nodeName)}</code>…
        </div>
        <div className="text-xs text-zinc-500">
          Provisioning the privileged pod (may take ~30s on first use).
        </div>
      </div>
    </div>
  );
}

// ─── Open-error toast ─────────────────────────────────────────────────

interface OpenErrorBannerProps {
  readonly message: string;
  readonly onRetry: () => void;
  readonly onDismiss: () => void;
}

export function NodeTerminalOpenErrorBanner({ message, onRetry, onDismiss }: OpenErrorBannerProps) {
  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex max-w-md -translate-x-1/2 items-center gap-3 rounded-lg border border-rose-700 bg-rose-900/90 px-4 py-3 text-rose-100 shadow-2xl">
      <AlertCircle size={16} aria-hidden="true" />
      <span className="flex-1 text-sm">{message}</span>
      <button onClick={onRetry} className="inline-flex items-center gap-1 text-sm hover:underline">
        <RotateCw size={12} /> Retry
      </button>
      <button onClick={onDismiss} aria-label="Dismiss" className="opacity-70 hover:opacity-100">
        <X size={14} />
      </button>
    </div>
  );
}
