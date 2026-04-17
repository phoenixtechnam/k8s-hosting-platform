import { webadminUrlResponseSchema, type WebadminUrlResponse } from '@k8s-hosting/api-contracts';

export interface BuildWebadminUrlOptions {
  ingressBaseDomain: string | undefined;
  platformEnv: string | undefined;
  explicitUrl?: string | undefined;
  explicitUsername?: string | undefined;
  devIngressPort?: number | undefined;
}

const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_DEV_PORT = 2010;

/**
 * Returns the URL + username the admin UI should use to launch Stalwart's
 * web-admin in a new tab.
 *
 * Resolution order:
 *   1. `explicitUrl` (STALWART_WEBADMIN_URL env) — wins unconditionally.
 *   2. `https://mail.<ingressBaseDomain>/` for production (TLS via cert-manager).
 *   3. `http://mail.<ingressBaseDomain>:<devIngressPort>/` for dev/staging
 *      (HTTP ingress on :2010, no cert hassle).
 *
 * The username defaults to the Stalwart fallback-admin user (`admin`).
 * Callers can override via STALWART_WEBADMIN_USERNAME if their auth backend
 * uses a different principal.
 */
export function buildWebadminUrl(opts: BuildWebadminUrlOptions): WebadminUrlResponse {
  const username = opts.explicitUsername?.trim() || DEFAULT_ADMIN_USERNAME;

  let candidate: WebadminUrlResponse;
  if (opts.explicitUrl) {
    candidate = { url: opts.explicitUrl, username };
  } else if (!opts.ingressBaseDomain) {
    throw new Error(
      'Stalwart web-admin URL not configured. Set INGRESS_BASE_DOMAIN or STALWART_WEBADMIN_URL.',
    );
  } else {
    const isDev =
      opts.platformEnv === 'dev' ||
      opts.platformEnv === 'development' ||
      opts.platformEnv === 'staging';
    const url = isDev
      ? `http://mail.${opts.ingressBaseDomain}:${opts.devIngressPort ?? DEFAULT_DEV_PORT}/`
      : `https://mail.${opts.ingressBaseDomain}/`;
    candidate = { url, username };
  }

  // Validate the final URL through the contract schema so an operator-supplied
  // STALWART_WEBADMIN_URL can't inject a bogus or dangerous value (e.g. a
  // javascript: or empty-string URL) that would later end up in an <a href>.
  return webadminUrlResponseSchema.parse(candidate);
}
