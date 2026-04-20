import { describe, it, expect, vi } from 'vitest';
import { createClient, getClientById, updateClient, deleteClient } from './service.js';
import { ApiError } from '../../shared/errors.js';

// Helper to build a chainable mock db
function createMockDb(overrides: {
  selectResult?: unknown[];
  insertResult?: unknown;
  updateResult?: unknown;
  deleteResult?: unknown;
} = {}) {
  const { selectResult = [], insertResult = undefined, updateResult = undefined, deleteResult = undefined } = overrides;

  const whereFn = vi.fn().mockResolvedValue(selectResult);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn, orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(selectResult) }) });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  const insertValues = vi.fn().mockResolvedValue(insertResult);
  const insertFn = vi.fn().mockReturnValue({ values: insertValues });

  const updateWhere = vi.fn().mockResolvedValue(updateResult);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });

  const deleteWhere = vi.fn().mockResolvedValue(deleteResult);
  const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

  return {
    select: selectFn,
    insert: insertFn,
    update: updateFn,
    delete: deleteFn,
    _whereFn: whereFn,
  } as unknown as Parameters<typeof createClient>[0] & { _whereFn: ReturnType<typeof vi.fn> };
}

describe('getClientById', () => {
  it('should return client when found', async () => {
    const client = { id: 'c1', companyName: 'Acme' };
    const db = createMockDb({ selectResult: [client] });

    const result = await getClientById(db, 'c1');
    expect(result).toEqual(client);
  });

  it('should throw CLIENT_NOT_FOUND when not found', async () => {
    const db = createMockDb({ selectResult: [] });

    await expect(getClientById(db, 'missing')).rejects.toThrow(ApiError);
    await expect(getClientById(db, 'missing')).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
      status: 404,
    });
  });
});

