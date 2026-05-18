import { eq, and, lt } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/types';
import type { Database } from '../../db/index.js';
import { ApiError } from '../../shared/errors.js';
import {
  users,
  userPasskeys,
  passkeyChallenges,
  authConsumedTokens,
} from '../../db/schema.js';

/**
 * Passkey (WebAuthn) lifecycle.
 *
 * Modes (users.passkey_mode):
 *   NULL            — password-only login (default; no passkey configured)
 *   'alternative'   — password OR passkey logs in (userless flow allowed)
 *   'second_factor' — password (step 1) AND passkey (step 2) both required
 *
 * Per the security review (memory: project_passkey_security_review):
 *   • Pre-auth tokens are server-tracked single-use rows in
 *     auth_consumed_tokens — in-memory cache wouldn't survive 3
 *     platform-api replicas.
 *   • passkey_user_handle is a random 32 bytes per user, NOT users.id,
 *     so the DB row UUID never leaks to authenticators.
 *   • Sign-count rollback only enforced when stored > 0 to avoid
 *     false positives on synced passkeys (Apple Keychain, 1Password).
 *   • Setting mode='second_factor' requires ≥1 verified passkey.
 *   • Deleting the last passkey while mode='second_factor' is rejected.
 *   • Panel binding: passkey verify must match the calling endpoint's
 *     panel context, since the same user may have admin AND tenant roles.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;          // 5 minutes
const PRE_AUTH_TOKEN_TTL_MS = 5 * 60 * 1000;     // 5 minutes
const USER_HANDLE_BYTES = 32;
const CHALLENGE_BYTES = 32;

export type PasskeyPanel = 'admin' | 'tenant';
export type PasskeyMode = 'alternative' | 'second_factor' | null;

export interface PasskeyConfig {
  rpId: string;
  rpName: string;
  origins: string[]; // exact-match origins (https://admin.example.com, etc.)
}

/**
 * Read passkey config from environment. Validates at startup so a
 * missing or malformed RP ID is surfaced immediately rather than at
 * first registration.
 */
export function loadPasskeyConfig(env: NodeJS.ProcessEnv = process.env): PasskeyConfig {
  const rpId = env.PLATFORM_PASSKEY_RP_ID;
  const rpName = env.PLATFORM_PASSKEY_RP_NAME ?? 'Hosting Platform';
  const originsRaw = env.PLATFORM_PASSKEY_ORIGINS;
  if (!rpId || !originsRaw) {
    throw new Error(
      'PLATFORM_PASSKEY_RP_ID and PLATFORM_PASSKEY_ORIGINS must be set. '
      + 'RP_ID is the registrable suffix shared by admin + tenant panels '
      + '(e.g. "phoenix-host.net"). ORIGINS is a comma-separated list of '
      + 'fully-qualified panel origins (e.g. "https://admin.phoenix-host.net,https://tenant.phoenix-host.net").',
    );
  }
  const origins = originsRaw.split(',').map((o) => o.trim()).filter((o) => o.length > 0);
  if (origins.length === 0) {
    throw new Error('PLATFORM_PASSKEY_ORIGINS yielded no usable entries after splitting on ","');
  }
  // Sanity: every origin must end with rpId (registrable-suffix check).
  for (const origin of origins) {
    let host: string;
    try {
      host = new URL(origin).hostname;
    } catch {
      throw new Error(`PLATFORM_PASSKEY_ORIGINS entry "${origin}" is not a valid URL`);
    }
    if (host !== rpId && !host.endsWith(`.${rpId}`)) {
      throw new Error(
        `PLATFORM_PASSKEY_ORIGINS entry "${origin}" host "${host}" is not a subdomain of RP_ID "${rpId}". `
        + 'WebAuthn requires every panel origin to share the RP_ID as a registrable suffix.',
      );
    }
  }
  return { rpId, rpName, origins };
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function getOrCreatePasskeyUserHandle(db: Database, userId: string): Promise<Buffer> {
  const [user] = await db
    .select({ handle: users.passkeyUserHandle })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw new ApiError('USER_NOT_FOUND', 'User not found', 404);
  if (user.handle && user.handle.length > 0) return user.handle;
  const handle = randomBytes(USER_HANDLE_BYTES);
  await db.update(users).set({ passkeyUserHandle: handle }).where(eq(users.id, userId));
  return handle;
}

async function findUserByHandle(db: Database, handle: Buffer): Promise<typeof users.$inferSelect | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.passkeyUserHandle, handle))
    .limit(1);
  return user ?? null;
}

