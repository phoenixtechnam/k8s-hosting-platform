import { useCallback, useEffect, useRef, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';

// ─── API base + auth helpers ───────────────────────────────────────

function getApiBase(): string {
  // admin-panel pulls the API URL from runtime-config when present;
  // fall back to current origin (DinD / same-origin staging).
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

// ─── Types — duplicated from api-contracts to avoid a peer-import for
//     each subset of the schema. The shape is enforced server-side.

export type StepUpMethod = 'password' | 'passkey';

export interface StepUpStatus {
  readonly required: boolean;
  readonly methods: readonly StepUpMethod[];
  readonly lastCredentialCheckAt: string | null;
  readonly maxAgeSeconds: number;
}

export interface NodeTerminalSession {
  readonly sessionId: string;
  readonly nodeName: string;
  readonly podName: string;
  readonly websocketUrl: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly idleTimeoutSeconds: number;
}

export interface UseNodeTerminalResult {
  readonly connected: boolean;
  readonly connecting: boolean;
  readonly error: string | null;
  readonly stepUpRequired: { methods: readonly StepUpMethod[] } | null;
  readonly session: NodeTerminalSession | null;
  readonly connect: (onData: (chunk: string) => void) => Promise<void>;
  readonly send: (data: string) => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly disconnect: () => void;
  readonly verifyStepUpPassword: (password: string) => Promise<void>;
  readonly verifyStepUpPasskey: () => Promise<void>;
}

// ─── REST helpers ─────────────────────────────────────────────────

async function fetchStepUpStatus(): Promise<StepUpStatus> {
  const resp = await fetch(`${getApiBase()}/api/v1/me/step-up/status?purpose=node_terminal`, {
    headers: authHeaders(),
  });
  if (!resp.ok) throw new Error(`step-up status failed: HTTP ${resp.status}`);
  const json = await resp.json() as { data: StepUpStatus };
  return json.data;
}

async function postStepUpPassword(password: string): Promise<void> {
  const resp = await fetch(`${getApiBase()}/api/v1/me/step-up/password`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ password }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Step-up failed (HTTP ${resp.status})`);
  }
}

async function runStepUpPasskey(): Promise<void> {
  const optsResp = await fetch(`${getApiBase()}/api/v1/me/step-up/passkey/options`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({}),
  });
  if (!optsResp.ok) {
    throw new Error(`Step-up passkey options failed (HTTP ${optsResp.status})`);
  }
  const optsJson = await optsResp.json() as { data: unknown };
  // simplewebauthn handles the credentials.get call.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cred = await startAuthentication({ optionsJSON: optsJson.data as any });
  const verifyResp = await fetch(`${getApiBase()}/api/v1/me/step-up/passkey/verify`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ response: cred }),
  });
  if (!verifyResp.ok) {
    const body = await verifyResp.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Step-up passkey verify failed (HTTP ${verifyResp.status})`);
  }
}

async function createSession(nodeName: string): Promise<NodeTerminalSession> {
  const resp = await fetch(
    `${getApiBase()}/api/v1/admin/nodes/${encodeURIComponent(nodeName)}/terminal/sessions`,
    {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: '{}',
    },
  );
  if (resp.status === 403) {
    const body = await resp.json().catch(() => ({})) as {
      error?: { code?: string; details?: { methods?: StepUpMethod[] } };
    };
    if (body.error?.code === 'STEP_UP_REQUIRED') {
      const err: Error & { stepUp?: { methods: StepUpMethod[] } } = new Error('STEP_UP_REQUIRED');
      err.stepUp = { methods: body.error.details?.methods ?? [] };
      throw err;
    }
  }
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Failed to create session (HTTP ${resp.status})`);
  }
  const json = await resp.json() as { data: NodeTerminalSession };
  return json.data;
}

async function deleteSession(nodeName: string, sessionId: string): Promise<void> {
  // Best-effort — WS close on the server already triggers cleanup.
  await fetch(
    `${getApiBase()}/api/v1/admin/nodes/${encodeURIComponent(nodeName)}/terminal/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE', headers: authHeaders() },
  ).catch(() => undefined);
}

// ─── Hook ─────────────────────────────────────────────────────────

