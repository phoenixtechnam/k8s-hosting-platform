import fs from 'node:fs';
import path from 'node:path';
import {
  stalwartCredentialsResponseSchema,
  type StalwartCredentialsResponse,
} from '@k8s-hosting/api-contracts';

/**
 * Resolve the Stalwart fallback-admin credentials.
 *
 * Sources (first match wins):
 *   1. Secret volume mount at STALWART_ADMIN_CREDS_DIR (default
 *      `/etc/stalwart-creds`). The Rotate endpoint patches the k8s
 *      Secret; kubelet refreshes the mounted file within ~60s, so
 *      platform-api picks up rotations without a pod restart.
 *   2. STALWART_ADMIN_PASSWORD env (legacy, still honored)
 *   3. STALWART_ADMIN_SECRET_PLAIN / ADMIN_SECRET_PLAIN (older names)
 *
 * Throws when nothing works — the route converts that into a 503.
 */
export function readStalwartCredentials(env: NodeJS.ProcessEnv): StalwartCredentialsResponse {
  const rawPassword =
    readPasswordFromFile(env) ??
    env.STALWART_ADMIN_PASSWORD ??
    env.STALWART_ADMIN_SECRET_PLAIN ??
    env.ADMIN_SECRET_PLAIN ??
    '';
  const password = rawPassword.trim();
  if (!password) {
    throw new Error(
      'Stalwart admin password is not configured — expected a mounted secret at STALWART_ADMIN_CREDS_DIR/ADMIN_SECRET_PLAIN or the STALWART_ADMIN_PASSWORD env var.',
    );
  }
  const rawUsername = env.STALWART_ADMIN_USER?.trim();
  const username = rawUsername && rawUsername.length > 0 ? rawUsername : 'admin';

  // Pass through the shared schema so response shape stays in lockstep
  // with the contract package even if the fields evolve.
  return stalwartCredentialsResponseSchema.parse({ username, password });
}

function readPasswordFromFile(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env.STALWART_ADMIN_CREDS_DIR?.trim();
  if (!dir) return undefined;
  const file = path.join(dir, 'ADMIN_SECRET_PLAIN');
  try {
    const content = fs.readFileSync(file, 'utf8');
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    // Missing file → fall back to env. Don't log; this is the expected
    // path in unit tests and non-mounted deployments.
    return undefined;
  }
}