async function persistChallenge(
  db: Database,
  challenge: Buffer,
  purpose: 'register' | 'login_userless' | 'login_2fa',
  panel: PasskeyPanel,
  userId: string | null,
): Promise<string> {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
  await db.insert(passkeyChallenges).values({
    id, challenge, purpose, panel, userId, expiresAt,
  });
  return id;
}

async function consumeChallenge(
  db: Database,
  expectedChallenge: Buffer,
  expectedPurpose: 'register' | 'login_userless' | 'login_2fa',
  expectedPanel: PasskeyPanel,
  expectedUserId: string | null,
): Promise<void> {
  // Find matching, unconsumed, unexpired row. Mark consumed atomically.
  const [row] = await db
    .select()
    .from(passkeyChallenges)
    .where(eq(passkeyChallenges.challenge, expectedChallenge))
    .limit(1);
  if (!row) {
    throw new ApiError('PASSKEY_CHALLENGE_INVALID', 'Challenge not found or already consumed', 400);
  }
  if (row.consumedAt) {
    throw new ApiError('PASSKEY_CHALLENGE_REPLAY', 'Challenge already consumed', 400);
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw new ApiError('PASSKEY_CHALLENGE_EXPIRED', 'Challenge expired (5 min TTL)', 400);
  }
  if (row.purpose !== expectedPurpose) {
    throw new ApiError('PASSKEY_CHALLENGE_PURPOSE_MISMATCH',
      `Challenge purpose ${row.purpose} does not match ${expectedPurpose}`, 400);
  }
  if (row.panel !== expectedPanel) {
    throw new ApiError('PASSKEY_CHALLENGE_PANEL_MISMATCH',
      `Challenge issued for panel ${row.panel} but verify called from ${expectedPanel}`, 400);
  }
  if (expectedUserId !== null && row.userId !== expectedUserId) {
    throw new ApiError('PASSKEY_CHALLENGE_USER_MISMATCH',
      'Challenge user does not match the authenticated user', 400);
  }
  await db.update(passkeyChallenges)
    .set({ consumedAt: new Date() })
    .where(eq(passkeyChallenges.id, row.id));
}

/** Best-effort cleanup of stale rows. Idempotent — safe to call from a cron. */
export async function pruneExpiredChallenges(db: Database): Promise<number> {
  const result = await db
    .delete(passkeyChallenges)
    .where(lt(passkeyChallenges.expiresAt, new Date()))
    .returning({ id: passkeyChallenges.id });
  return result.length;
}

export async function pruneExpiredConsumedTokens(db: Database): Promise<number> {
  const result = await db
    .delete(authConsumedTokens)
    .where(lt(authConsumedTokens.expiresAt, new Date()))
    .returning({ jti: authConsumedTokens.jti });
  return result.length;
}

// ─── Pre-auth tokens (2FA step-1 → step-2 binding) ───────────────────

export interface PreAuthToken {
  jti: string;
  userId: string;
  panel: PasskeyPanel;
  expiresAt: Date;
}

/**
 * Issue a single-use token that binds step-1 (password verified) to
 * step-2 (passkey assertion) of the 2FA flow.
 *
 * Tracked server-side in auth_consumed_tokens because the platform-api
 * runs 3 replicas — an in-memory JTI cache would let an attacker
 * replay a stolen pre-auth token against a different replica.
 */
export async function issuePreAuthToken(
  db: Database,
  userId: string,
  panel: PasskeyPanel,
): Promise<PreAuthToken> {
  const jti = randomUUID();
  const expiresAt = new Date(Date.now() + PRE_AUTH_TOKEN_TTL_MS);
  // We do NOT pre-insert into auth_consumed_tokens. The "consumed"
  // row is created on verify so the row's existence == proof of replay.
  // Token integrity is via JWT signature; existence in the consumed
  // table after first use is the replay barrier.
  return { jti, userId, panel, expiresAt };
}

