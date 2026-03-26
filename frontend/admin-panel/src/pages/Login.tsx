import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { Loader2, Server, Shield } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { apiFetch } from '@/lib/api-client';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

interface OidcStatus {
  readonly enabled: boolean;
  readonly disableLocalAuth: boolean;
}

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [oidcStatus, setOidcStatus] = useState<OidcStatus | null>(null);

  const { login, error, setTokenAndUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? '/';

  // Check OIDC status on mount
  useEffect(() => {
    apiFetch<{ data: OidcStatus }>('/api/v1/auth/oidc/status')
      .then((res) => setOidcStatus(res.data))
      .catch(() => setOidcStatus({ enabled: false, disableLocalAuth: false }));
  }, []);

  // Handle OIDC callback (token in URL params)
  useEffect(() => {
    const token = searchParams.get('token');
    const userJson = searchParams.get('user');
    const oidcError = searchParams.get('error');

    if (token && userJson) {
      try {
        const user = JSON.parse(decodeURIComponent(userJson));
        setTokenAndUser(token, user);
        navigate('/', { replace: true });
      } catch {
        // invalid user JSON — ignore
      }
    }

    if (oidcError) {
      // Error will be displayed via the error state
    }
  }, [searchParams, navigate, setTokenAndUser]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch {
      // error is set in the store
    } finally {
      setSubmitting(false);
    }
  };

  const handleSsoLogin = () => {
    const callbackUrl = `${window.location.origin}/login`;
    window.location.href = `${API_BASE}/api/v1/auth/oidc/authorize?redirect_uri=${encodeURIComponent(callbackUrl)}`;
  };

  const showLocalAuth = !oidcStatus?.disableLocalAuth;
  const showSso = oidcStatus?.enabled;
  const oidcError = searchParams.get('error');

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-500 to-accent-500 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-xl">
        <div className="mb-6 flex flex-col items-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-500 text-white">
            <Server size={24} />
          </div>
          <h1 className="mt-4 text-xl font-bold text-gray-900">K8s Hosting Platform</h1>
          <p className="mt-1 text-sm text-gray-500">Sign in to admin panel</p>
        </div>

        {(error || oidcError) && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600" data-testid="login-error">
            {error ?? decodeURIComponent(oidcError ?? '')}
          </div>
        )}

        {showSso && (
          <>
            <button
              type="button"
              onClick={handleSsoLogin}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
              data-testid="sso-login-button"
            >
              <Shield size={16} />
              Sign in with SSO
            </button>
            {showLocalAuth && (
              <div className="my-4 flex items-center gap-3">
                <div className="flex-1 border-t border-gray-200" />
                <span className="text-xs text-gray-400">or</span>
                <div className="flex-1 border-t border-gray-200" />
              </div>
            )}
          </>
        )}

        {showLocalAuth && (
          <form onSubmit={handleSubmit} className="space-y-4" data-testid="login-form">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                placeholder="admin@platform.local"
                data-testid="email-input"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                placeholder="Enter your password"
                data-testid="password-input"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-600 disabled:opacity-50"
              data-testid="login-button"
            >
              {submitting && <Loader2 size={16} className="animate-spin" />}
              Sign In
            </button>
          </form>
        )}

        {!showLocalAuth && !showSso && (
          <p className="text-center text-sm text-gray-500">Loading authentication options...</p>
        )}
      </div>
    </div>
  );
}