export function useNodeTerminal(nodeName: string): UseNodeTerminalResult {
  const wsRef = useRef<WebSocket | null>(null);
  const onDataRef = useRef<((chunk: string) => void) | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepUpRequired, setStepUpRequired] = useState<{ methods: readonly StepUpMethod[] } | null>(null);
  const [session, setSession] = useState<NodeTerminalSession | null>(null);

  const tearDownSocket = useCallback(() => {
    try { wsRef.current?.close(); } catch { /* socket already closed */ }
    wsRef.current = null;
    setConnected(false);
  }, []);

  const openSocket = useCallback((url: string, sid: string, onData: (chunk: string) => void) => {
    // WebSocket can't carry Authorization headers; embed the access
    // JWT in `?jwt=` alongside the wsToken (`?token=` already in the
    // URL the server emitted). Server's authenticateWs reads both.
    const fullUrl = url.includes('?')
      ? `${url}&jwt=${encodeURIComponent(authToken())}`
      : `${url}?jwt=${encodeURIComponent(authToken())}`;
    const ws = new WebSocket(fullUrl);
    wsRef.current = ws;
    onDataRef.current = onData;
    ws.onopen = () => {
      setConnected(true);
      setError(null);
    };
    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data as string) as Record<string, unknown>;
        const type = frame.type as string | undefined;
        if (type === 'connected' && frame.sessionId !== sid) {
          setError('Session mismatch on connect frame');
          ws.close();
          return;
        }
        if ((type === 'stdout' || type === 'stderr') && typeof frame.data === 'string') {
          onData(frame.data);
        } else if (type === 'error') {
          setError((frame.message as string) ?? 'WebSocket error');
        } else if (type === 'exit') {
          setConnected(false);
        }
      } catch { /* malformed frame */ }
    };
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setError('WebSocket connection failed');
  }, []);

  const connect = useCallback(async (onData: (chunk: string) => void) => {
    setConnecting(true);
    setError(null);
    try {
      // Pre-flight the freshness check so the modal can render the
      // step-up dialog before attempting a session create.
      const status = await fetchStepUpStatus().catch(() => null);
      if (status?.required) {
        setStepUpRequired({ methods: status.methods });
        return;
      }
      const created = await createSession(nodeName);
      setSession(created);
      setStepUpRequired(null);
      openSocket(created.websocketUrl, created.sessionId, onData);
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err = e as any;
      if (err?.stepUp) {
        setStepUpRequired({ methods: err.stepUp.methods });
      } else {
        setError(err?.message ?? 'Failed to open terminal');
      }
    } finally {
      setConnecting(false);
    }
  }, [nodeName, openSocket]);

  const send = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stdin', data }));
    }
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }, []);

  const disconnect = useCallback(() => {
    tearDownSocket();
    if (session) {
      void deleteSession(session.nodeName, session.sessionId);
    }
  }, [session, tearDownSocket]);

  const verifyStepUpPassword = useCallback(async (password: string) => {
    setError(null);
    try {
      await postStepUpPassword(password);
      setStepUpRequired(null);
      // Re-fetch status to confirm — and to recover gracefully if
      // the password verified but a future method (e.g. multi-method)
      // still needs to be satisfied.
      const status = await fetchStepUpStatus();
      if (status.required) {
        setStepUpRequired({ methods: status.methods });
        return;
      }
      // Caller should call connect() again now that freshness is renewed.
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }, []);

  const verifyStepUpPasskey = useCallback(async () => {
    setError(null);
    try {
      await runStepUpPasskey();
      setStepUpRequired(null);
      const status = await fetchStepUpStatus();
      if (status.required) setStepUpRequired({ methods: status.methods });
    } catch (e) {
      setError((e as Error).message);
      throw e;
    }
  }, []);

  // Tear down on unmount.
  useEffect(() => () => {
    tearDownSocket();
    if (session) {
      void deleteSession(session.nodeName, session.sessionId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    connected,
    connecting,
    error,
    stepUpRequired,
    session,
    connect,
    send,
    resize,
    disconnect,
    verifyStepUpPassword,
    verifyStepUpPasskey,
  };
}