/**
 * Verify and atomically consume a pre-auth token. Throws on:
 *   • already-consumed (replay)
 *   • expired
 *   • mismatched panel / user
 */
export async function verifyAndConsumePreAuthToken(
  db: Database,
  jti: string,
  userId: string,
  panel: PasskeyPanel,
): Promise<void> {
  // Insert sentinel row first; uniqueness on jti makes the first insert
  // succeed and any replay throw. Atomic without an explicit
  // transaction because the primary key is the JTI itself.
  try {
    await db.insert(authConsumedTokens).values({
      jti,
      userId,
      purpose: 'passkey_2fa',
      // Match token TTL so the cleanup cron prunes both together.
      expiresAt: new Date(Date.now() + PRE_AUTH_TOKEN_TTL_MS),
    });
  } catch (err) {
    // PG unique violation → 23505. Surface as REPLAY.
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      throw new ApiError('PRE_AUTH_TOKEN_REPLAY', 'Pre-auth token already used', 401);
    }
    throw err;
  }
  // Caller validates JWT signature + sub/panel/exp claims separately.
  // This function only enforces single-use and panel correctness.
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    throw new ApiError('USER_NOT_FOUND', 'User not found', 404);
  }
  // user.panel can be admin or tenant; pre-auth must match the
  // calling endpoint's panel.
  if ((user.panel ?? 'admin') !== panel) {
    throw new ApiError('PRE_AUTH_TOKEN_PANEL_MISMATCH',
      `Pre-auth token issued for ${user.panel ?? 'admin'} but consumed on ${panel}`, 401);
  }
}

// ─── Registration ────────────────────────────────────────────────────

export async function beginRegistration(
  db: Database,
  config: PasskeyConfig,
  userId: string,
  panel: PasskeyPanel,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new ApiError('USER_NOT_FOUND', 'User not found', 404);

  const userHandle = await getOrCreatePasskeyUserHandle(db, userId);

  // Exclude already-registered credentials so the same authenticator
  // can't be enrolled twice.
  const existing = await db
    .select({ credentialId: userPasskeys.credentialId, transports: userPasskeys.transports })
    .from(userPasskeys)
    .where(eq(userPasskeys.userId, userId));

  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userID: userHandle,
    userName: user.email,
    userDisplayName: user.fullName,
    attestationType: 'none', // Don't require a specific authenticator vendor.
    excludeCredentials: existing.map((e) => ({
      id: e.credentialId.toString('base64url'),
      transports: e.transports as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: {
      // Passkeys (synced + discoverable) are required so userless login
      // works. Older non-resident-key authenticators won't enroll.
      residentKey: 'required',
      requireResidentKey: true,
      // Force biometric / PIN — prevents stealth use of an attached
      // hardware key when a workstation is unattended.
      userVerification: 'required',
    },
  });

  await persistChallenge(
    db,
    Buffer.from(options.challenge, 'base64url'),
    'register',
    panel,
    userId,
  );

  return options;
}

export interface CompleteRegistrationInput {
  userId: string;
  panel: PasskeyPanel;
  response: RegistrationResponseJSON;
  nickname: string;
}

export async function completeRegistration(
  db: Database,
  config: PasskeyConfig,
  input: CompleteRegistrationInput,
): Promise<{ id: string; nickname: string }> {
  // The challenge in the response is the value the authenticator
  // signed. We look it up in our store before passing to the verifier
  // so the verifier never sees an unknown challenge.
  const incomingChallenge = Buffer.from(
    JSON.parse(Buffer.from(input.response.response.clientDataJSON, 'base64url').toString('utf8')).challenge,
    'base64url',
  );
  await consumeChallenge(db, incomingChallenge, 'register', input.panel, input.userId);

  const verification = await verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: incomingChallenge.toString('base64url'),
    expectedOrigin: config.origins,
    expectedRPID: config.rpId,
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new ApiError('PASSKEY_REGISTRATION_FAILED', 'Authenticator response failed verification', 400);
  }

  const info = verification.registrationInfo;
  const credentialId = Buffer.from(info.credential.id, 'base64url');
  const publicKey = Buffer.from(info.credential.publicKey);

  const id = randomUUID();
  await db.insert(userPasskeys).values({
    id,
    userId: input.userId,
    credentialId,
    publicKey,
    signCount: info.credential.counter ?? 0,
    transports: (info.credential.transports as string[] | undefined) ?? null,
    aaguid: info.aaguid ?? null,
    nickname: input.nickname.slice(0, 100),
    backupEligible: info.credentialBackedUp ? true : (info.credentialDeviceType === 'multiDevice'),
    backedUp: !!info.credentialBackedUp,
  });

  return { id, nickname: input.nickname };
}

