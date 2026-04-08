/**
 * Phase 3 T5.1 — sendmail-compat submission credentials service.
 *
 * Provides per-client SMTP submission credentials that legacy web
 * apps (WordPress, PHP mail(), classic CGI) can use via a sendmail
 * wrapper (msmtp in the workload base image). The credentials:
 *
 *   - authenticate at Stalwart's submission port (587) via the
 *     `stalwart.principals` directory view (extended by migration
 *     0014_stalwart_submit_view.sql)
 *   - are stored twice: encrypted-at-rest (for writing to the
 *     customer PVC at `.platform/sendmail-auth`, invisible to the
 *     file manager) and bcrypt-hashed (for Stalwart verification)
 *   - scope rate limiting per customer (Stalwart [queue.throttle]
 *     keyed on `sender` principal)
 *
 * Rotation flow:
 *   1. rotateSubmitCredential() — revoke old row + insert new row
 *      (both in one operation; the old row's public username remains
 *      unique only among active credentials thanks to the partial
 *      unique index on (username) WHERE revoked_at IS NULL)
 *   2. Backend writes the new auth file to the PVC via the
 *      file-manager sidecar with X-Platform-Internal: 1
 *   3. Pods pick up the new credentials on next restart — msmtp
 *      re-reads the config file on every send.
 */

import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { eq, and, isNull, desc } from 'drizzle-orm';
import { mailSubmitCredentials, type MailSubmitCredential } from '../../db/schema.js';
import { encrypt } from '../oidc/crypto.js';
import type { Database } from '../../db/index.js';

const BCRYPT_ROUNDS = 12;
const PASSWORD_BYTES = 32; // 256 bits → base64 is 44 chars

export interface GenerateResult {
  readonly id: string;
  readonly username: string;
  readonly password: string; // plain — returned ONLY at generation time
}

export interface AuthFileInput {
  readonly username: string;
  readonly password: string;
  readonly mailHost: string;
  readonly mailPort: number;
  readonly defaultFrom?: string;
}

/**
 * Build the contents of the `.platform/sendmail-auth` file on the
 * customer PVC. Format is msmtprc-compatible so the workload's
 * sendmail wrapper can consume it as-is.
 *
 * Example output:
 *
 *   # Platform-managed — DO NOT EDIT
 *   account default
 *   host mail.platform.internal
 *   port 587
 *   auth on
 *   tls on
 *   tls_starttls on
 *   user submit-c123
 *   password {plain}
 *   [from noreply@example.com]
 */
export function buildAuthFileContent(input: AuthFileInput): string {
  const lines = [
    '# Platform-managed — DO NOT EDIT',
    '# File automatically rewritten when submit credentials rotate.',
    'account default',
    `host ${input.mailHost}`,
    `port ${input.mailPort}`,
    'auth on',
    'tls on',
    'tls_starttls on',
    `user ${input.username}`,
    `password ${input.password}`,
  ];
  if (input.defaultFrom) {
    lines.push(`from ${input.defaultFrom}`);
  }
  return lines.join('\n') + '\n';
}

function usernameFor(clientId: string): string {
  return `submit-${clientId}`;
}

/**
 * Look up the currently-active submit credential for a client (or
 * null if none exists). Used by the rotation flow and by the PVC
 * file-write path.
 */
export async function loadActiveCredential(
  db: Database,
  clientId: string,
): Promise<MailSubmitCredential | null> {
  const [row] = await db
    .select()
    .from(mailSubmitCredentials)
    .where(
      and(
        eq(mailSubmitCredentials.clientId, clientId),
        isNull(mailSubmitCredentials.revokedAt),
      ),
    );
  return row ?? null;
}

/**
 * Internal helper that creates a new active credential row. Does NOT
 * revoke any existing rows — callers use this either for first-time
 * provisioning or as part of the rotation flow after revoking the
 * old row.
 */
async function insertNewCredential(
  db: Database,
  clientId: string,
  encryptionKey: string,
  note?: string,
): Promise<GenerateResult> {
  const id = crypto.randomUUID();
  const username = usernameFor(clientId);
  const plain = crypto.randomBytes(PASSWORD_BYTES).toString('base64');
  const passwordEncrypted = encrypt(plain, encryptionKey);
  const passwordHash = await bcrypt.hash(plain, BCRYPT_ROUNDS);

  await db.insert(mailSubmitCredentials).values({
    id,
    clientId,
    username,
    passwordEncrypted,
    passwordHash,
    note: note ?? null,
  });

  return { id, username, password: plain };
}

/**
 * Generate a new submit credential for a client. Intended for the
 * first-time provisioning path (e.g. when the client first enables
 * email). If an active credential already exists, prefer
 * rotateSubmitCredential() — this function will happily insert a
 * duplicate row and violate the partial unique index.
 */
export async function generateSubmitCredential(
  db: Database,
  clientId: string,
  encryptionKey: string,
  options: { note?: string } = {},
): Promise<GenerateResult> {
  return insertNewCredential(db, clientId, encryptionKey, options.note);
}

/**
 * Rotate the submit credential for a client: revoke the existing
 * active row (if any) and insert a new active row. Returns the new
 * plain password so the caller can write the updated auth file to
 * the PVC.
 *
 * The revoke + insert runs inside a single transaction so a crash
 * or concurrent call can never leave the client with zero active
 * credentials (Stalwart would reject every submission) or more
 * than one (the partial unique index on username WHERE
 * revoked_at IS NULL would throw).
 */
export async function rotateSubmitCredential(
  db: Database,
  clientId: string,
  encryptionKey: string,
  options: { note?: string } = {},
): Promise<GenerateResult> {
  // Drizzle's transaction helper rolls back on any thrown error.
  // Both the revoke and the insert happen atomically — readers
  // either see the old row active or the new row active, never
  // neither.
  return await db.transaction(async (tx) => {
    const existing = await loadActiveCredential(tx as unknown as Database, clientId);
    if (existing) {
      await tx
        .update(mailSubmitCredentials)
        .set({ revokedAt: new Date() })
        .where(eq(mailSubmitCredentials.id, existing.id));
    }
    return insertNewCredential(tx as unknown as Database, clientId, encryptionKey, options.note);
  });
}

/**
 * List all credentials (including revoked) for a client, newest
 * first. Admin audit UI uses this.
 */
export async function listCredentials(
  db: Database,
  clientId: string,
): Promise<readonly MailSubmitCredential[]> {
  return await db
    .select()
    .from(mailSubmitCredentials)
    .where(eq(mailSubmitCredentials.clientId, clientId))
    .orderBy(desc(mailSubmitCredentials.createdAt))
    .limit(20);
}
