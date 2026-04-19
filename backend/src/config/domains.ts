/**
 * Platform base-domain + derived subdomains.
 *
 * Every user-facing hostname on the platform is a subdomain of a single
 * `PLATFORM_BASE_DOMAIN`:
 *
 *   admin.<base>      — admin panel (login, settings, client mgmt)
 *   client.<base>     — client panel (customer's own dashboard)
 *   mail.<base>       — Stalwart SMTP/IMAP/POP3 banner + TLS SAN
 *   mail-admin.<base> — Stalwart web-admin (behind platform auth_request)
 *   dex.<base>        — Dex OIDC issuer
 *   webmail.<base>    — platform-wide Roundcube (per-client-domain
 *                       `webmail.<clientdomain>` ingresses are separate)
 *
 * The base domain comes from env (`PLATFORM_BASE_DOMAIN`), populated by
 * bootstrap.sh (prod: operator-provided) or the dev overlay ConfigMap
 * (dev: k8s-platform.test). Dev and prod only differ in port number —
 * the subdomain structure is identical.
 *
 * No hostname should be hard-coded in deployment manifests, scripts, or
 * application code. Callers pass the AppConfig (or a subset) to these
 * helpers and let them compose.
 */

export const DEV_DEFAULT_BASE_DOMAIN = 'k8s-platform.test';

export interface BaseDomainConfig {
  readonly PLATFORM_BASE_DOMAIN?: string;
  readonly INGRESS_BASE_DOMAIN?: string;
}

/**
 * Resolve the base domain. Priority:
 *   1. PLATFORM_BASE_DOMAIN (canonical)
 *   2. INGRESS_BASE_DOMAIN (legacy pre-rename, still honored so existing
 *      ConfigMaps don't break)
 *   3. Dev default (`k8s-platform.test`)
 * Leading dots and whitespace are stripped so `. .acme.com ` and
 * `acme.com` produce the same result.
 */
export function resolveBaseDomain(cfg: BaseDomainConfig): string {
  const raw = cfg.PLATFORM_BASE_DOMAIN ?? cfg.INGRESS_BASE_DOMAIN ?? DEV_DEFAULT_BASE_DOMAIN;
  return raw.trim().replace(/^\.+/, '');
}

function subdomain(prefix: string, cfg: BaseDomainConfig): string {
  return `${prefix}.${resolveBaseDomain(cfg)}`;
}

export const adminHost = (cfg: BaseDomainConfig): string => subdomain('admin', cfg);
export const clientHost = (cfg: BaseDomainConfig): string => subdomain('client', cfg);
export const mailHost = (cfg: BaseDomainConfig): string => subdomain('mail', cfg);
export const mailAdminHost = (cfg: BaseDomainConfig): string => subdomain('mail-admin', cfg);
export const dexHost = (cfg: BaseDomainConfig): string => subdomain('dex', cfg);
export const webmailHost = (cfg: BaseDomainConfig): string => subdomain('webmail', cfg);
