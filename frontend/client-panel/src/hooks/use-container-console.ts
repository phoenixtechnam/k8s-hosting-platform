import { useState, useEffect, useCallback, useRef } from 'react';
import { config } from '../lib/runtime-config';
import { useClientContext } from './use-client-context';

export interface LogLine {
  type: 'log';
  component: string;
  timestamp: string;
  text: string;
  level: 'info' | 'warning' | 'error';
}

export interface ComponentInfo {
  name: string;
  podName: string;
  containerName: string;
  ready: boolean;
  status: string;
  restarts: number;
}

function buildWsUrl(path: string): string {
  const token = localStorage.getItem('auth_token') ?? '';
  const base = config.API_URL || window.location.origin;
  const wsBase = base.replace(/^http/, 'ws');
  const sep = path.includes('?') ? '&' : '?';
  return `${wsBase}${path}${sep}token=${encodeURIComponent(token)}`;
}

export function useDeploymentComponents(deploymentId: string) {
  const [components, setComponents] = useState<ComponentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const { clientId } = useClientContext();

  useEffect(() => {
    if (!clientId || !deploymentId) return;
    const token = localStorage.getItem('auth_token');
    const base = config.API_URL || '';
    fetch(`${base}/api/v1/clients/${clientId}/deployments/${deploymentId}/components`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => r.json())
      .then((d) => setComponents(d.data ?? []))
      .catch(() => setComponents([]))
      .finally(() => setLoading(false));
  }, [clientId, deploymentId]);

  return { components, loading };
}

export function useLogStream(
  deploymentId: string,
  options: { component?: string; tailLines?: number; enabled?: boolean } = {},
) {
  const { clientId } = useClientContext();
  const { component, tailLines = 100, enabled = true } = options;
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalCloseRef = useRef(false);
  const maxLines = 5000;

  const connect = useCallback(() => {
    if (!clientId || !deploymentId || !enabled) return;
    intentionalCloseRef.current = false;

    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      return;
    }

    const params = new URLSearchParams();
    if (component) params.set('component', component);
    params.set('tailLines', String(tailLines));

    const url = buildWsUrl(`/api/v1/clients/${clientId}/deployments/${deploymentId}/logs/stream?${params}`);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => { setConnected(true); setError(null); };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'log') {
          setLines((prev) => {
            const next = [...prev, msg as LogLine];
            return next.length > maxLines ? next.slice(-maxLines) : next;
          });
        } else if (msg.type === 'error') {
          setError(msg.message);
        }
      } catch { /* ignore parse errors */ }
    };

    ws.onclose = () => {
      setConnected(false);
      if (!intentionalCloseRef.current && enabled) {
        reconnectTimerRef.current = setTimeout(() => { connect(); }, 3000);
      }
    };
    ws.onerror = () => setError('WebSocket connection failed');
  }, [clientId, deploymentId, component, tailLines, enabled]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
  }, []);

  const clear = useCallback(() => setLines([]), []);

  useEffect(() => {
    if (enabled) connect();
    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect, enabled]);

  return { lines, connected, error, disconnect, clear, reconnect: connect };
}

export function useTerminal(
  deploymentId: string,
  options: { component?: string; shell?: string; enabled?: boolean } = {},
) {
  const { clientId } = useClientContext();
  const { component, shell = '/bin/sh', enabled = true } = options;
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(
    (onData: (data: string) => void) => {
      if (!clientId || !deploymentId) return;

      const params = new URLSearchParams();
      if (component) params.set('component', component);
      params.set('shell', shell);

      const url = buildWsUrl(`/api/v1/clients/${clientId}/deployments/${deploymentId}/terminal?${params}`);
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => { setConnected(true); setError(null); };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'stdout' || msg.type === 'stderr') {
            onData(msg.data);
          } else if (msg.type === 'error') {
            setError(msg.message);
          } else if (msg.type === 'exit') {
            setConnected(false);
          }
        } catch { /* ignore */ }
      };

      ws.onclose = () => setConnected(false);
      ws.onerror = () => setError('Terminal connection failed');
    },
    [clientId, deploymentId, component, shell],
  );

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
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
  }, []);

  useEffect(() => () => { wsRef.current?.close(); }, []);

  return { connect, send, resize, disconnect, connected, error };
}
