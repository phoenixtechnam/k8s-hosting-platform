/**
 * Runtime configuration.
 *
 * API_URL defaults to '' (same-origin). In all environments the frontend
 * nginx (or Vite dev proxy) reverse-proxies /api/* to the backend, so the
 * browser never needs a cross-origin API URL.
 *
 * Override via window.__RUNTIME_CONFIG__ (container startup) or VITE_* env
 * vars (local dev without proxy, if ever needed).
 */

interface RuntimeConfig {
  API_URL: string;
  CLIENT_PANEL_URL: string;
}

declare global {
  interface Window {
    __RUNTIME_CONFIG__?: Partial<RuntimeConfig>;
  }
}

function getConfig(): RuntimeConfig {
  const runtime = window.__RUNTIME_CONFIG__ ?? {};
  return {
    API_URL:
      runtime.API_URL ??
      import.meta.env.VITE_API_URL ??
      '',
    CLIENT_PANEL_URL:
      runtime.CLIENT_PANEL_URL ||
      import.meta.env.VITE_CLIENT_PANEL_URL ||
      '',
  };
}

export const config = getConfig();
