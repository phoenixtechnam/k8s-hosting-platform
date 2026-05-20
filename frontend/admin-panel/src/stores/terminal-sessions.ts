import { create } from 'zustand';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { startAuthentication } from '@simplewebauthn/browser';

// ─── Terminal-sessions store ──────────────────────────────────────────
//
// Owns the xterm Terminal instance + WebSocket for every node-terminal
// session, regardless of whether it's actively visible in the modal
// (active) or parked while the operator navigates around (minimized).
//
// Lifecycle:
//   openFresh(nodeName)                 → step-up if stale, POST, open WS
//   minimize(sessionId)                 → keep refs alive, clear active
//   restore(sessionId)                  → set active for the modal
//   terminate(sessionId)                → close WS, dispose xterm, DELETE
//
// The xterm DOM host element lives in document.body's hidden graveyard
// when not actively shown; the modal's mount effect appendChild's it
// into its body container, and the unmount effect moves it back. xterm's
// renderer survives DOM moves (no .open() re-call needed when the same
// element is reparented).

// ─── Types ────────────────────────────────────────────────────────────

export type StepUpMethod = 'password' | 'passkey';

export interface StepUpStatus {
  readonly required: boolean;
  readonly methods: readonly StepUpMethod[];
  readonly lastCredentialCheckAt: string | null;
  readonly maxAgeSeconds: number;
}

export interface SessionSummary {
  readonly id: string;
  readonly nodeName: string;
  readonly createdAt: number;
  /** UI state: true = parked in the background dock; false = currently shown in the modal. */
  readonly minimized: boolean;
  /** WS lifecycle phase. `connecting` = WS opening, `connected` = open, `disconnected` = closed (any reason). The modal title bar + dock pill subscribe to this for the status indicator + Reconnect button visibility. */
  readonly status: 'connecting' | 'connected' | 'disconnected';
}

// ─── Internal refs (kept OUT of zustand state to avoid serialization
//     pressure and accidental React diffing of Terminal/WebSocket
//     objects, which would be both slow and incorrect).

interface SessionRefs {
  term: Terminal;
  fitAddon: FitAddon;
  ws: WebSocket;
  /** Stable host element. xterm renders here. Lives in document.body's
   *  hidden graveyard when not in the modal; moved into the modal body
   *  via appendChild when restored. */
  hostEl: HTMLDivElement;
  /** Disposable returned by `term.onData(...)`. We re-register on every
   *  reconnect so the stdin closure captures the latest WebSocket. The
   *  previous registration MUST be disposed first — otherwise each
   *  reconnect adds an additional listener that fires per keystroke
   *  on a closed socket (review finding: xterm onData accumulation).
   *  Optional because provisionSession/restoreFromStorage seed refs
   *  BEFORE bindWsLifecycle attaches the first listener; the post-
   *  bind sessionRefs.set always populates this. */
  onDataDisposable?: { dispose: () => void };
}

const sessionRefs = new Map<string, SessionRefs>();

// ─── Reload-survival sessionStorage mirror ────────────────────────────
//
// sessionStorage is per-tab, not per-window — exactly what we want for
// "this tab's open terminals survive an F5". On every relevant state
// change (open / minimize / restore / terminate), we mirror the
// current sessions array (minus the volatile xterm + WS refs) to
// sessionStorage. On app mount, NodeTerminalHost calls
// `restoreFromStorage()` which iterates the saved sessionIds and
// POSTs /ws-token to reattach each one.
//
// What we store: just enough to reconstruct the session UI state and
// reach the server's reconnect endpoint:
//   { id, nodeName, minimized, status }
// xterm scrollback is lost — the browser's xterm instance is gone
// when we restart. The shell on the host survives (server-side Pod +
// 60s grace period), but its scrollback wasn't ours to keep.

const STORAGE_KEY = 'node-terminal:open-sessions:v1';

interface PersistedSession {
  readonly id: string;
  readonly nodeName: string;
  readonly minimized: boolean;
}

interface PersistedState {
  readonly sessions: readonly PersistedSession[];
  /** The sessionId that was open in the modal at persist time, or null
   *  if the modal was closed (all sessions minimized). Drives whether
   *  the modal reopens on reload — and to which session. */
  readonly activeId: string | null;
}

