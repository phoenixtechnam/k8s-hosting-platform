import { useCallback, useEffect, useState } from 'react';
import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
} from '@simplewebauthn/browser';
import type { PasskeySummary, PasskeyMode } from '@k8s-hosting/api-contracts';
import { apiFetch } from '@/lib/api-client';

const PANEL = 'client' as const;

/**
 * Top-level hook for the client panel. Provides:
 *   • register(nickname)       — enroll a new passkey on the current user
 *   • loginUserless()          — sign in with passkey only (no email field)
 *   • complete2FA(token)       — finish a 2FA flow that started with password
 *   • list / remove / setMode  — manage existing credentials
 *
 * Backend-aligned errors propagate via the apiFetch ApiError envelope.
 */
export function usePasskey() {
  const [supported, setSupported] = useState<boolean>(false);

  useEffect(() => {
    setSupported(typeof window !== 'undefined' && browserSupportsWebAuthn());
  }, []);

  /** Enroll a new credential. Caller must already be logged in. */
  const register = useCallback(async (nickname: string) => {
    const optionsResp = await apiFetch<{ data: unknown }>('/api/v1/auth/passkey/registration/options', {
      method: 'POST',
      body: JSON.stringify({ panel: PANEL }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const attResp = await startRegistration({ optionsJSON: optionsResp.data as any });
    const verifyResp = await apiFetch<{ data: { id: string; nickname: string } }>('/api/v1/auth/passkey/registration/verify', {
      method: 'POST',
      body: JSON.stringify({ panel: PANEL, response: attResp, nickname }),
    });
    return verifyResp.data;
  }, []);

  /** Userless login. Browser shows passkey picker; no email needed. */
  const loginUserless = useCallback(async () => {
    const optionsResp = await apiFetch<{ data: unknown }>('/api/v1/auth/passkey/login/options', {
      method: 'POST',
      body: JSON.stringify({ panel: PANEL }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assertion = await startAuthentication({ optionsJSON: optionsResp.data as any });
    const verifyResp = await apiFetch<{
      data: {
        token: string;
        refreshToken: string;
        user: {
          id: string; email: string; fullName: string; role: string;
          panel?: string; clientId?: string | null;
        };
      };
    }>('/api/v1/auth/passkey/login/verify', {
      method: 'POST',
      body: JSON.stringify({ panel: PANEL, response: assertion }),
    });
    return verifyResp.data;
  }, []);

  /** Finish a 2FA login. Caller already obtained pre_auth_token from /auth/login. */
  const complete2FA = useCallback(async (preAuthToken: string) => {
    const optionsResp = await apiFetch<{ data: unknown }>('/api/v1/auth/passkey/login/options', {
      method: 'POST',
      body: JSON.stringify({ panel: PANEL, pre_auth_token: preAuthToken }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assertion = await startAuthentication({ optionsJSON: optionsResp.data as any });
    const verifyResp = await apiFetch<{
      data: {
        token: string;
        refreshToken: string;
        user: {
          id: string; email: string; fullName: string; role: string;
          panel?: string; clientId?: string | null;
        };
      };
    }>('/api/v1/auth/passkey/login/verify', {
      method: 'POST',
      body: JSON.stringify({
        panel: PANEL,
        pre_auth_token: preAuthToken,
        response: assertion,
      }),
    });
    return verifyResp.data;
  }, []);

  /** List the current user's passkeys + their mode. */
  const list = useCallback(async (): Promise<{ passkeys: PasskeySummary[]; mode: PasskeyMode }> => {
    const resp = await apiFetch<{ data: { passkeys: PasskeySummary[]; mode: PasskeyMode } }>('/api/v1/auth/passkey');
    return resp.data;
  }, []);

  /** Remove a passkey by id. */
  const remove = useCallback(async (id: string) => {
    await apiFetch(`/api/v1/auth/passkey/${id}`, { method: 'DELETE' });
  }, []);

  /** Switch passkey mode for the current user. */
  const setMode = useCallback(async (mode: PasskeyMode) => {
    await apiFetch('/api/v1/auth/passkey-mode', {
      method: 'PATCH',
      body: JSON.stringify({ mode }),
    });
  }, []);

  return { supported, register, loginUserless, complete2FA, list, remove, setMode };
}
