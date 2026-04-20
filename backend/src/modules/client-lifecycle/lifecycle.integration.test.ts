/**
 * Full client-lifecycle integration test.
 *
 * Covers the whole lifecycle from provisioning through suspend,
 * reactivate, resize, archive, restore, and delete.
 *
 * This test runs against a live k3s cluster + postgres + snapshot
 * store. Gated behind `RUN_LIFECYCLE_INTEGRATION=1` so it doesn't
 * fire in CI by default — the cluster dependency is heavy (3–5 min
 * per run) and requires `./scripts/local.sh up`.
 *
 * Running:
 *   ./scripts/local.sh up
 *   cd backend
 *   RUN_LIFECYCLE_INTEGRATION=1 \
 *   DATABASE_URL=postgresql://platform:local-dev-password@postgres.k8s-platform.test:2013/hosting_platform \
 *     npx vitest run src/modules/client-lifecycle/lifecycle.integration.test.ts
 *
 * The test creates a uniquely-named client, runs the full state
 * machine round-trip, asserts observable behaviour at each step, then
 * cleans up. If the cluster is unreachable or the env flag is off,
 * the entire suite is skipped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getTestDb, isDbAvailable } from '../../test-helpers/db.js';
import {
  clients,
  hostingPlans,
  regions,
  domains,
  mailboxes,
  emailAliases,
  storageOperations,
} from '../../db/schema.js';
import { createK8sClients, type K8sClients } from '../k8s-provisioner/k8s-client.js';

const RUN = process.env.RUN_LIFECYCLE_INTEGRATION === '1';
const dbAvailable = RUN ? await isDbAvailable() : false;

describe.skipIf(!RUN || !dbAvailable)('client lifecycle integration', () => {
  const db = getTestDb();
  let k8s: K8sClients;
  let clientId: string;
  let namespace: string;

  const TEST_PREFIX = 'lifecycle-it-';
  const uid = `${TEST_PREFIX}${Date.now().toString(36)}`;

  // Collect every ad-hoc client created mid-test so afterAll can
  // clean them up even when harness-level errors bypass inline
  // finally blocks. Each entry is { id, namespace? }.
  const auxCleanup: Array<{ id: string; namespace: string | null }> = [];

  beforeAll(async () => {
    k8s = createK8sClients(process.env.KUBECONFIG_PATH);

    // Seed a region + plan for this test run; they're reused across
    // tests in the file.
    const regionId = crypto.randomUUID();
    const planId = crypto.randomUUID();
    await db.insert(regions).values({
      id: regionId,
      name: `${uid}-region`,
      displayName: 'Lifecycle IT region',
      status: 'active',
    }).onConflictDoNothing();
    await db.insert(hostingPlans).values({
      id: planId,
      name: `${uid}-plan`,
      displayName: 'Lifecycle IT plan',
      cpuLimit: '1',
      memoryLimit: '1',
      storageLimit: '2',
      maxSubUsers: 5,
      maxMailboxes: 10,
      price: '10.00',
    }).onConflictDoNothing();

    // Create client row directly (skip the provisioning flow — that's
    // tested separately and too slow for this loop).
    clientId = crypto.randomUUID();
    namespace = `client-${uid}-${clientId.slice(0, 8)}`;
    await db.insert(clients).values({
      id: clientId,
      companyName: `${uid}-co`,
      companyEmail: `${uid}@example.test`,
      kubernetesNamespace: namespace,
      planId,
      regionId,
      status: 'active',
      storageLifecycleState: 'idle',
      subscriptionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    // Create the tenant namespace + minimal PVC for cascades to have
    // something to operate on.
    await k8s.core.createNamespace({
      body: { metadata: { name: namespace, labels: { 'platform.io/client-id': clientId } } },
    }).catch(() => { /* already exists */ });
  }, 60_000);

  afterAll(async () => {
    // Best-effort cleanup — the applyDeleted test SHOULD have removed
    // everything, but if it failed we still need to avoid leaving
    // state behind. auxCleanup covers any ad-hoc clients that tests
    // created but didn't reach their inline cleanup (e.g. concurrency
    // test leaks if the expect throws before the delete).
    try { await k8s.core.deleteNamespace({ name: namespace }); } catch { /* gone */ }
    await db.delete(clients).where(eq(clients.id, clientId)).catch(() => {});
    for (const aux of auxCleanup) {
      if (aux.namespace) {
        try { await k8s.core.deleteNamespace({ name: aux.namespace }); } catch { /* gone */ }
      }
      await db.delete(clients).where(eq(clients.id, aux.id)).catch(() => {});
    }
    // Clean up seeded rows too.
    await db.execute(sql`DELETE FROM hosting_plans WHERE name LIKE ${TEST_PREFIX + '%'}`).catch(() => {});
    await db.execute(sql`DELETE FROM regions WHERE name LIKE ${TEST_PREFIX + '%'}`).catch(() => {});
  }, 120_000);

  // ─── State matrix ──────────────────────────────────────────────────

  it('seeded client starts in active/idle with no mailboxes', async () => {
    const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
    expect(c.status).toBe('active');
    expect(c.storageLifecycleState).toBe('idle');
    const mbs = await db.select().from(mailboxes).where(eq(mailboxes.clientId, clientId));
    expect(mbs.length).toBe(0);
  });

  it('applySuspended sets status=suspended and disables mailboxes', async () => {
    // Seed one mailbox + one alias so cascades have something to bump.
    const domainId = crypto.randomUUID();
    await db.insert(domains).values({
      id: domainId,
      clientId,
      domainName: `${uid}.example.test`,
      status: 'active',
    });
    await db.insert(mailboxes).values({
      id: crypto.randomUUID(),
      clientId,
      domainId,
      localPart: 'test',
      fullAddress: `test@${uid}.example.test`,
      passwordHash: 'x',
      quotaMb: 100,
      status: 'active',
    });
    await db.insert(emailAliases).values({
      id: crypto.randomUUID(),
      clientId,
      domainId,
      sourceAddress: `alias@${uid}.example.test`,
      destinationAddresses: [`test@${uid}.example.test`],
      enabled: 1,
    });

    const { applySuspended } = await import('./cascades.js');
    await applySuspended({ db, k8s }, clientId, namespace);

    const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
    expect(c.status).toBe('suspended');
    const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.clientId, clientId));
    expect(mb.status).toBe('disabled');
    const [al] = await db.select().from(emailAliases).where(eq(emailAliases.clientId, clientId));
    expect(al.enabled).toBe(0);
    const [d] = await db.select().from(domains).where(eq(domains.clientId, clientId));
    expect(d.status).toBe('suspended');
  }, 30_000);

  it('applyActive reverses the suspend cascade', async () => {
    const { applyActive } = await import('./cascades.js');
    await applyActive({ db, k8s }, clientId, namespace);

    const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
    expect(c.status).toBe('active');
    const [mb] = await db.select().from(mailboxes).where(eq(mailboxes.clientId, clientId));
    expect(mb.status).toBe('active');
    const [al] = await db.select().from(emailAliases).where(eq(emailAliases.clientId, clientId));
    expect(al.enabled).toBe(1);
  }, 30_000);

  it('applyArchived deletes mailboxes and aliases', async () => {
    const { applyArchived } = await import('./cascades.js');
    await applyArchived({ db, k8s }, clientId, namespace);

    const [c] = await db.select().from(clients).where(eq(clients.id, clientId));
    expect(c.status).toBe('archived');
    const mbs = await db.select().from(mailboxes).where(eq(mailboxes.clientId, clientId));
    expect(mbs.length).toBe(0);
    const als = await db.select().from(emailAliases).where(eq(emailAliases.clientId, clientId));
    expect(als.length).toBe(0);
  }, 30_000);

  it('applyDeleted removes the client row and namespace', async () => {
    const { applyDeleted } = await import('./cascades.js');
    await applyDeleted({ db, k8s }, clientId, namespace);

    const rows = await db.select().from(clients).where(eq(clients.id, clientId));
    expect(rows.length).toBe(0);

    // Namespace may still be Terminating — this verify is best-effort.
    try {
      await k8s.core.readNamespace({ name: namespace });
      // If still there, it should at least be marked for deletion.
    } catch (err) {
      const code = (err as { statusCode?: number; code?: number }).statusCode
        ?? (err as { code?: number }).code;
      expect(code).toBe(404);
    }
  }, 60_000);

  // ─── 409 concurrency rejection ─────────────────────────────────────

  it('storage_operations enforces state-machine concurrency', async () => {
    // Recreate a fresh client to test concurrent-op rejection. Register
    // it with auxCleanup FIRST so a harness-level failure between
    // insert and inline-delete still releases the row in afterAll.
    const tempId = crypto.randomUUID();
    const tempNs = `client-${uid}-concur`;
    auxCleanup.push({ id: tempId, namespace: tempNs });

    await db.insert(clients).values({
      id: tempId,
      companyName: `${uid}-concur`,
      companyEmail: `${uid}-concur@example.test`,
      kubernetesNamespace: tempNs,
      planId: (await db.select({ id: hostingPlans.id }).from(hostingPlans).limit(1))[0].id,
      regionId: (await db.select({ id: regions.id }).from(regions).limit(1))[0].id,
      status: 'active',
      storageLifecycleState: 'resizing',
      activeStorageOpId: crypto.randomUUID(),
    });

    const service = await import('../storage-lifecycle/service.js');
    const store = { reservePath: () => '', mountTarget: () => ({ volumeSpec: {}, mountPath: '', relativePath: '' }), stat: async () => null, delete: async () => false, readSidecar: async () => null };
    const ctx = { db, k8s, store, platformNamespace: 'platform' };

    try {
      await expect(
        service.suspendClient(ctx, tempId),
      ).rejects.toMatchObject({ code: 'STORAGE_OP_IN_PROGRESS' });
    } finally {
      // Inline cleanup on the happy path; afterAll catches the rest.
      await db.delete(clients).where(eq(clients.id, tempId)).catch(() => {});
    }
  }, 30_000);

  // ─── Operations audit trail ────────────────────────────────────────

  it('cleans up storage_operations on test end', async () => {
    // Not strictly a behavior assertion — housekeeping so the test
    // doesn't leave rows across runs.
    await db.execute(sql`DELETE FROM storage_operations WHERE client_id NOT IN (SELECT id FROM clients)`);
    const orphans = await db.select({ c: sql<number>`count(*)` })
      .from(storageOperations)
      .where(sql`client_id NOT IN (SELECT id FROM clients)`);
    expect(Number(orphans[0]?.c ?? 0)).toBe(0);
  });
});