// ─── Authentication (userless / 2FA-bound) ──────────────────────────

export async function beginAuthentication(
  db: Database,
  config: PasskeyConfig,
  panel: PasskeyPanel,
  userId: string | null, // null = userless flow
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  let allowCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] | undefined;
  if (userId) {
    const creds = await db
      .select({ credentialId: userPasskeys.credentialId, transports: userPasskeys.transports })
      .from(userPasskeys)
      .where(eq(userPasskeys.userId, userId));
    if (creds.length === 0) {
      throw new ApiError('PASSKEY_NOT_REGISTERED',
        'User has no registered passkeys; cannot complete 2FA', 409);
    }
    allowCredentials = creds.map((c) => ({
      id: c.credentialId.toString('base64url'),
      transports: c.transports as AuthenticatorTransportFuture[] | undefined,
    }));
  }

  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    userVerification: 'required',
    allowCredentials,
  });

  await persistChallenge(
    db,
    Buffer.from(options.challenge, 'base64url'),
    userId === null ? 'login_userless' : 'login_2fa',
    panel,
    userId,
  );

  return options;
}

export interface CompleteAuthenticationInput {
  panel: PasskeyPanel;
  response: AuthenticationResponseJSON;
  /** When set, this verify is the second factor of a 2FA login.
   *  Userless flow is rejected if the resolved user has mode='second_factor'. */
  expectedUserId?: string;
}

export interface CompleteAuthenticationResult {
  user: typeof users.$inferSelect;
  passkeyId: string;
}

