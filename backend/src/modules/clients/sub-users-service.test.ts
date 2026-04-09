import { describe, it, expect } from 'vitest';
import {
  listSubUsers,
  createSubUser,
  deleteSubUser,
  updateSubUser,
  type SubUsersDb,
} from './sub-users-service.js';

/**
 * Phase 1: tests for the extracted sub-users service module.
 *
 * The routes layer will call these functions instead of hitting
 * `app.db` directly, which makes both the routes and the service
 * unit-testable in isolation.
 */

interface SubUserRow {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly roleName: string;
  readonly status: string;
  readonly clientId: string;
  readonly createdAt: Date;
  readonly lastLoginAt: Date | null;
  readonly passwordHash: string | null;
}

/**
 * In-memory db stub that matches the narrow SubUsersDb interface.
 * We keep this tiny — just enough to test the service behaviors.
 */
function makeStub(initialRows: SubUserRow[]): SubUsersDb {
  let rows = [...initialRows];
  const stub: SubUsersDb = {
    listByClientId: async (clientId) =>
      rows
        .filter((r) => r.clientId === clientId)
        .map((r) => ({
          id: r.id,
          email: r.email,
          fullName: r.fullName,
          roleName: r.roleName,
          status: r.status,
          createdAt: r.createdAt,
          lastLoginAt: r.lastLoginAt,
        })),
    countByClientId: async (clientId) =>
      rows.filter((r) => r.clientId === clientId).length,
    countAdminsByClientId: async (clientId) =>
      rows.filter(
        (r) => r.clientId === clientId && r.roleName === 'client_admin',
      ).length,
    countActiveAdminsByClientId: async (clientId) =>
      rows.filter(
        (r) =>
          r.clientId === clientId
          && r.roleName === 'client_admin'
          && r.status === 'active',
      ).length,
    findByIdAndClientId: async (userId, clientId) => {
      const row = rows.find((r) => r.id === userId && r.clientId === clientId);
      return row
        ? { id: row.id, roleName: row.roleName, status: row.status }
        : null;
    },
    insertSubUser: async (input) => {
      const now = new Date('2026-04-09T12:00:00Z');
      const row: SubUserRow = {
        id: input.id,
        email: input.email,
        fullName: input.fullName,
        roleName: input.roleName,
        status: 'active',
        clientId: input.clientId,
        createdAt: now,
        lastLoginAt: null,
        passwordHash: input.passwordHash,
      };
      rows.push(row);
      return {
        id: row.id,
        email: row.email,
        fullName: row.fullName,
        roleName: row.roleName,
        status: row.status,
        createdAt: row.createdAt,
      };
    },
    updateSubUser: async (userId, clientId, payload) => {
      const idx = rows.findIndex(
        (r) => r.id === userId && r.clientId === clientId,
      );
      if (idx < 0) throw new Error(`row not found: ${userId}`);
      const current = rows[idx];
      const next: SubUserRow = {
        ...current,
        fullName: payload.fullName ?? current.fullName,
        roleName: payload.roleName ?? current.roleName,
        status: payload.status ?? current.status,
      };
      rows[idx] = next;
      return {
        id: next.id,
        email: next.email,
        fullName: next.fullName,
        roleName: next.roleName,
        status: next.status,
        createdAt: next.createdAt,
        lastLoginAt: next.lastLoginAt,
      };
    },
    deleteById: async (userId, clientId) => {
      rows = rows.filter(
        (r) => !(r.id === userId && r.clientId === clientId),
      );
    },
    // Single-threaded test stub — no actual locking needed.
    runInTransaction: async (fn) => fn(stub),
  };
  return stub;
}

const SEED: SubUserRow[] = [
  {
    id: 'u-admin-1',
    email: 'admin@c1.com',
    fullName: 'C1 Admin',
    roleName: 'client_admin',
    status: 'active',
    clientId: 'c1',
    createdAt: new Date('2026-01-01'),
    lastLoginAt: null,
    passwordHash: 'x',
  },
  {
    id: 'u-user-1',
    email: 'user@c1.com',
    fullName: 'C1 User',
    roleName: 'client_user',
    status: 'active',
    clientId: 'c1',
    createdAt: new Date('2026-01-02'),
    lastLoginAt: null,
    passwordHash: 'x',
  },
  {
    id: 'u-admin-2',
    email: 'admin@c2.com',
    fullName: 'C2 Admin',
    roleName: 'client_admin',
    status: 'active',
    clientId: 'c2',
    createdAt: new Date('2026-01-03'),
    lastLoginAt: null,
    passwordHash: 'x',
  },
];

