import { describe, it, expect, vi } from 'vitest';
import { createAlias, listAliases, updateAlias, deleteAlias } from './service.js';

const DOMAIN = {
  id: 'ed1',
  clientId: 'c1',
  domainId: 'd1',
  enabled: 1,
  dkimSelector: 'default',
  dkimPrivateKeyEncrypted: null,
  dkimPublicKey: null,
  catchAllAddress: null,
  mxProvisioned: 0,
  spfProvisioned: 0,
  dkimProvisioned: 0,
  dmarcProvisioned: 0,
  spamThresholdJunk: '5.0',
  spamThresholdReject: '10.0',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const PARENT_DOMAIN = {
  id: 'd1',
  clientId: 'c1',
  domainName: 'example.com',
  dnsMode: 'primary',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const ALIAS = {
  id: 'a1',
  emailDomainId: 'ed1',
  clientId: 'c1',
  sourceAddress: 'info@example.com',
  destinationAddresses: ['user@example.com'],
  enabled: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/**
 * Build a mock DB that returns different results per sequential .where() call.
 * Also supports insert, update, and delete chains.
 */
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

  const updateSetWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateSetWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  return {
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    delete: deleteFn,
  } as unknown as Parameters<typeof createAlias>[0];
}

describe('createAlias', () => {
  it('should create alias with valid source and destinations', async () => {
    // select calls: 1) emailDomain, 2) parentDomain, 3) existing alias, 4) existing mailbox, 5) created row
    const db = createMockDb([[DOMAIN], [PARENT_DOMAIN], [], [], [ALIAS]]);
    const result = await createAlias(db, 'c1', 'ed1', {
      source_address: 'info@example.com',
      destination_addresses: ['user@example.com'],
    });
    expect(result).toEqual(ALIAS);
  });

  it('should reject alias where source domain does not match email domain', async () => {
    const db = createMockDb([[DOMAIN], [PARENT_DOMAIN]]);
    await expect(
      createAlias(db, 'c1', 'ed1', {
        source_address: 'info@other.com',
        destination_addresses: ['user@example.com'],
      }),
    ).rejects.toMatchObject({ code: 'DOMAIN_MISMATCH', status: 400 });
  });

  it('should reject duplicate source address (alias)', async () => {
    const db = createMockDb([[DOMAIN], [PARENT_DOMAIN], [ALIAS]]);
    await expect(
      createAlias(db, 'c1', 'ed1', {
        source_address: 'info@example.com',
        destination_addresses: ['other@example.com'],
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_ENTRY', status: 409 });
  });

  it('should reject duplicate source address (mailbox)', async () => {
    const mailbox = { id: 'm1', fullAddress: 'info@example.com' };
    const db = createMockDb([[DOMAIN], [PARENT_DOMAIN], [], [mailbox]]);
    await expect(
      createAlias(db, 'c1', 'ed1', {
        source_address: 'info@example.com',
        destination_addresses: ['other@example.com'],
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_ENTRY', status: 409 });
  });
});

describe('listAliases', () => {
  it('should list aliases filtered by domain', async () => {
    const whereFn = vi.fn().mockResolvedValue([ALIAS]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Parameters<typeof listAliases>[0];

    const result = await listAliases(db, 'c1', 'ed1');
    expect(result).toEqual([ALIAS]);
  });

  it('should list all aliases for client when no domain specified', async () => {
    const whereFn = vi.fn().mockResolvedValue([ALIAS]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Parameters<typeof listAliases>[0];

    const result = await listAliases(db, 'c1');
    expect(result).toEqual([ALIAS]);
  });
});

describe('updateAlias', () => {
  it('should update alias destinations', async () => {
    const updatedAlias = { ...ALIAS, destinationAddresses: ['new@example.com'] };
    const db = createMockDb([[ALIAS], [updatedAlias]]);
    const result = await updateAlias(db, 'c1', 'a1', {
      destination_addresses: ['new@example.com'],
    });
    expect(result).toEqual(updatedAlias);
  });

  it('should throw when alias not found', async () => {
    const db = createMockDb([[]]);
    await expect(
      updateAlias(db, 'c1', 'missing', { enabled: false }),
    ).rejects.toMatchObject({ code: 'EMAIL_ALIAS_NOT_FOUND', status: 404 });
  });
});

describe('deleteAlias', () => {
  it('should delete alias', async () => {
    const db = createMockDb([[ALIAS]]);
    await deleteAlias(db, 'c1', 'a1');
    expect((db as any).delete).toHaveBeenCalled();
  });

  it('should throw when alias not found', async () => {
    const db = createMockDb([[]]);
    await expect(deleteAlias(db, 'c1', 'missing')).rejects.toMatchObject({
      code: 'EMAIL_ALIAS_NOT_FOUND',
      status: 404,
    });
  });
});