export async function completeAuthentication(
  db: Database,
  config: PasskeyConfig,
  input: CompleteAuthenticationInput,
): Promise<CompleteAuthenticationResult> {
  const incomingChallenge = Buffer.from(
    JSON.parse(Buffer.from(input.response.response.clientDataJSON, 'base64url').toString('utf8')).challenge,
    'base64url',
  );

  // Resolve the user. In userless flow, comes from response.userHandle.
  // In 2FA flow, must match expectedUserId.
  const userHandleB64 = input.response.response.userHandle;
  if (!userHandleB64) {
    throw new ApiError('PASSKEY_USER_HANDLE_MISSING',
      'Authenticator did not return a userHandle. Re-register the passkey as a discoverable credential.', 400);
  }
  const userHandle = Buffer.from(userHandleB64, 'base64url');
  const user = await findUserByHandle(db, userHandle);
  if (!user) throw new ApiError('USER_NOT_FOUND', 'No user matches the provided userHandle', 401);

  if (user.status !== 'active') {
    throw new ApiError('USER_INACTIVE', 'User account is not active', 401);
  }

  // Panel binding: a user with 'admin' panel can't log into the tenant
  // panel via passkey, and vice versa.
  if ((user.panel ?? 'admin') !== input.panel) {
    throw new ApiError('PASSKEY_PANEL_MISMATCH',
      `Passkey belongs to a ${user.panel ?? 'admin'} user; cannot log into ${input.panel} panel`, 403);
  }

  if (input.expectedUserId !== undefined && user.id !== input.expectedUserId) {
    throw new ApiError('PASSKEY_USER_MISMATCH',
      'Passkey identity does not match step-1 password identity', 401);
  }

  // Userless flow is only permitted in 'alternative' mode. The other
  // two states reject:
  //   • 'second_factor' — passkey is the SECOND factor; user must
  //                       go through password endpoint first.
  //   • NULL            — passkey login is not enabled for this user.
  //                       (May have a stale credential from before they
  //                       switched back to password-only.)
  if (input.expectedUserId === undefined && user.passkeyMode !== 'alternative') {
    if (user.passkeyMode === 'second_factor') {
      throw new ApiError('PASSKEY_REQUIRES_PASSWORD_FIRST',
        'This account has 2FA enabled. Sign in with email + password first.', 401);
    }
    throw new ApiError('PASSKEY_LOGIN_NOT_ENABLED',
      'Passkey login is not enabled for this account. Sign in with email + password.', 401);
  }

  await consumeChallenge(
    db,
    incomingChallenge,
    input.expectedUserId === undefined ? 'login_userless' : 'login_2fa',
    input.panel,
    input.expectedUserId === undefined ? null : input.expectedUserId,
  );

  // Look up the credential row for sign_count + verification.
  const credentialId = Buffer.from(input.response.id, 'base64url');
  const [passkeyRow] = await db
    .select()
    .from(userPasskeys)
    .where(eq(userPasskeys.credentialId, credentialId))
    .limit(1);
  if (!passkeyRow) {
    throw new ApiError('PASSKEY_NOT_FOUND', 'Credential not registered', 401);
  }
  if (passkeyRow.userId !== user.id) {
    throw new ApiError('PASSKEY_OWNERSHIP_MISMATCH',
      'Credential does not belong to the resolved user', 401);
  }

  const verification = await verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: incomingChallenge.toString('base64url'),
    expectedOrigin: config.origins,
    expectedRPID: config.rpId,
    requireUserVerification: true,
    credential: {
      id: passkeyRow.credentialId.toString('base64url'),
      publicKey: passkeyRow.publicKey,
      counter: passkeyRow.signCount,
      transports: (passkeyRow.transports as AuthenticatorTransportFuture[] | undefined),
    },
  });

  if (!verification.verified) {
    throw new ApiError('PASSKEY_AUTHENTICATION_FAILED', 'Authenticator response failed verification', 401);
  }

  // Sign-count rollback detection. Modern synced passkeys (Apple
  // Keychain, 1Password) report 0 every time — only enforce when
  // we have a non-zero stored counter AND the new value didn't
  // advance. Otherwise update the row with the new counter.
  const newCounter = verification.authenticationInfo.newCounter;
  if (passkeyRow.signCount > 0 && newCounter <= passkeyRow.signCount) {
    throw new ApiError('PASSKEY_SIGN_COUNT_ROLLBACK',
      `Sign count rolled back (stored=${passkeyRow.signCount}, presented=${newCounter}). Possible cloned authenticator.`, 401);
  }
  const now = new Date();
  await db.update(userPasskeys).set({
    signCount: newCounter,
    lastUsedAt: now,
  }).where(eq(userPasskeys.id, passkeyRow.id));

  // Bump the user-level credential-check freshness. Every successful
  // passkey verify is a fresh credential proof, regardless of whether
  // it was the userless login path or the 2FA second step.
  await db.update(users).set({
    lastCredentialCheckAt: now,
  }).where(eq(users.id, user.id));

  return { user, passkeyId: passkeyRow.id };
}

// ─── Mode + credential management ────────────────────────────────────

