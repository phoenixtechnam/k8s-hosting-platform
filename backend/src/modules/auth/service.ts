import { eq } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import type { Database } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { invalidToken } from '../../shared/errors.js';

const SALT_ROUNDS = 12;

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  // Support legacy SHA-256 hashes (64 char hex) for migration
  if (hash.length === 64 && /^[a-f0-9]+$/.test(hash)) {
    const { createHash } = await import('crypto');
    return createHash('sha256').update(password).digest('hex') === hash;
  }
  return bcrypt.compare(password, hash);
}

export async function hashNewPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function authenticateUser(
  db: Database,
  email: string,
  password: string,
) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) {
    throw invalidToken();
  }

  if (!user.passwordHash) {
    throw invalidToken();
  }

  if (!await verifyPassword(password, user.passwordHash)) {
    throw invalidToken();
  }

  if (user.status !== 'active') {
    throw invalidToken();
  }

  // Update last login
  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id));

  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.roleName,
  };
}
