import { describe, it, expect, vi } from 'vitest';
import { listSshKeys, createSshKey, deleteSshKey } from './service.js';
import { ApiError } from '../../shared/errors.js';

function createMockDb(selectResults: unknown[][] = []) {
  let callIdx = 0;
  const whereFn = vi.fn().mockImplementation(() => {
    const result = selectResults[callIdx] ?? [];
    callIdx++;
    return Promise.resolve(result);
  });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });
  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  return { select: selectFn, insert: insertFn, delete: deleteFn } as unknown as Parameters<typeof listSshKeys>[0];
}

const KEY = {
  id: 'k1', clientId: 'c1', name: 'my-key',
  publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest user@host',
  keyFingerprint: 'SHA256:test', keyAlgorithm: 'ED25519',
  createdAt: new Date(),
};

describe('listSshKeys', () => {
  it('should return keys for client', async () => {
    const db = createMockDb([[KEY]]);
    const result = await listSshKeys(db, 'c1');
    expect(result).toEqual([KEY]);
  });
});

describe('createSshKey', () => {
  it('should create and return key', async () => {
    const db = createMockDb([[], [], [KEY]]); // no dup fingerprint, no dup name, return created
    const result = await createSshKey(db, 'c1', {
      name: 'my-key',
      public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest user@host',
    });
    expect(result).toEqual(KEY);
  });

  it('should throw DUPLICATE_SSH_KEY for duplicate fingerprint', async () => {
    const db = createMockDb([[KEY]]); // existing fingerprint found
    await expect(createSshKey(db, 'c1', {
      name: 'another-key',
      public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest user@host',
    })).rejects.toMatchObject({ code: 'DUPLICATE_SSH_KEY', status: 409 });
  });

  it('should throw DUPLICATE_KEY_NAME for duplicate name', async () => {
    const db = createMockDb([[], [KEY]]); // no dup fingerprint, dup name found
    await expect(createSshKey(db, 'c1', {
      name: 'my-key',
      public_key: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDifferent user@host',
    })).rejects.toMatchObject({ code: 'DUPLICATE_KEY_NAME', status: 409 });
  });
});

describe('deleteSshKey', () => {
  it('should delete when key exists', async () => {
    const db = createMockDb([[KEY]]);
    await deleteSshKey(db, 'c1', 'k1');
    expect((db as any).delete).toHaveBeenCalled();
  });

  it('should throw SSH_KEY_NOT_FOUND when missing', async () => {
    const db = createMockDb([[]]);
    await expect(deleteSshKey(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'SSH_KEY_NOT_FOUND',
      status: 404,
    });
  });
});
