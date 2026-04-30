import { create } from 'zustand';
import { apiFetch, ApiError } from '@/lib/api-client';

interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: string;
  readonly panel?: string;
  readonly clientId?: string | null;
}

/**
 * 2FA challenge state. When a password login succeeds for a user that
 * has passkey_mode='second_factor', the backend returns
 * `requires_passkey` instead of session tokens. The Login UI uses this
 * state to render the passkey-prompt step.
 */
export interface PasskeyChallenge {
  readonly preAuthToken: string;
  readonly expiresIn: number;
  readonly user: AuthUser;
}

interface AuthState {
  readonly token: string | null;
  readonly user: AuthUser | null;
  readonly isAuthenticated: boolean;
  readonly isLoading: boolean;
  readonly error: string | null;
  /** Set after step 1 (password) when the user is in 2FA mode. The
   *  Login page transitions to the passkey-verify view. Cleared on
   *  successful 2FA, on cancel, and on every fresh password login. */
  readonly passkeyChallenge: PasskeyChallenge | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  initialize: () => void;
  setTokenAndUser: (token: string, user: AuthUser) => void;
  clearPasskeyChallenge: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  token: null,
  user: null,
  isAuthenticated: false,
  isLoading: true,
  error: null,
  passkeyChallenge: null,

  initialize: () => {
    const token = localStorage.getItem('auth_token');
    const userJson = localStorage.getItem('auth_user');
    if (token && userJson) {
      try {
        const user = JSON.parse(userJson) as AuthUser;
        set({ token, user, isAuthenticated: true, isLoading: false });

        // Verify token is still valid with backend (async, non-blocking)
        apiFetch<{ data: { id: string; email: string; fullName: string; role: string; clientId?: string } }>('/api/v1/auth/me')
          .then((res) => {
            const freshUser = res.data;
            localStorage.setItem('auth_user', JSON.stringify(freshUser));
            set({ user: freshUser });
          })
          .catch(() => {
            // Token invalid — clear and redirect (handled by api-client 401 handler)
            // Guard: localStorage may not exist if test environment was torn down
            try {
              localStorage.removeItem('auth_token');
              localStorage.removeItem('auth_user');
            } catch { /* env torn down */ }
            set({ token: null, user: null, isAuthenticated: false, isLoading: false });
          });
      } catch {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_user');
        set({ isLoading: false });
      }
    } else {
      set({ isLoading: false });
    }
  },

  login: async (email: string, password: string) => {
    set({ isLoading: true, error: null, passkeyChallenge: null });
    try {
      const res = await apiFetch<{
        data:
          | {
              // Normal login (mode = NULL or 'alternative').
              token: string;
              refreshToken: string;
              expiresIn: number;
              refreshExpiresIn: number;
              user: AuthUser;
            }
          | {
              // 2FA branch (mode = 'second_factor'). UI transitions
              // to the passkey-verify step before issuing tokens.
              requires_passkey: true;
              pre_auth_token: string;
              expires_in: number;
              user: AuthUser;
            };
      }>('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, panel: 'admin' }),
      });

      if ('requires_passkey' in res.data) {
        set({
          isLoading: false,
          passkeyChallenge: {
            preAuthToken: res.data.pre_auth_token,
            expiresIn: res.data.expires_in,
            user: res.data.user,
          },
        });
        return;
      }

      const { token, refreshToken, user } = res.data;
      localStorage.setItem('auth_token', token);
      localStorage.setItem('auth_refresh_token', refreshToken);
      localStorage.setItem('auth_user', JSON.stringify(user));
      set({ token, user, isAuthenticated: true, isLoading: false });
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'Login failed. Please try again.';
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  logout: async () => {
    // Phase 3: notify the backend so the refresh token is revoked
    // server-side. Fire-and-forget — even if the server is unreachable
    // we still clear local state so the UI returns to the login page.
    const refreshToken = localStorage.getItem('auth_refresh_token');
    if (refreshToken) {
      try {
        await apiFetch('/api/v1/auth/logout', {
          method: 'POST',
          body: JSON.stringify({ refreshToken }),
        });
      } catch {
        // best-effort
      }
    }
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_refresh_token');
    localStorage.removeItem('auth_user');
    set({ token: null, user: null, isAuthenticated: false, error: null });
  },

  setTokenAndUser: (token: string, user: AuthUser) => {
    localStorage.setItem('auth_token', token);
    localStorage.setItem('auth_user', JSON.stringify(user));
    set({ token, user, isAuthenticated: true, isLoading: false, error: null, passkeyChallenge: null });
  },

  clearPasskeyChallenge: () => set({ passkeyChallenge: null }),
}));
