// Runtime configuration - overwritten at container startup via envsubst.
// During local development (vite dev), this file is served as-is and
// the app falls back to VITE_* env vars or sensible defaults.
window.__RUNTIME_CONFIG__ = {
  API_URL: "",
  CLIENT_PANEL_URL: "",
};
