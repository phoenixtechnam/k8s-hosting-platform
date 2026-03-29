import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { Loader2, Globe, Shield } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { apiFetch } from '@/lib/api-client';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

interface AuthStatus {
  readonly localAuthEnabled: boolean;
  readonly providers: readonly { id: string; displayName: string }[];
}

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);

  const { login, error, setTokenAndUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? '/';

  useEffect(() => {
    apiFetch<{ data: AuthStatus }>('/api/v1/auth/oidc/status?panel=client')
      .then((res) => setAuthStatus(res.data))
      .catch(() => setAuthStatus({ localAuthEnabled: true, providers: [] }));
  }, []);

  useEffect(() => {
    const token = searchParams.get('token');
    const userJson = searchParams.get('user');
    if (token && userJson) {
      try {
        const user = JSON.parse(decodeURIComponent(userJson));
        setTokenAndUser(token, user);
        navigate('/', { replace: true });
      } catch { /* ignore */ }
    }
  }, [searchParams, navigate, setTokenAndUser]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try { await login(email, password); navigate(from, { replace: true }); }
    catch { /* error in store */ } finally { setSubmitting(false); }
  };

  const handleSso = (providerId: string) => {
    const callbackUrl = `${window.location.origin}/login`;
    window.location.href = `${API_BASE}/api/v1/auth/oidc/authorize/${providerId}?redirect_uri=${encodeURIComponent(callbackUrl)}`;
  };

  const showLocalAuth = authStatus?.localAuthEnabled ?? true;
  const providers = authStatus?.providers ?? [];
  const oidcError = searchParams.get('error');

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-500 to-accent-500 dark:from-gray-900 dark:to-gray-800 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-gray-800 p-8 shadow-xl">
        <div className="mb-6 flex flex-col items-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-500 text-white"><Globe size={24} /></div>
          <h1 className="mt-4 text-xl font-bold text-gray-900 dark:text-gray-100">Client Portal</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Sign in to manage your hosting</p>
        </div>

        {(error || oidcError) && (
          <div className="mb-4 rounded-lg bg-red-50 dark:bg-red-900/30 px-4 py-3 text-sm text-red-600 dark:text-red-400" data-testid="login-error">
            {error ?? decodeURIComponent(oidcError ?? '')}
          </div>
        )}

        {providers.map((p) => (
          <button key={p.id} type="button" onClick={() => handleSso(p.id)} className="mb-2 flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50" data-testid={`sso-button-${p.id}`}>
            <Shield size={16} /> Sign in with {p.displayName}
          </button>
        ))}

        {providers.length > 0 && showLocalAuth && (
          <div className="my-4 flex items-center gap-3"><div className="flex-1 border-t border-gray-200 dark:border-gray-700" /><span className="text-xs text-gray-400 dark:text-gray-500">or</span><div className="flex-1 border-t border-gray-200 dark:border-gray-700" /></div>
        )}

        {showLocalAuth && (
          <form onSubmit={handleSubmit} className="space-y-4" data-testid="login-form">
            <div><label htmlFor="email" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Email</label><input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2.5 text-sm dark:bg-gray-700 dark:text-gray-100" placeholder="you@example.com" data-testid="email-input" /></div>
            <div><label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">Password</label><input id="password" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2.5 text-sm dark:bg-gray-700 dark:text-gray-100" placeholder="Enter your password" data-testid="password-input" /></div>
            <button type="submit" disabled={submitting} className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50" data-testid="login-button">{submitting && <Loader2 size={16} className="animate-spin" />} Sign In</button>
          </form>
        )}
      </div>
    </div>
  );
}
