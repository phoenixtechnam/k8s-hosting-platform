/**
 * Runtime configuration injected via config.js at container startup.
 * Falls back to Vite build-time env vars, then to defaults.
 *
 * Priority: window.__RUNTIME_CONFIG__ > import.meta.env.VITE_* > default
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
      runtime.API_URL ||
      import.meta.env.VITE_API_URL ||
      'http://localhost:3000',
    CLIENT_PANEL_URL:
      runtime.CLIENT_PANEL_URL ||
      import.meta.env.VITE_CLIENT_PANEL_URL ||
      'http://localhost:5174',
  };
}

export const config = getConfig();
