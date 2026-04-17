import {
  stalwartCredentialsResponseSchema,
  type StalwartCredentialsResponse,
} from '@k8s-hosting/api-contracts';

/**
 * Resolve the Stalwart fallback-admin credentials from a given env map.
 *
 * Env precedence (first match wins):
 *   - STALWART_ADMIN_PASSWORD  (canonical)
 *   - STALWART_ADMIN_SECRET_PLAIN
 *   - ADMIN_SECRET_PLAIN       (legacy — matches the Secret key name)
 *
 * Username defaults to `admin` (Stalwart's fallback-admin user).
 *
 * Throws when no password-like env var is usable, so the route can translate
 * that into a user-visible 503 without leaking which env names were tried.
 */
export function readStalwartCredentials(env: NodeJS.ProcessEnv): StalwartCredentialsResponse {
  const rawPassword =
    env.STALWART_ADMIN_PASSWORD ?? env.STALWART_ADMIN_SECRET_PLAIN ?? env.ADMIN_SECRET_PLAIN ?? '';
  const password = rawPassword.trim();
  if (!password) {
    throw new Error(
      'STALWART_ADMIN_PASSWORD is not configured — set it (or ADMIN_SECRET_PLAIN) in the platform-api env.',
    );
  }
  const rawUsername = env.STALWART_ADMIN_USER?.trim();
  const username = rawUsername && rawUsername.length > 0 ? rawUsername : 'admin';

  // Pass through the shared schema so response shape stays in lockstep
  // with the contract package even if the fields evolve.
  return stalwartCredentialsResponseSchema.parse({ username, password });
}