describe('sub-users-service', () => {
  describe('listSubUsers', () => {
    it('returns only users for the requested client', async () => {
      const db = makeStub(SEED);
      const users = await listSubUsers(db, 'c1');
      expect(users).toHaveLength(2);
      expect(users.every((u) => ['u-admin-1', 'u-user-1'].includes(u.id))).toBe(
        true,
      );
    });

    it('returns empty array for a client with no users', async () => {
      const db = makeStub(SEED);
      const users = await listSubUsers(db, 'c-unknown');
      expect(users).toEqual([]);
    });

    it('does not leak the passwordHash field', async () => {
      const db = makeStub(SEED);
      const users = await listSubUsers(db, 'c1');
      for (const u of users) {
        expect(u).not.toHaveProperty('passwordHash');
      }
    });
  });

  describe('createSubUser', () => {
    it('creates a sub-user with default role client_user', async () => {
      const db = makeStub(SEED);
      const created = await createSubUser(db, 'c1', {
        email: 'new@c1.com',
        full_name: 'New User',
        password: 'password123',
      });
      expect(created.email).toBe('new@c1.com');
      expect(created.roleName).toBe('client_user');
      expect(created.status).toBe('active');
      expect(created).not.toHaveProperty('passwordHash');
      // Verify it's actually in the store
      const list = await listSubUsers(db, 'c1');
      expect(list).toHaveLength(3);
    });

    it('creates a sub-user with explicit role_name=client_admin (Phase 2)', async () => {
      const db = makeStub(SEED);
      const created = await createSubUser(db, 'c1', {
        email: 'promoted@c1.com',
        full_name: 'Promoted User',
        password: 'password123',
        role_name: 'client_admin',
      });
      expect(created.roleName).toBe('client_admin');
    });

    it('creates a sub-user with explicit role_name=client_user (Phase 2)', async () => {
      const db = makeStub(SEED);
      const created = await createSubUser(db, 'c1', {
        email: 'member@c1.com',
        full_name: 'Team Member',
        password: 'password123',
        role_name: 'client_user',
      });
      expect(created.roleName).toBe('client_user');
    });

    it('refuses unknown roles at the service boundary (defense in depth)', async () => {
      const db = makeStub(SEED);
      await expect(
        createSubUser(db, 'c1', {
          email: 'bad@c1.com',
          full_name: 'Bad',
          password: 'password123',
          // Cast around the TS union so we can simulate a caller
          // that bypasses the route-level Zod parse.
          role_name: 'super_admin' as unknown as 'client_admin',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_FIELD_VALUE',
        status: 400,
      });
    });

    it('rejects when the plan sub-user limit is reached', async () => {
      // Seed with maxSubUsers already full
      const seed: SubUserRow[] = Array.from({ length: 5 }, (_, i) => ({
        id: `u-${i}`,
        email: `u${i}@c3.com`,
        fullName: `User ${i}`,
        roleName: 'client_user',
        status: 'active',
        clientId: 'c3',
        createdAt: new Date(),
        lastLoginAt: null,
        passwordHash: 'x',
      }));
      const db = makeStub(seed);
      await expect(
        createSubUser(
          db,
          'c3',
          { email: 'over@c3.com', full_name: 'Over', password: 'password123' },
          { maxSubUsers: 5 },
        ),
      ).rejects.toMatchObject({
        code: 'SUB_USER_LIMIT',
        status: 403,
      });
    });

    it('allows creation up to the plan limit', async () => {
      const seed: SubUserRow[] = [];
      const db = makeStub(seed);
      for (let i = 0; i < 3; i++) {
        await createSubUser(
          db,
          'c4',
          {
            email: `u${i}@c4.com`,
            full_name: `U${i}`,
            password: 'password123',
          },
          { maxSubUsers: 3 },
        );
      }
      await expect(
        createSubUser(
          db,
          'c4',
          {
            email: 'over@c4.com',
            full_name: 'Over',
            password: 'password123',
          },
          { maxSubUsers: 3 },
        ),
      ).rejects.toMatchObject({ code: 'SUB_USER_LIMIT' });
    });

    it('rejects when required fields are missing', async () => {
      const db = makeStub(SEED);
      await expect(
        createSubUser(db, 'c1', {
          email: '',
          full_name: 'User',
          password: 'password123',
        }),
      ).rejects.toMatchObject({ code: 'MISSING_REQUIRED_FIELD' });
      await expect(
        createSubUser(db, 'c1', {
          email: 'ok@c1.com',
          full_name: '',
          password: 'password123',
        }),
      ).rejects.toMatchObject({ code: 'MISSING_REQUIRED_FIELD' });
      await expect(
        createSubUser(db, 'c1', {
          email: 'ok@c1.com',
          full_name: 'User',
          password: '',
        }),
      ).rejects.toMatchObject({ code: 'MISSING_REQUIRED_FIELD' });
    });
  });

  describe('deleteSubUser', () => {
    it('deletes a non-admin user without issue', async () => {
      const db = makeStub(SEED);
      await deleteSubUser(db, 'c1', 'u-user-1');
      const list = await listSubUsers(db, 'c1');
      expect(list.map((u) => u.id)).not.toContain('u-user-1');
    });

    it('returns 404 when the user does not exist in this client', async () => {
      const db = makeStub(SEED);
      await expect(
        deleteSubUser(db, 'c1', 'u-does-not-exist'),
      ).rejects.toMatchObject({ code: 'USER_NOT_FOUND', status: 404 });
    });

    it('returns 404 when the user belongs to a different client (cross-client isolation)', async () => {
      const db = makeStub(SEED);
      // u-admin-2 exists but belongs to c2, requesting from c1
      await expect(
        deleteSubUser(db, 'c1', 'u-admin-2'),
      ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
    });

    it('refuses to delete the last client_admin', async () => {
      const db = makeStub(SEED);
      await expect(
        deleteSubUser(db, 'c1', 'u-admin-1'),
      ).rejects.toMatchObject({ code: 'LAST_ADMIN', status: 403 });
    });

    it('allows deleting a client_admin if others remain', async () => {
      const seed: SubUserRow[] = [
        ...SEED,
        {
          id: 'u-admin-1b',
          email: 'admin2@c1.com',
          fullName: 'C1 Second Admin',
          roleName: 'client_admin',
          status: 'active',
          clientId: 'c1',
          createdAt: new Date(),
          lastLoginAt: null,
          passwordHash: 'x',
        },
      ];
      const db = makeStub(seed);
      await deleteSubUser(db, 'c1', 'u-admin-1');
      const list = await listSubUsers(db, 'c1');
      expect(list.map((u) => u.id)).toContain('u-admin-1b');
      expect(list.map((u) => u.id)).not.toContain('u-admin-1');
    });
  });

  describe('updateSubUser (Phase 3)', () => {
    it('updates a user full_name', async () => {
      const db = makeStub(SEED);
      const updated = await updateSubUser(db, 'c1', 'u-user-1', {
        fullName: 'Renamed User',
      });
      expect(updated.fullName).toBe('Renamed User');
      expect(updated.roleName).toBe('client_user');
      expect(updated.status).toBe('active');
    });

    it('promotes a client_user to client_admin', async () => {
      const db = makeStub(SEED);
      const updated = await updateSubUser(db, 'c1', 'u-user-1', {
        roleName: 'client_admin',
      });
      expect(updated.roleName).toBe('client_admin');
    });

    it('disables an active user (soft-delete)', async () => {
      const db = makeStub(SEED);
      const updated = await updateSubUser(db, 'c1', 'u-user-1', {
        status: 'disabled',
      });
      expect(updated.status).toBe('disabled');
    });

    it('re-enables a disabled user', async () => {
      const seed: SubUserRow[] = [
        ...SEED,
        {
          id: 'u-disabled',
          email: 'off@c1.com',
          fullName: 'Off',
          roleName: 'client_user',
          status: 'disabled',
          clientId: 'c1',
          createdAt: new Date(),
          lastLoginAt: null,
          passwordHash: 'x',
        },
      ];
      const db = makeStub(seed);
      const updated = await updateSubUser(db, 'c1', 'u-disabled', {
        status: 'active',
      });
      expect(updated.status).toBe('active');
    });

    it('rejects updates for a user not in this client', async () => {
      const db = makeStub(SEED);
      await expect(
        updateSubUser(db, 'c1', 'u-admin-2', { fullName: 'Hack' }),
      ).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
    });

    it('rejects unknown role names (defense in depth)', async () => {
      const db = makeStub(SEED);
      await expect(
        updateSubUser(db, 'c1', 'u-user-1', {
          roleName: 'super_admin' as unknown as 'client_admin',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_FIELD_VALUE' });
    });

    it('refuses to demote the last active client_admin', async () => {
      const db = makeStub(SEED);
      await expect(
        updateSubUser(db, 'c1', 'u-admin-1', { roleName: 'client_user' }),
      ).rejects.toMatchObject({ code: 'LAST_ADMIN', status: 403 });
    });

    it('refuses to disable the last active client_admin', async () => {
      const db = makeStub(SEED);
      await expect(
        updateSubUser(db, 'c1', 'u-admin-1', { status: 'disabled' }),
      ).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    });

    it('allows demoting a client_admin if another active admin exists', async () => {
      const seed: SubUserRow[] = [
        ...SEED,
        {
          id: 'u-admin-1b',
          email: 'admin2@c1.com',
          fullName: 'Second Admin',
          roleName: 'client_admin',
          status: 'active',
          clientId: 'c1',
          createdAt: new Date(),
          lastLoginAt: null,
          passwordHash: 'x',
        },
      ];
      const db = makeStub(seed);
      const updated = await updateSubUser(db, 'c1', 'u-admin-1', {
        roleName: 'client_user',
      });
      expect(updated.roleName).toBe('client_user');
    });

    it('allows disabling a client_admin if another active admin exists', async () => {
      const seed: SubUserRow[] = [
        ...SEED,
        {
          id: 'u-admin-1b',
          email: 'admin2@c1.com',
          fullName: 'Second Admin',
          roleName: 'client_admin',
          status: 'active',
          clientId: 'c1',
          createdAt: new Date(),
          lastLoginAt: null,
          passwordHash: 'x',
        },
      ];
      const db = makeStub(seed);
      const updated = await updateSubUser(db, 'c1', 'u-admin-1', {
        status: 'disabled',
      });
      expect(updated.status).toBe('disabled');
    });
  });
});
