import { eq, and } from 'drizzle-orm';
import crypto from 'crypto';
import { sshKeys } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { CreateSshKeyInput, UpdateSshKeyInput } from './schema.js';

function computeFingerprint(publicKey: string): string {
  // Extract the key data (second field of "type base64data comment" format)
  const parts = publicKey.trim().split(/\s+/);
  const keyData = parts.length >= 2 ? parts[1] : parts[0];
  const hash = crypto.createHash('sha256').update(Buffer.from(keyData, 'base64')).digest('base64');
  return `SHA256:${hash.replace(/=+$/, '')}`;
}

function detectAlgorithm(publicKey: string): string | null {
  const trimmed = publicKey.trim();
  if (trimmed.startsWith('ssh-rsa')) return 'RSA';
  if (trimmed.startsWith('ssh-ed25519')) return 'ED25519';
  if (trimmed.startsWith('ecdsa-sha2')) return 'ECDSA';
  if (trimmed.startsWith('ssh-dss')) return 'DSA';
  return null;
}

export async function listSshKeys(db: Database, clientId: string) {
  return db.select().from(sshKeys).where(eq(sshKeys.clientId, clientId));
}

export async function createSshKey(db: Database, clientId: string, input: CreateSshKeyInput) {
  const fingerprint = computeFingerprint(input.public_key);
  const algorithm = detectAlgorithm(input.public_key);

  // Check for duplicate fingerprint
  const [existingFingerprint] = await db
    .select()
    .from(sshKeys)
    .where(eq(sshKeys.keyFingerprint, fingerprint));

  if (existingFingerprint) {
    throw new ApiError('DUPLICATE_SSH_KEY', 'An SSH key with this fingerprint already exists', 409);
  }

  // Check for duplicate name per client
  const [existingName] = await db
    .select()
    .from(sshKeys)
    .where(and(eq(sshKeys.clientId, clientId), eq(sshKeys.name, input.name)));

  if (existingName) {
    throw new ApiError('DUPLICATE_KEY_NAME', `SSH key named '${input.name}' already exists for this client`, 409);
  }

  const id = crypto.randomUUID();
  await db.insert(sshKeys).values({
    id,
    clientId,
    name: input.name,
    publicKey: input.public_key,
    keyFingerprint: fingerprint,
    keyAlgorithm: algorithm,
  });

  const [created] = await db.select().from(sshKeys).where(eq(sshKeys.id, id));
  return created;
}

export async function updateSshKey(db: Database, clientId: string, keyId: string, input: UpdateSshKeyInput) {
  const [existing] = await db
    .select()
    .from(sshKeys)
    .where(and(eq(sshKeys.id, keyId), eq(sshKeys.clientId, clientId)));

  if (!existing) {
    throw new ApiError('SSH_KEY_NOT_FOUND', `SSH key '${keyId}' not found`, 404);
  }

  const updates: Record<string, unknown> = {};

  if (input.name !== undefined) {
    // Check for duplicate name per client (excluding current key)
    const [existingName] = await db
      .select()
      .from(sshKeys)
      .where(and(eq(sshKeys.clientId, clientId), eq(sshKeys.name, input.name)));

    if (existingName && existingName.id !== keyId) {
      throw new ApiError('DUPLICATE_KEY_NAME', `SSH key named '${input.name}' already exists for this client`, 409);
    }
    updates.name = input.name;
  }

  if (input.public_key !== undefined) {
    const fingerprint = computeFingerprint(input.public_key);
    const algorithm = detectAlgorithm(input.public_key);

    // Check for duplicate fingerprint (excluding current key)
    const [existingFingerprint] = await db
      .select()
      .from(sshKeys)
      .where(eq(sshKeys.keyFingerprint, fingerprint));

    if (existingFingerprint && existingFingerprint.id !== keyId) {
      throw new ApiError('DUPLICATE_SSH_KEY', 'An SSH key with this fingerprint already exists', 409);
    }

    updates.publicKey = input.public_key;
    updates.keyFingerprint = fingerprint;
    updates.keyAlgorithm = algorithm;
  }

  if (Object.keys(updates).length > 0) {
    await db.update(sshKeys).set(updates).where(eq(sshKeys.id, keyId));
  }

  const [updated] = await db.select().from(sshKeys).where(eq(sshKeys.id, keyId));
  return updated;
}

export async function deleteSshKey(db: Database, clientId: string, keyId: string) {
  const [key] = await db
    .select()
    .from(sshKeys)
    .where(and(eq(sshKeys.id, keyId), eq(sshKeys.clientId, clientId)));

  if (!key) {
    throw new ApiError('SSH_KEY_NOT_FOUND', `SSH key '${keyId}' not found`, 404);
  }

  await db.delete(sshKeys).where(eq(sshKeys.id, keyId));
}