function persistSessions(sessions: readonly SessionSummary[], activeId: string | null): void {
  try {
    const payload: PersistedState = {
      sessions: sessions.map((s) => ({
        id: s.id,
        nodeName: s.nodeName,
        minimized: s.minimized,
      })),
      activeId,
    };
    if (payload.sessions.length === 0) {
      sessionStorage.removeItem(STORAGE_KEY);
    } else {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    }
  } catch {
    // sessionStorage can throw QuotaExceededError or be disabled
    // entirely in some browser privacy modes. Best-effort — reload
    // survival is a quality-of-life feature, not load-bearing.
  }
}

function loadPersistedState(): PersistedState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { sessions: [], activeId: null };
    const parsed = JSON.parse(raw) as unknown;
    // Migration tolerance: old v1 wrote a bare array. Coerce that
    // shape to the new envelope.
    if (Array.isArray(parsed)) {
      return {
        sessions: parsed.filter(
          (p): p is PersistedSession =>
            typeof p === 'object'
            && p !== null
            && typeof (p as { id?: unknown }).id === 'string'
            && typeof (p as { nodeName?: unknown }).nodeName === 'string'
            && typeof (p as { minimized?: unknown }).minimized === 'boolean',
        ),
        activeId: null,
      };
    }
    if (typeof parsed !== 'object' || parsed === null) return { sessions: [], activeId: null };
    const obj = parsed as { sessions?: unknown; activeId?: unknown };
    const sessions = Array.isArray(obj.sessions)
      ? obj.sessions.filter(
          (p): p is PersistedSession =>
            typeof p === 'object'
            && p !== null
            && typeof (p as { id?: unknown }).id === 'string'
            && typeof (p as { nodeName?: unknown }).nodeName === 'string'
            && typeof (p as { minimized?: unknown }).minimized === 'boolean',
        )
      : [];
    const activeId = typeof obj.activeId === 'string' ? obj.activeId : null;
    return { sessions, activeId };
  } catch {
    return { sessions: [], activeId: null };
  }
}

// Lazy: get-or-create the hidden offscreen container that parks all
// non-active xterm host elements.
function getGraveyard(): HTMLDivElement {
  let g = document.getElementById('node-terminal-graveyard') as HTMLDivElement | null;
  if (!g) {
    g = document.createElement('div');
    g.id = 'node-terminal-graveyard';
    g.style.position = 'fixed';
    g.style.left = '-9999px';
    g.style.top = '-9999px';
    g.style.width = '0';
    g.style.height = '0';
    g.style.overflow = 'hidden';
    g.setAttribute('aria-hidden', 'true');
    document.body.appendChild(g);
  }
  return g;
}

// ─── Theme + xterm constants ──────────────────────────────────────────

const TERMINAL_THEME = {
  background: '#000000',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  selectionBackground: '#3a3a3a',
};

// ─── API helpers (mirror of the previous use-node-terminal hook) ──────

function getApiBase(): string {
  const runtimeApi = (window as { __runtime?: { API_URL?: string } }).__runtime?.API_URL;
  return runtimeApi ?? window.location.origin;
}

function authToken(): string {
  return localStorage.getItem('auth_token') ?? '';
}

function authHeaders(extra: Record<string, string> = {}): HeadersInit {
  const t = authToken();
  return {
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
    ...extra,
  };
}

async function fetchStepUpStatus(): Promise<StepUpStatus> {
  const r = await fetch(`${getApiBase()}/api/v1/me/step-up/status?purpose=node_terminal`, {
    headers: authHeaders(),
  });
  if (!r.ok) throw new Error(`step-up/status HTTP ${r.status}`);
  return (await r.json() as { data: StepUpStatus }).data;
}

async function postStepUpPassword(password: string): Promise<void> {
  const r = await fetch(`${getApiBase()}/api/v1/me/step-up/password`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ password }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Step-up failed (HTTP ${r.status})`);
  }
}

async function runStepUpPasskey(): Promise<void> {
  const optsResp = await fetch(`${getApiBase()}/api/v1/me/step-up/passkey/options`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({}),
  });
  if (!optsResp.ok) throw new Error(`Step-up passkey options HTTP ${optsResp.status}`);
  const optsJson = await optsResp.json() as { data: unknown };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cred = await startAuthentication({ optionsJSON: optsJson.data as any });
  const r = await fetch(`${getApiBase()}/api/v1/me/step-up/passkey/verify`, {
    method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ response: cred }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Step-up passkey verify HTTP ${r.status}`);
  }
}

interface CreatedSession {
  readonly sessionId: string;
  readonly nodeName: string;
  readonly websocketUrl: string;
}