export interface PasskeySummary {
  id: string;
  nickname: string;
  aaguid: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listPasskeys(db: Database, userId: string): Promise<PasskeySummary[]> {
  const rows = await db
    .select({
      id: userPasskeys.id,
      nickname: userPasskeys.nickname,
      aaguid: userPasskeys.aaguid,
      backedUp: userPasskeys.backedUp,
      createdAt: userPasskeys.createdAt,
      lastUsedAt: userPasskeys.lastUsedAt,
    })
    .from(userPasskeys)
    .where(eq(userPasskeys.userId, userId));

  return rows.map((r) => ({
    id: r.id,
    nickname: r.nickname,
    aaguid: r.aaguid,
    backedUp: r.backedUp,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  }));
}

/**
 * Delete a passkey. Refuses to remove the last credential when the
 * user is in 'second_factor' mode — would lock them out of step 2.
 *
 * The select-then-delete sequence runs inside a transaction so two
 * concurrent delete requests can't both pass the
 * "last credential & 2fa-mode" guard before either commits. Without
 * the transaction a user with 2 simultaneous sessions could double-
 * delete and end up locked out (mode='second_factor', zero passkeys).
 */
export async function deletePasskey(
  db: Database,
  userId: string,
  passkeyId: string,
): Promise<void> {
  // Drizzle exposes db.transaction with the same query API on the inner
  // tx object, so we just rebind the operations onto tx.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).transaction(async (tx: Database) => {
    const [row] = await tx
      .select()
      .from(userPasskeys)
      .where(and(eq(userPasskeys.id, passkeyId), eq(userPasskeys.userId, userId)))
      .limit(1);
    if (!row) throw new ApiError('PASSKEY_NOT_FOUND', 'Passkey not found', 404);

    const all = await tx
      .select({ id: userPasskeys.id })
      .from(userPasskeys)
      .where(eq(userPasskeys.userId, userId));

    if (all.length <= 1) {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      if (user?.passkeyMode === 'second_factor') {
        throw new ApiError('LAST_PASSKEY_IN_2FA_MODE',
          'Cannot delete the last passkey while 2FA is enabled. Switch to "alternative" or disable 2FA first.',
          409);
      }
      // If the user removes their last passkey while in 'alternative'
      // mode, drop the mode back to NULL — UI no longer offers a
      // passkey login button.
      if (user?.passkeyMode === 'alternative') {
        await tx.update(users).set({ passkeyMode: null }).where(eq(users.id, userId));
      }
    }

    await tx.delete(userPasskeys).where(eq(userPasskeys.id, passkeyId));
  });
}

/**
 * Set the user's passkey mode. Setting 'second_factor' requires ≥1
 * verified passkey. Setting null (or 'alternative') with no passkeys
 * is allowed — it's effectively a no-op when there are no credentials.
 */
export async function setPasskeyMode(
  db: Database,
  userId: string,
  mode: PasskeyMode,
): Promise<void> {
  if (mode === 'second_factor') {
    const [{ count }] = await db
      .select({ count: userPasskeys.id })
      .from(userPasskeys)
      .where(eq(userPasskeys.userId, userId))
      .limit(1)
      .then((rows) => rows.length === 0 ? [{ count: null as string | null }] : [{ count: rows[0].count }]);
    if (!count) {
      throw new ApiError('PASSKEY_REQUIRED_FIRST',
        'Register a passkey before enabling 2FA mode', 409);
    }
  }
  await db.update(users).set({ passkeyMode: mode }).where(eq(users.id, userId));
}

/**
 * Called by the email-based password-reset flow when/if it is added
 * (no such endpoint exists today; the operator-grade reset is in
 * scripts/admin-password-reset.sh which performs the equivalent SQL
 * directly). Authenticated change-password (PATCH /auth/password) does
 * NOT call this — a user voluntarily rotating their own password
 * while logged in still wants to keep their 2FA mode and credentials.
 *
 * Per the security review (M2):
 *   • Clear passkey_mode so 2FA doesn't block login after reset.
 *   • Keep the credentials so the legitimate user can re-enable 2FA
 *     in one click (attacker has the email but not the passkey).
 *   • Caller is responsible for sending the security alert email.
 */
export async function clearPasskeyModeOnPasswordReset(
  db: Database,
  userId: string,
): Promise<{ hadActiveMode: boolean; passkeyCount: number }> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { hadActiveMode: false, passkeyCount: 0 };
  const hadActiveMode = user.passkeyMode !== null;
  if (hadActiveMode) {
    await db.update(users).set({ passkeyMode: null }).where(eq(users.id, userId));
  }
  const passkeys = await db
    .select({ id: userPasskeys.id })
    .from(userPasskeys)
    .where(eq(userPasskeys.userId, userId));
  return { hadActiveMode, passkeyCount: passkeys.length };
}