describe('createClient', () => {
  it('applies the system default timezone when input does not specify one', async () => {
    // getSettings is mocked via the drizzle chain — first select goes to
    // systemSettings (returning our default), second select returns the
    // created client row back.
    const systemDefault = { id: 'system', timezone: 'Europe/Berlin', platformName: 'X', apiRateLimit: 100 };
    const createdClient = { id: 'c-new', companyName: 'NC', timezone: 'Europe/Berlin' };

    // Alternate select results in order: systemSettings row, then created client
    const selects: unknown[][] = [[systemDefault], [createdClient]];
    const whereFn = vi.fn().mockImplementation(() => Promise.resolve(selects.shift() ?? []));
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    // Capture the values passed to insert(clients).values(...) so we can
    // assert the timezone was applied.
    const insertValuesCalls: Array<Record<string, unknown>> = [];
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const insertValues = vi.fn((row: Record<string, unknown>) => {
      insertValuesCalls.push(row);
      return { onConflictDoUpdate };
    });
    const insertFn = vi.fn().mockReturnValue({ values: insertValues });

    const db = {
      select: selectFn,
      insert: insertFn,
    } as unknown as Parameters<typeof createClient>[0];

    await createClient(db, {
      company_name: 'NC',
      company_email: 'admin@nc.com',
      plan_id: '550e8400-e29b-41d4-a716-446655440000',
      region_id: '550e8400-e29b-41d4-a716-446655440001',
    }, 'creator');

    const clientRow = insertValuesCalls[0];
    expect(clientRow.timezone).toBe('Europe/Berlin');
  });

  it('keeps explicit timezone input when provided', async () => {
    const systemDefault = { id: 'system', timezone: 'Europe/Berlin', platformName: 'X', apiRateLimit: 100 };
    const createdClient = { id: 'c-new', companyName: 'NC', timezone: 'America/Los_Angeles' };

    const selects: unknown[][] = [[systemDefault], [createdClient]];
    const whereFn = vi.fn().mockImplementation(() => Promise.resolve(selects.shift() ?? []));
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const insertValuesCalls: Array<Record<string, unknown>> = [];
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const insertValues = vi.fn((row: Record<string, unknown>) => {
      insertValuesCalls.push(row);
      return { onConflictDoUpdate };
    });
    const insertFn = vi.fn().mockReturnValue({ values: insertValues });

    const db = {
      select: selectFn,
      insert: insertFn,
    } as unknown as Parameters<typeof createClient>[0];

    await createClient(db, {
      company_name: 'NC',
      company_email: 'admin@nc.com',
      plan_id: '550e8400-e29b-41d4-a716-446655440000',
      region_id: '550e8400-e29b-41d4-a716-446655440001',
      timezone: 'America/Los_Angeles',
    }, 'creator');

    expect(insertValuesCalls[0].timezone).toBe('America/Los_Angeles');
  });

  it('should insert and return created client', async () => {
    const createdClient = {
      id: 'new-uuid',
      companyName: 'New Corp',
      companyEmail: 'admin@newcorp.com',
      status: 'pending',
    };

    // For createClient: insert client, select, insert user (onConflictDoUpdate)
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const insertFn = vi.fn().mockReturnValue({ values: insertValues, onConflictDoUpdate });
    // Make values return chainable too
    insertValues.mockReturnValue({ onConflictDoUpdate });

    const whereFn = vi.fn().mockResolvedValue([createdClient]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = {
      select: selectFn,
      insert: insertFn,
    } as unknown as Parameters<typeof createClient>[0];

    const input = {
      company_name: 'New Corp',
      company_email: 'admin@newcorp.com',
      plan_id: '550e8400-e29b-41d4-a716-446655440000',
      region_id: '550e8400-e29b-41d4-a716-446655440001',
    };

    const result = await createClient(db, input, 'creator-1');
    expect(result).toMatchObject(createdClient);
    expect(result._generatedPassword).toBeDefined();
    expect(result._clientUserId).toBeDefined();
    expect(insertFn).toHaveBeenCalled();
  });
});

describe('updateClient', () => {
  it('should update and return the client', async () => {
    const existingClient = {
      id: 'c1',
      companyName: 'Acme',
      status: 'active',
      createdAt: new Date(),
    };

    // getClientById (first call) returns existing, then updateClient reads again
    let callCount = 0;
    const whereFn = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve([existingClient]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });

    const db = {
      select: selectFn,
      update: updateFn,
    } as unknown as Parameters<typeof updateClient>[0];

    const result = await updateClient(db, 'c1', { company_name: 'Acme Updated' });
    expect(result).toEqual(existingClient);
    expect(updateFn).toHaveBeenCalled();
  });

  it('should skip db update when no fields provided', async () => {
    const existingClient = { id: 'c1', companyName: 'Acme' };

    const whereFn = vi.fn().mockResolvedValue([existingClient]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const updateFn = vi.fn();

    const db = {
      select: selectFn,
      update: updateFn,
    } as unknown as Parameters<typeof updateClient>[0];

    const result = await updateClient(db, 'c1', {});
    expect(result).toEqual(existingClient);
    expect(updateFn).not.toHaveBeenCalled();
  });
});

describe('deleteClient', () => {
  it('should delete client regardless of status', async () => {
    const client = { id: 'c1', status: 'active' };
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

    const whereFn = vi.fn().mockResolvedValue([client]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = {
      select: selectFn,
      delete: deleteFn,
    } as unknown as Parameters<typeof deleteClient>[0];

    await deleteClient(db, 'c1');
    expect(deleteFn).toHaveBeenCalled();
  });

  it('should delete archived client', async () => {
    const client = { id: 'c1', status: 'archived' };
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

    const whereFn = vi.fn().mockResolvedValue([client]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = {
      select: selectFn,
      delete: deleteFn,
    } as unknown as Parameters<typeof deleteClient>[0];

    await deleteClient(db, 'c1');
    expect(deleteFn).toHaveBeenCalled();
  });

  it('should throw CLIENT_NOT_FOUND when client does not exist', async () => {
    const db = createMockDb({ selectResult: [] });

    await expect(deleteClient(db, 'missing')).rejects.toMatchObject({
      code: 'CLIENT_NOT_FOUND',
    });
  });

  it('should delete k8s namespace for provisioned client', async () => {
    const client = {
      id: 'c1',
      status: 'active',
      kubernetesNamespace: 'client-acme-abc12345',
      provisioningStatus: 'provisioned',
    };
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

    const whereFn = vi.fn().mockResolvedValue([client]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = {
      select: selectFn,
      delete: deleteFn,
    } as unknown as Parameters<typeof deleteClient>[0];

    const mockDeleteNamespace = vi.fn().mockResolvedValue(undefined);
    const k8sClients = {
      core: { deleteNamespace: mockDeleteNamespace },
    } as unknown as Parameters<typeof deleteClient>[2];

    await deleteClient(db, 'c1', k8sClients);
    expect(mockDeleteNamespace).toHaveBeenCalledWith({ name: 'client-acme-abc12345' });
    expect(deleteFn).toHaveBeenCalled();
  });

  it('attempts k8s namespace cleanup even for pending/provisioning clients (regression: prevents orphan leak)', async () => {
    // IMAP Phase 2: before this fix, deleteClient only touched the
    // namespace when provisioningStatus === 'provisioned'. Clients
    // created and immediately deleted (e.g. smoke tests) left
    // orphaned namespaces behind forever. Now we attempt cleanup
    // whenever we know the namespace name, regardless of status.
    const client = {
      id: 'c1',
      status: 'pending',
      kubernetesNamespace: 'client-acme-abc12345',
      provisioningStatus: 'pending',
    };
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

    const whereFn = vi.fn().mockResolvedValue([client]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = {
      select: selectFn,
      delete: deleteFn,
    } as unknown as Parameters<typeof deleteClient>[0];

    const mockDeleteNamespace = vi.fn().mockResolvedValue(undefined);
    const k8sClients = {
      core: { deleteNamespace: mockDeleteNamespace },
    } as unknown as Parameters<typeof deleteClient>[2];

    await deleteClient(db, 'c1', k8sClients);
    expect(mockDeleteNamespace).toHaveBeenCalledWith({ name: 'client-acme-abc12345' });
    expect(deleteFn).toHaveBeenCalled();
  });

  it('attempts k8s namespace cleanup for provisioning clients (half-provisioned)', async () => {
    const client = {
      id: 'c1',
      status: 'pending',
      kubernetesNamespace: 'client-acme-abc12345',
      provisioningStatus: 'provisioning',
    };
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });
    const whereFn = vi.fn().mockResolvedValue([client]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = {
      select: selectFn, delete: deleteFn,
    } as unknown as Parameters<typeof deleteClient>[0];

    const mockDeleteNamespace = vi.fn().mockResolvedValue(undefined);
    const k8sClients = {
      core: { deleteNamespace: mockDeleteNamespace },
    } as unknown as Parameters<typeof deleteClient>[2];

    await deleteClient(db, 'c1', k8sClients);
    expect(mockDeleteNamespace).toHaveBeenCalledWith({ name: 'client-acme-abc12345' });
  });

  it('swallows 404 from namespace delete (already-deleted namespace)', async () => {
    // A common case when the smoke test cleanup races with a prior
    // cleanup pass, or when provisioning never actually created the
    // namespace yet.
    const client = {
      id: 'c1',
      status: 'pending',
      kubernetesNamespace: 'client-acme-abc12345',
      provisioningStatus: 'pending',
    };
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });
    const whereFn = vi.fn().mockResolvedValue([client]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = {
      select: selectFn, delete: deleteFn,
    } as unknown as Parameters<typeof deleteClient>[0];

    const notFoundErr = Object.assign(new Error('namespaces "x" not found'), { statusCode: 404 });
    const mockDeleteNamespace = vi.fn().mockRejectedValue(notFoundErr);
    const k8sClients = {
      core: { deleteNamespace: mockDeleteNamespace },
    } as unknown as Parameters<typeof deleteClient>[2];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await deleteClient(db, 'c1', k8sClients);
    // Delete still proceeds even when namespace delete fails
    expect(deleteFn).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('still skips k8s cleanup when kubernetesNamespace is empty', async () => {
    const client = {
      id: 'c1',
      status: 'pending',
      kubernetesNamespace: null,
      provisioningStatus: 'pending',
    };
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });
    const whereFn = vi.fn().mockResolvedValue([client]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = {
      select: selectFn, delete: deleteFn,
    } as unknown as Parameters<typeof deleteClient>[0];

    const mockDeleteNamespace = vi.fn();
    const k8sClients = {
      core: { deleteNamespace: mockDeleteNamespace },
    } as unknown as Parameters<typeof deleteClient>[2];

    await deleteClient(db, 'c1', k8sClients);
    expect(mockDeleteNamespace).not.toHaveBeenCalled();
    expect(deleteFn).toHaveBeenCalled();
  });

  it('should handle k8s namespace deletion failure gracefully', async () => {
    const client = {
      id: 'c1',
      status: 'active',
      kubernetesNamespace: 'client-acme-abc12345',
      provisioningStatus: 'provisioned',
    };
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: deleteWhere });

    const whereFn = vi.fn().mockResolvedValue([client]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });

    const db = {
      select: selectFn,
      delete: deleteFn,
    } as unknown as Parameters<typeof deleteClient>[0];

    const mockDeleteNamespace = vi.fn().mockRejectedValue(new Error('k8s API unreachable'));
    const k8sClients = {
      core: { deleteNamespace: mockDeleteNamespace },
    } as unknown as Parameters<typeof deleteClient>[2];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await deleteClient(db, 'c1', k8sClients);
    expect(mockDeleteNamespace).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[client-delete] Failed to delete k8s namespace client-acme-abc12345'),
    );
    // DB deletion should still proceed
    expect(deleteFn).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
