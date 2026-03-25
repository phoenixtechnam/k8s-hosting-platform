import { eq } from 'drizzle-orm';
import { createHash } from 'crypto';
import type { Database } from '../../db/index.js';
import { users } from '../../db/schema.js';
import { invalidToken } from '../../shared/errors.js';

function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

export function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
}

export function hashNewPassword(password: string): string {
  return hashPassword(password);
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

  if (!verifyPassword(password, user.passwordHash)) {
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
