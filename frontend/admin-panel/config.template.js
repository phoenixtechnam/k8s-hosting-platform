// Injected at container startup by docker-entrypoint.sh via envsubst.
window.__RUNTIME_CONFIG__ = {
  API_URL: "${API_URL}",
  CLIENT_PANEL_URL: "${CLIENT_PANEL_URL}",
  STALWART_ADMIN_URL: "${STALWART_ADMIN_URL}",
};