async function postCreateSession(nodeName: string): Promise<CreatedSession> {
  const r = await fetch(
    `${getApiBase()}/api/v1/admin/nodes/${encodeURIComponent(nodeName)}/terminal/sessions`,
    {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: '{}',
    },
  );
  if (r.status === 403) {
    const body = await r.json().catch(() => ({})) as {
      error?: { code?: string; details?: { methods?: StepUpMethod[] } };
    };
    if (body.error?.code === 'STEP_UP_REQUIRED') {
      const err: Error & { stepUp?: { methods: StepUpMethod[] } } = new Error('STEP_UP_REQUIRED');
      err.stepUp = { methods: body.error.details?.methods ?? [] };
      throw err;
    }
  }
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Create session HTTP ${r.status}`);
  }
  const json = await r.json() as { data: { sessionId: string; nodeName: string; websocketUrl: string } };
  return json.data;
}

async function postDeleteSession(nodeName: string, sessionId: string): Promise<void> {
  await fetch(
    `${getApiBase()}/api/v1/admin/nodes/${encodeURIComponent(nodeName)}/terminal/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE', headers: authHeaders() },
  ).catch(() => undefined);
}

// ─── Zustand store ────────────────────────────────────────────────────

interface TerminalSessionsState {
  readonly sessions: readonly SessionSummary[];
  /** Currently-active session shown in the modal (null = no modal). */
  readonly activeId: string | null;
  /** Set by openFresh while waiting for step-up. Modal renders the dialog. */
  readonly pendingStepUp: { readonly methods: readonly StepUpMethod[]; readonly nodeName: string } | null;
  readonly stepUpError: string | null;
  /** A user-visible error that surfaced AFTER step-up cleared (e.g. node not Ready). */
  readonly openError: string | null;
  /**
   * Set while an open-flow is in progress for this node — covers BOTH the
   * step-up roundtrip AND the slow provisioning phase (POST /sessions →
   * waitForPodRunning, which can take 5-30s on a cold image pull). UI
   * uses it to disable the Terminal button + show a loading overlay
   * between auth and the modal opening.
   *
   * Cleared once the modal opens (activeId is set) OR on terminal error.
   */
  readonly openingFor: string | null;

  openFresh: (nodeName: string) => Promise<void>;
  /** Continue the openFresh flow after a successful step-up; usually called by the modal's dialog. */
  resumeAfterStepUp: () => Promise<void>;
  verifyStepUpPassword: (password: string) => Promise<void>;
  verifyStepUpPasskey: () => Promise<void>;
  /** Snapshot a session to the background pool — modal hides, refs survive. */
  minimize: (sessionId: string) => void;
  /** Bring a previously-minimized session back into the modal. */
  restore: (sessionId: string) => void;
  /** Terminate a session: WS close, xterm dispose, DELETE on server. */
  terminate: (sessionId: string) => void;
  /** Reconnect a disconnected session: mint a fresh wsToken via the
   *  server's POST /sessions/:id/ws-token endpoint, then open a new
   *  WebSocket against the SAME sessionId + Pod (which is still alive).
   *  Scrollback survives — the xterm Terminal instance is preserved.
   *  Shell state (cwd, env) is fresh because k8s gives each exec its
   *  own PTY (P0 spike). */
  reconnect: (sessionId: string) => Promise<void>;
  /** Called once at app mount by NodeTerminalHost. Reads sessionStorage,
   *  iterates persisted sessions, and reconnects each one to the
   *  server's still-running Pod (within the 60s grace period after
   *  the WS dropped on page unload). xterm instances + scrollback are
   *  reconstructed fresh; the shell state on the Pod is preserved. */
  restoreFromStorage: () => Promise<void>;
  /** Attach a session's xterm host element into the modal body element. */
  attach: (sessionId: string, container: HTMLElement) => void;
  /** Move a session's xterm host element back to the graveyard. */
  detach: (sessionId: string) => void;
  /** Resize a session's terminal. Called by the modal on layout changes. */
  fit: (sessionId: string) => void;
}

