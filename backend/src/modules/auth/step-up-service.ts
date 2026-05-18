import { eq } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import { verifyPassword } from './service.js';
import type { StepUpMethod } from '@k8s-hosting/api-contracts';

// Default freshness window for any step-up-gated operation. 30 minutes
// matches typical session-step-up windows in IAM products and gives
// the operator a friction-free workflow while still expiring a stale
// session before a privileged action.
export const DEFAULT_STEP_UP_MAX_AGE_MS = 30 * 60 * 1000;

export interface StepUpStatus {
  readonly required: boolean;
  readonly methods: readonly StepUpMethod[];
  readonly lastCredentialCheckAt: Date | null;
  readonly maxAgeMs: number;
}

/**
 * Returns whether the user must re-authenticate to perform a privileged
 * action, plus the methods they have available. NEVER throws — a
 * non-existent or inactive user simply returns `required:true` with an
 * empty methods array, which the caller surfaces as STEP_UP_REQUIRED.
 *
 * Freshness clock:
 *   • `lastCredentialCheckAt IS NULL`  → required = true
 *   • `now - lastCredentialCheckAt > maxAgeMs` → required = true
 *   • otherwise required = false
 *
 * Method enumeration:
 *   • passwordHash present  → 'password' available
 *   • passkeyMode IN ('alternative','second_factor') → 'passkey' available
 *
 * Users with NO method available (passwordHash NULL AND passkeyMode NULL —
 * happens with OIDC-only accounts) return `required:true, methods:[]` —
 * the caller MUST 409 the operation as STEP_UP_UNAVAILABLE since there
 * is no way to step up.
 */
export async function getStepUpStatus(
  db: Database,
  userId: string,
  maxAgeMs: number = DEFAULT_STEP_UP_MAX_AGE_MS,
): Promise<StepUpStatus> {
  const [user] = await db
    .select({
      passwordHash: users.passwordHash,
      passkeyMode: users.passkeyMode,
      status: users.status,
      lastCredentialCheckAt: users.lastCredentialCheckAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || user.status !== 'active') {
    return { required: true, methods: [], lastCredentialCheckAt: null, maxAgeMs };
  }

  const methods: StepUpMethod[] = [];
  if (user.passwordHash) methods.push('password');
  if (user.passkeyMode === 'alternative' || user.passkeyMode === 'second_factor') {
    methods.push('passkey');
  }

  const last = user.lastCredentialCheckAt;
  if (!last) {
    return { required: true, methods, lastCredentialCheckAt: null, maxAgeMs };
  }
  const ageMs = Date.now() - last.getTime();
  const required = ageMs > maxAgeMs;
  return { required, methods, lastCredentialCheckAt: last, maxAgeMs };
}

/**
 * Verify a password as a step-up challenge. Does NOT issue session
 * tokens; only proves the credential and bumps the freshness clock so
 * subsequent privileged operations succeed.
 *
 * Throws ApiError on bad credentials. Mirror of `verifyPassword` in
 * auth/service.ts but scoped to step-up so we can keep the rate-limit
 * + audit semantics distinct.
 */
export async function verifyStepUpPassword(
  db: Database,
  userId: string,
  password: string,
): Promise<Date> {
  if (!password) {
    throw new ApiError('VALIDATION_ERROR', 'Password is required', 400);
  }
  const [user] = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user || user.status !== 'active') {
    throw new ApiError('STEP_UP_FAILED', 'Step-up authentication failed', 401);
  }
  if (!user.passwordHash) {
    throw new ApiError('STEP_UP_METHOD_UNAVAILABLE',
      'Password step-up is not configured for this account', 409);
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    throw new ApiError('STEP_UP_FAILED', 'Step-up authentication failed', 401);
  }

  const now = new Date();
  await db
    .update(users)
    .set({ lastCredentialCheckAt: now })
    .where(eq(users.id, userId));
  return now;
}
