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
  /** Heartbeat interval id — cleared on terminate. */
  heartbeat: ReturnType<typeof setInterval>;
}

const sessionRefs = new Map<string, SessionRefs>();

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
  /** Attach a session's xterm host element into the modal body element. */
  attach: (sessionId: string, container: HTMLElement) => void;
  /** Move a session's xterm host element back to the graveyard. */
  detach: (sessionId: string) => void;
  /** Resize a session's terminal. Called by the modal on layout changes. */
  fit: (sessionId: string) => void;
}

export const useTerminalSessions = create<TerminalSessionsState>((set, get) => {
  // ── Internal: open a session given a nodeName. Returns sessionId.
  // Throws { stepUp: { methods } } if STEP_UP_REQUIRED.
  async function provisionSession(nodeName: string): Promise<string> {
    const created = await postCreateSession(nodeName);

    const term = new Terminal({
      theme: TERMINAL_THEME,
      fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
      fontSize: 15,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    const hostEl = document.createElement('div');
    hostEl.style.width = '100%';
    hostEl.style.height = '100%';
    hostEl.setAttribute('data-session-id', created.sessionId);
    // Park it in the graveyard initially. The modal's attach() moves
    // it into its body the first time it renders this session.
    getGraveyard().appendChild(hostEl);
    term.open(hostEl);

    // WS — JWT in ?jwt= since WebSocket can't carry Authorization.
    const wsUrl = created.websocketUrl.includes('?')
      ? `${created.websocketUrl}&jwt=${encodeURIComponent(authToken())}`
      : `${created.websocketUrl}?jwt=${encodeURIComponent(authToken())}`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data as string) as Record<string, unknown>;
        const type = frame.type as string | undefined;
        if ((type === 'stdout' || type === 'stderr') && typeof frame.data === 'string') {
          term.write(frame.data);
        } else if (type === 'connected') {
          // first frame — clear the placeholder
          term.clear();
        } else if (type === 'error') {
          term.write(`\r\n\x1b[31m[error] ${(frame.message as string) ?? 'unknown'}\x1b[0m\r\n`);
        } else if (type === 'exit') {
          term.write(`\r\n\x1b[33m[session ended: ${(frame.reason as string) ?? 'closed'}]\x1b[0m\r\n`);
        }
      } catch { /* malformed frame */ }
    };
    ws.onerror = () => term.write('\r\n\x1b[31m[WebSocket error]\x1b[0m\r\n');
    ws.onclose = () => term.write('\r\n\x1b[33m[disconnected]\x1b[0m\r\n');

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stdin', data }));
      }
    });

    // Heartbeat — keep mid-NAT proxies from culling the socket.
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* socket gone */ }
      }
    }, 25_000);

    sessionRefs.set(created.sessionId, { term, fitAddon, ws, hostEl, heartbeat });

    const summary: SessionSummary = {
      id: created.sessionId,
      nodeName: created.nodeName,
      createdAt: Date.now(),
      minimized: false,
    };
    set((s) => ({ sessions: [...s.sessions, summary], activeId: created.sessionId }));
    return created.sessionId;
  }

  return {
    sessions: [],
    activeId: null,
    pendingStepUp: null,
    stepUpError: null,
    openError: null,

    openFresh: async (nodeName: string) => {
      set({ stepUpError: null, openError: null });
      try {
        // Preflight — surface step-up requirement before POSTing.
        const status = await fetchStepUpStatus().catch(() => null);
        if (status?.required) {
          set({ pendingStepUp: { methods: status.methods, nodeName } });
          return;
        }
        await provisionSession(nodeName);
      } catch (e) {
        const err = e as Error & { stepUp?: { methods: StepUpMethod[] } };
        if (err.stepUp) {
          set({ pendingStepUp: { methods: err.stepUp.methods, nodeName } });
        } else {
          set({ openError: err.message ?? 'Failed to open terminal', activeId: null });
        }
      }
    },

    resumeAfterStepUp: async () => {
      const pending = get().pendingStepUp;
      if (!pending) return;
      set({ pendingStepUp: null, stepUpError: null });
      try {
        await provisionSession(pending.nodeName);
      } catch (e) {
        const err = e as Error & { stepUp?: { methods: StepUpMethod[] } };
        if (err.stepUp) {
          // Still required (e.g. multi-method) — re-prompt.
          set({ pendingStepUp: { methods: err.stepUp.methods, nodeName: pending.nodeName } });
        } else {
          set({ openError: err.message ?? 'Failed to open terminal' });
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
        clearInterval(refs.heartbeat);
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