export const useTerminalSessions = create<TerminalSessionsState>((rawSet, get) => {
  // Wrap set so every state update writes sessions + activeId to
  // sessionStorage. Reload survival + modal-open-state restoration
  // both hinge on this side effect.
  const set: typeof rawSet = ((partial, replace) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rawSet as any)(partial, replace);
    const s = get();
    persistSessions(s.sessions, s.activeId);
  }) as typeof rawSet;

  // Build a fresh xterm + host div for a given sessionId. Both
  // provisionSession (POST /sessions) and restoreFromStorage (POST
  // /ws-token after reload) need this — extracted so they share one
  // path and the theme/font/scrollback defaults can't drift.
  function buildTerminal(sessionId: string): {
    term: Terminal;
    fitAddon: FitAddon;
    hostEl: HTMLDivElement;
  } {
    const term = new Terminal({
      theme: TERMINAL_THEME,
      fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
      fontSize: 15,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
      // right-click = "select word" inside xterm. The container's
      // contextmenu listener (added below) prevents the browser's
      // native context menu from racing tmux's right-click handling.
      rightClickSelectsWord: false,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    // Ctrl+Shift+C / Ctrl+Shift+V — standard terminal copy/paste
    // shortcuts that bypass tmux's mouse mode.
    //
    //   • If xterm has a selection (made via Shift+drag — see below),
    //     Ctrl+Shift+C copies it to clipboard and SWALLOWS the event
    //     (returning false stops xterm from forwarding the Ctrl-C to
    //     the shell, which would SIGINT a running command).
    //   • Ctrl+Shift+V reads the clipboard and pastes via the WS
    //     stdin channel.
    //   • Without a selection, Ctrl+Shift+C falls through to whatever
    //     the shell does (typically nothing, since Ctrl+Shift+C in
    //     bash isn't bound).
    //
    // Shift+click/drag is xterm.js's built-in escape hatch from
    // application mouse mode (tmux mouse=on): when Shift is held,
    // xterm performs native selection instead of forwarding the
    // mouse event to tmux. No custom code needed for that.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const isCopy = e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c');
      const isPaste = e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v');
      if (isCopy) {
        const sel = term.getSelection();
        if (sel) {
          // navigator.clipboard.writeText may fail in non-secure
          // contexts or if the document doesn't have focus — swallow
          // the rejection silently and let the user retry.
          navigator.clipboard?.writeText(sel).catch(() => undefined);
          // Tell xterm NOT to forward this Ctrl+C to the shell.
          return false;
        }
        // No selection — let Ctrl+Shift+C through (shell-defined).
        return true;
      }
      if (isPaste) {
        const refs = sessionRefs.get(sessionId);
        navigator.clipboard?.readText().then((text) => {
          if (text && refs?.ws.readyState === WebSocket.OPEN) {
            refs.ws.send(JSON.stringify({ type: 'stdin', data: text }));
          }
        }).catch(() => undefined);
        return false;
      }
      return true;
    });

    const hostEl = document.createElement('div');
    hostEl.style.width = '100%';
    hostEl.style.height = '100%';
    hostEl.style.position = 'relative'; // anchor for the custom scrollbar overlay
    hostEl.setAttribute('data-session-id', sessionId);
    // Suppress the browser's native context menu so tmux's right-click
    // menu isn't immediately covered by it. The right-click event
    // still reaches xterm/tmux through the mouse-mode encoding;
    // we only prevent the browser's default response.
    hostEl.addEventListener('contextmenu', (e) => e.preventDefault());
    getGraveyard().appendChild(hostEl);
    term.open(hostEl);

    // Custom scrollbar overlay — xterm.js renders no scrollbar of its
    // own (it's a terminal emulator, not a textarea). Add a thin
    // 6px indicator on the right edge that mirrors term.buffer.active
    // .viewportY / .baseY so operators have a visual cue when there's
    // scrollback above the visible area.
    const scrollbar = document.createElement('div');
    scrollbar.style.cssText = [
      'position:absolute',
      'top:0',
      'right:0',
      'width:6px',
      'height:100%',
      'background:transparent',
      'pointer-events:none',
      'z-index:5',
    ].join(';');
    const thumb = document.createElement('div');
    thumb.style.cssText = [
      'position:absolute',
      'right:1px',
      'width:4px',
      'background:rgba(180,180,180,0.45)',
      'border-radius:2px',
      'opacity:0',
      'transition:opacity 200ms',
    ].join(';');
    scrollbar.appendChild(thumb);
    hostEl.appendChild(scrollbar);

    const updateScrollbar = (): void => {
      const buf = term.buffer.active;
      const totalLines = buf.length;
      const visibleLines = term.rows;
      if (totalLines <= visibleLines) {
        thumb.style.opacity = '0';
        return;
      }
      const thumbH = Math.max(20, (visibleLines / totalLines) * hostEl.clientHeight);
      const maxScroll = totalLines - visibleLines;
      const top = (buf.viewportY / Math.max(1, maxScroll)) * (hostEl.clientHeight - thumbH);
      thumb.style.height = `${thumbH}px`;
      thumb.style.top = `${top}px`;
      thumb.style.opacity = '1';
    };
    term.onScroll(() => updateScrollbar());
    term.onLineFeed(() => updateScrollbar());
    // Initial render after attach
    requestAnimationFrame(updateScrollbar);

    return { term, fitAddon, hostEl };
  }

  // ── Internal: open a session given a nodeName. Returns sessionId.
  // Throws { stepUp: { methods } } if STEP_UP_REQUIRED.
  async function provisionSession(nodeName: string): Promise<string> {
    const created = await postCreateSession(nodeName);
    const { term, fitAddon, hostEl } = buildTerminal(created.sessionId);

    // WS — JWT in ?jwt= since WebSocket can't carry Authorization.
    const wsUrl = created.websocketUrl.includes('?')
      ? `${created.websocketUrl}&jwt=${encodeURIComponent(authToken())}`
      : `${created.websocketUrl}?jwt=${encodeURIComponent(authToken())}`;
    // Open the WS + install the refs atomically. bindWsLifecycle is
    // re-used by reconnect() to swap in a fresh ws on the same xterm.
    const ws = new WebSocket(wsUrl);
    sessionRefs.set(created.sessionId, { term, fitAddon, ws, hostEl });
    bindWsLifecycle(term, ws, created.sessionId, set);

    const summary: SessionSummary = {
      id: created.sessionId,
      nodeName: created.nodeName,
      createdAt: Date.now(),
      minimized: false,
      status: 'connecting',
    };
    // Atomic state transition: drop the loading overlay AND open the
    // modal in a single set() so React doesn't render the in-between
    // state where both are visible for a frame.
    set((s) => ({
      sessions: [...s.sessions, summary],
      activeId: created.sessionId,
      openingFor: null,
    }));
    return created.sessionId;
  }

  /** Wire WS event handlers to xterm + status. Used by both the
   *  initial provisioning AND the reconnect action so they share
   *  exactly one onmessage/onclose/onerror implementation.
   *
   *  Side effect: writes `refs.ws` for the sessionId into the module-
   *  level sessionRefs map BEFORE returning, so any code reading
   *  refs.ws can rely on it being current. */
  function bindWsLifecycle(
    term: Terminal,
    ws: WebSocket,
    sessionId: string,
    setStore: typeof set,
  ): void {
    ws.onopen = () => {
      setStore((s) => ({
        sessions: s.sessions.map((sess) => sess.id === sessionId ? { ...sess, status: 'connected' } : sess),
      }));
    };
    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data as string) as Record<string, unknown>;
        const type = frame.type as string | undefined;
        if ((type === 'stdout' || type === 'stderr') && typeof frame.data === 'string') {
          term.write(frame.data);
        } else if (type === 'connected') {
          // first frame after a fresh exec — clear the placeholder
          term.clear();
        } else if (type === 'error') {
          term.write(`\r\n\x1b[31m[error] ${(frame.message as string) ?? 'unknown'}\x1b[0m\r\n`);
        } else if (type === 'exit') {
          term.write(`\r\n\x1b[33m[session ended: ${(frame.reason as string) ?? 'closed'}]\x1b[0m\r\n`);
        }
      } catch { /* malformed frame */ }
    };
    ws.onerror = () => term.write('\r\n\x1b[31m[WebSocket error]\x1b[0m\r\n');
    ws.onclose = () => {
      term.write('\r\n\x1b[33m[disconnected]\x1b[0m\r\n');
      setStore((s) => ({
        sessions: s.sessions.map((sess) => sess.id === sessionId ? { ...sess, status: 'disconnected' } : sess),
      }));
    };
    // Dispose any previous term.onData registration before adding the
    // new one. Without this, every reconnect accumulates an additional
    // listener that fires per keystroke (the old ones target closed
    // WebSockets, so they no-op via the readyState guard — but they
    // still run and waste cycles). Review finding (2026-05-20).
    const prior = sessionRefs.get(sessionId);
    if (prior?.onDataDisposable) {
      try { prior.onDataDisposable.dispose(); } catch { /* ignore */ }
    }
    const onDataDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stdin', data }));
      }
    });
    // Update refs.ws + onDataDisposable so any later code (reconnect,
    // term.onData) talks to the latest ws and disposes the latest
    // listener. term/fitAddon/hostEl are written by provisionSession
    // / restoreFromStorage before this helper is called.
    const existing = sessionRefs.get(sessionId);
    if (existing) {
      sessionRefs.set(sessionId, { ...existing, ws, onDataDisposable });
    }
  }

  return {
    sessions: [],
    activeId: null,
    pendingStepUp: null,
    stepUpError: null,
    openError: null,
    openingFor: null,

    openFresh: async (nodeName: string) => {
      set({ stepUpError: null, openError: null, openingFor: nodeName });
      try {
        // Preflight — surface step-up requirement before POSTing.
        const status = await fetchStepUpStatus().catch(() => null);
        if (status?.required) {
          set({ pendingStepUp: { methods: status.methods, nodeName } });
          // openingFor stays set — the user is still inside the open
          // flow; the UI shows the dialog instead of the loading
          // overlay. Cleared on success (activeId set in provisionSession)
          // OR explicit cancel.
          return;
        }
        await provisionSession(nodeName);
        // provisionSession's atomic set() already cleared openingFor.
      } catch (e) {
        const err = e as Error & { stepUp?: { methods: StepUpMethod[] } };
        if (err.stepUp) {
          set({ pendingStepUp: { methods: err.stepUp.methods, nodeName } });
          // openingFor stays set (see above)
        } else {
          set({ openError: err.message ?? 'Failed to open terminal', activeId: null, openingFor: null });
        }
      }
    },

    resumeAfterStepUp: async () => {
      const pending = get().pendingStepUp;
      if (!pending) return;
      set({ pendingStepUp: null, stepUpError: null, openingFor: pending.nodeName });
      try {
        await provisionSession(pending.nodeName);
        // provisionSession's atomic set() already cleared openingFor.
      } catch (e) {
        const err = e as Error & { stepUp?: { methods: StepUpMethod[] } };
        if (err.stepUp) {
          // Still required (e.g. multi-method) — re-prompt.
          set({ pendingStepUp: { methods: err.stepUp.methods, nodeName: pending.nodeName } });
        } else {
          set({ openError: err.message ?? 'Failed to open terminal', openingFor: null });
        }
      }
    },

    verifyStepUpPassword: async (password: string) => {
      set({ stepUpError: null });
      try {
        await postStepUpPassword(password);
        await get().resumeAfterStepUp();
      } catch (e) {
        set({ stepUpError: (e as Error).message });
        throw e;
      }
    },

    verifyStepUpPasskey: async () => {
      set({ stepUpError: null });
      try {
        await runStepUpPasskey();
        await get().resumeAfterStepUp();
      } catch (e) {
        set({ stepUpError: (e as Error).message });
        throw e;
      }
    },

    minimize: (sessionId: string) => {
      const refs = sessionRefs.get(sessionId);
      if (refs) {
        // Move xterm host back to the graveyard so it's not orphaned
        // in the DOM after the modal unmounts.
        getGraveyard().appendChild(refs.hostEl);
      }
      set((s) => ({
        sessions: s.sessions.map((sess) => sess.id === sessionId ? { ...sess, minimized: true } : sess),
        activeId: s.activeId === sessionId ? null : s.activeId,
      }));
    },

    restore: (sessionId: string) => {
      set((s) => ({
        sessions: s.sessions.map((sess) => sess.id === sessionId ? { ...sess, minimized: false } : sess),
        activeId: sessionId,
      }));
    },

    terminate: (sessionId: string) => {
      const refs = sessionRefs.get(sessionId);
      const session = get().sessions.find((s) => s.id === sessionId);
      if (refs) {
        // Send an explicit terminate frame BEFORE closing so the
        // server bypasses the 60s grace period (which exists for
        // page-reload/network-blip drops). Without this, clicking ×
        // would leave the privileged Pod alive for another minute.
        try {
          if (refs.ws.readyState === WebSocket.OPEN) {
            refs.ws.send(JSON.stringify({ type: 'terminate' }));
          }
        } catch { /* ws errored — server will grace-period reap it */ }
        try { refs.ws.close(1000, 'client_close'); } catch { /* socket gone */ }
        try { refs.term.dispose(); } catch { /* already disposed */ }
        try { refs.hostEl.remove(); } catch { /* not in DOM */ }
        sessionRefs.delete(sessionId);
      }
      if (session) {
        void postDeleteSession(session.nodeName, sessionId);
      }
      set((s) => ({
        sessions: s.sessions.filter((sess) => sess.id !== sessionId),
        activeId: s.activeId === sessionId ? null : s.activeId,
      }));
    },

    reconnect: async (sessionId: string) => {
      const refs = sessionRefs.get(sessionId);
      const session = get().sessions.find((s) => s.id === sessionId);
      if (!refs || !session) return;
      // Flip to connecting immediately for UI feedback.
      set((s) => ({
        sessions: s.sessions.map((sess) => sess.id === sessionId ? { ...sess, status: 'connecting' } : sess),
      }));
      try {
        // Mint a fresh wsToken from the server. May 403 STEP_UP_REQUIRED
        // if freshness has expired since the original session opened.
        const r = await fetch(
          `${getApiBase()}/api/v1/admin/nodes/${encodeURIComponent(session.nodeName)}/terminal/sessions/${encodeURIComponent(sessionId)}/ws-token`,
          { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: '{}' },
        );
        if (r.status === 403) {
          const body = await r.json().catch(() => ({})) as {
            error?: { code?: string; details?: { methods?: StepUpMethod[] } };
          };
          if (body.error?.code === 'STEP_UP_REQUIRED') {
            set({ pendingStepUp: { methods: body.error.details?.methods ?? [], nodeName: session.nodeName } });
            // Caller (the dialog) will run verifyStepUpPassword/Passkey
            // then call reconnect() again. Status stays "connecting".
            return;
          }
        }
        if (r.status === 404) {
          // Server already cleared the row — the session is truly gone.
          // Fall back to spawning a fresh one on the same node.
          set((s) => ({
            sessions: s.sessions.filter((sess) => sess.id !== sessionId),
            activeId: s.activeId === sessionId ? null : s.activeId,
          }));
          sessionRefs.delete(sessionId);
          await get().openFresh(session.nodeName);
          return;
        }
        if (!r.ok) {
          const body = await r.json().catch(() => ({})) as { error?: { message?: string } };
          throw new Error(body.error?.message ?? `Reconnect failed (HTTP ${r.status})`);
        }
        const json = await r.json() as { data: { websocketUrl: string } };
        const wsUrl = json.data.websocketUrl.includes('?')
          ? `${json.data.websocketUrl}&jwt=${encodeURIComponent(authToken())}`
          : `${json.data.websocketUrl}?jwt=${encodeURIComponent(authToken())}`;
        // Close the stale ws (if not already closed) so its onclose
        // doesn't fire AFTER we've swapped in the fresh one and
        // flip status back to disconnected.
        try { refs.ws.close(1000, 'reconnect'); } catch { /* gone */ }
        const ws = new WebSocket(wsUrl);
        refs.term.writeln('\r\n\x1b[36m[reconnecting — shell state may be fresh; scrollback preserved]\x1b[0m');
        bindWsLifecycle(refs.term, ws, sessionId, set);
      } catch (e) {
        set((s) => ({
          sessions: s.sessions.map((sess) => sess.id === sessionId ? { ...sess, status: 'disconnected' } : sess),
          openError: (e as Error).message,
        }));
      }
    },

    restoreFromStorage: async () => {
      // Idempotent — if we already have sessions in memory (StrictMode
      // double-mount, or this got called twice somehow), skip.
      if (get().sessions.length > 0) return;
      const persisted = loadPersistedState();
      if (persisted.sessions.length === 0) return;
      // Seed the visible store with the persisted shapes BEFORE doing
      // any network work, so the dock + modal scaffold render right
      // away. Each entry starts in 'connecting' status; bindWsLifecycle
      // flips to 'connected' when the WS opens, or 'disconnected' if
      // the server's grace window expired before we got here.
      const seeded: SessionSummary[] = persisted.sessions.map((p) => ({
        id: p.id,
        nodeName: p.nodeName,
        createdAt: Date.now(),
        minimized: p.minimized,
        status: 'connecting',
      }));
      // Restore activeId — but only if that session is also in the
      // persisted list (otherwise the modal would render with no
      // session). null when the modal was closed pre-reload.
      const restoredActiveId = persisted.activeId
        && seeded.some((s) => s.id === persisted.activeId)
          ? persisted.activeId
          : null;
      set({ sessions: seeded, activeId: restoredActiveId });

      // Step-up freshness check ONCE up front — avoids N parallel
      // POST /ws-token calls all racing to set pendingStepUp (review
      // finding: "last writer wins" UX dead-end). If step-up is
      // required, we raise the dialog and bail; the user completes
      // step-up and then can reload (or wait for a future trigger)
      // to retry restore. The persisted sessions stay in storage so
      // the next mount picks them up.
      const stepUpStatus = await fetchStepUpStatus().catch(() => null);
      if (stepUpStatus?.required) {
        // Pick a node name to display in the dialog header — first
        // persisted entry. The dialog itself is shared across all
        // sessions in the batch.
        const firstNode = persisted.sessions[0]?.nodeName ?? '';
        set({ pendingStepUp: { methods: stepUpStatus.methods, nodeName: firstNode } });
        // Flip all seeded sessions to disconnected so the dock pill
        // shows red — they're waiting on the user.
        set((s) => ({
          sessions: s.sessions.map((sess) => ({ ...sess, status: 'disconnected' })),
        }));
        return;
      }

      // Step-up is fresh — fan out the reconnects. The per-session
      // 403/404 branches below are still here as defence-in-depth
      // (e.g. step-up expired between our check above and the POST).
      const results = await Promise.allSettled(
        persisted.sessions.map(async (p) => {
          const r = await fetch(
            `${getApiBase()}/api/v1/admin/nodes/${encodeURIComponent(p.nodeName)}/terminal/sessions/${encodeURIComponent(p.id)}/ws-token`,
            { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: '{}' },
          );
          if (r.status === 403) {
            const body = await r.json().catch(() => ({})) as {
              error?: { code?: string; details?: { methods?: StepUpMethod[] } };
            };
            if (body.error?.code === 'STEP_UP_REQUIRED') {
              set({ pendingStepUp: { methods: body.error.details?.methods ?? [], nodeName: p.nodeName } });
              return { status: 'step_up' as const, sessionId: p.id };
            }
          }
          if (r.status === 404) {
            return { status: 'gone' as const, sessionId: p.id };
          }
          if (!r.ok) {
            const body = await r.json().catch(() => ({})) as { error?: { message?: string } };
            throw new Error(body.error?.message ?? `Restore failed (HTTP ${r.status})`);
          }
          const json = await r.json() as { data: { websocketUrl: string; nodeName: string; sessionId: string } };
          // Build a fresh xterm + WS and wire them up. Same path as
          // provisionSession but with a known sessionId from disk.
          const { term, fitAddon, hostEl } = buildTerminal(p.id);
          const wsUrl = json.data.websocketUrl.includes('?')
            ? `${json.data.websocketUrl}&jwt=${encodeURIComponent(authToken())}`
            : `${json.data.websocketUrl}?jwt=${encodeURIComponent(authToken())}`;
          const ws = new WebSocket(wsUrl);
          sessionRefs.set(p.id, { term, fitAddon, ws, hostEl });
          bindWsLifecycle(term, ws, p.id, set);
          term.writeln('\x1b[36m[reattached after reload — shell state preserved on the host]\x1b[0m');
          return { status: 'ok' as const, sessionId: p.id };
        }),
      );

      // Sweep any sessions the server already let go (grace period
      // expired during the reload). Their seeded entries get pruned
      // and their persisted entries roll off when persistSessions
      // runs after the set() below.
      const goneIds: string[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.status === 'gone') {
          goneIds.push(r.value.sessionId);
        }
      }
      if (goneIds.length > 0) {
        set((s) => ({
          sessions: s.sessions.filter((sess) => !goneIds.includes(sess.id)),
          activeId: goneIds.includes(s.activeId ?? '') ? null : s.activeId,
        }));
      }
    },

    attach: (sessionId: string, container: HTMLElement) => {
      const refs = sessionRefs.get(sessionId);
      if (!refs) return;
      container.appendChild(refs.hostEl);
      // After the appendChild has taken effect in layout, fit. Use rAF
      // because the parent's flex layout may not have run yet.
      requestAnimationFrame(() => {
        try { refs.fitAddon.fit(); } catch { /* container size 0 */ }
        if (refs.ws.readyState === WebSocket.OPEN) {
          refs.ws.send(JSON.stringify({ type: 'resize', cols: refs.term.cols, rows: refs.term.rows }));
        }
        refs.term.focus();
      });
    },

    detach: (sessionId: string) => {
      const refs = sessionRefs.get(sessionId);
      if (refs) getGraveyard().appendChild(refs.hostEl);
    },

    fit: (sessionId: string) => {
      const refs = sessionRefs.get(sessionId);
      if (!refs) return;
      try { refs.fitAddon.fit(); } catch { return; }
      if (refs.ws.readyState === WebSocket.OPEN) {
        refs.ws.send(JSON.stringify({ type: 'resize', cols: refs.term.cols, rows: refs.term.rows }));
      }
    },
  };
});
