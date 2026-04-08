import { eq, like, and, sql, desc, asc, lt, gt } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { clients, domains, deployments, cronJobs, users, hostingPlans } from '../../db/schema.js';
import { clientNotFound } from '../../shared/errors.js';
import { encodeCursor, decodeCursor } from '../../shared/pagination.js';
import type { Database } from '../../db/index.js';
import type { CreateClientInput, UpdateClientInput } from './schema.js';
import type { PaginationMeta } from '../../shared/response.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

function generateNamespace(companyName: string): string {
  return `client-${companyName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 50)}-${crypto.randomUUID().slice(0, 8)}`;
}

export async function createClient(db: Database, input: CreateClientInput, createdBy: string) {
  const id = crypto.randomUUID();
  const namespace = generateNamespace(input.company_name);

  await db.insert(clients).values({
    id,
    regionId: input.region_id,
    companyName: input.company_name,
    companyEmail: input.company_email,
    contactEmail: input.contact_email ?? null,
    status: 'pending',
    kubernetesNamespace: namespace,
    planId: input.plan_id,
    createdBy,
    subscriptionExpiresAt: input.subscription_expires_at ? new Date(input.subscription_expires_at) : null,
  });

  const [created] = await db.select().from(clients).where(eq(clients.id, id));

  // Auto-create client_admin user with generated password
  const generatedPassword = generateStrongPassword();
  const passwordHash = await bcrypt.hash(generatedPassword, 12);
  const clientUserId = crypto.randomUUID();

  await db.insert(users).values({
    id: clientUserId,
    email: input.company_email,
    passwordHash,
    fullName: input.company_name,
    roleName: 'client_admin',
    panel: 'client',
    clientId: id,
    status: 'active',
    emailVerifiedAt: new Date(),
  }).onConflictDoUpdate({ target: users.email, set: { clientId: sql`excluded.client_id` } });

  return { ...created, _generatedPassword: generatedPassword, _clientUserId: clientUserId };
}

function generateStrongPassword(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

export async function getClientById(db: Database, id: string) {
  const [client] = await db.select().from(clients).where(eq(clients.id, id));
  if (!client) throw clientNotFound(id);
  return client;
}

export async function listClients(
  db: Database,
  params: { limit: number; cursor?: string; sort: { field: string; direction: 'asc' | 'desc' }; search?: string },
): Promise<{ data: typeof clients.$inferSelect[]; pagination: PaginationMeta }> {
  const { limit, cursor, sort, search } = params;

  const conditions = [];
  if (search) {
    conditions.push(like(clients.companyName, `%${search}%`));
  }

  if (cursor) {
    const decoded = decodeCursor(cursor);
    const sortCol = clients.createdAt; // Default sort column
    conditions.push(
      sort.direction === 'desc' ? lt(sortCol, new Date(decoded.sort)) : gt(sortCol, new Date(decoded.sort)),
    );
  }

  const orderBy = sort.direction === 'desc' ? desc(clients.createdAt) : asc(clients.createdAt);
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(clients)
    .where(where)
    .orderBy(orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);

  let nextCursor: string | null = null;
  if (hasMore && data.length > 0) {
    const last = data[data.length - 1];
    nextCursor = encodeCursor({
      resource: 'client',
      sort: last.createdAt.toISOString(),
      id: last.id,
    });
  }

  const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(clients).where(where);

  return {
    data,
    pagination: {
      cursor: nextCursor,
      has_more: hasMore,
      page_size: data.length,
      total_count: Number(countResult?.count ?? 0),
    },
  };
}

export async function updateClient(db: Database, id: string, input: UpdateClientInput) {
  await getClientById(db, id); // throws if not found

  const updateValues: Record<string, unknown> = {};
  if (input.company_name !== undefined) updateValues.companyName = input.company_name;
  if (input.company_email !== undefined) updateValues.companyEmail = input.company_email;
  if (input.contact_email !== undefined) updateValues.contactEmail = input.contact_email;
  if (input.status !== undefined) updateValues.status = input.status;
  if (input.plan_id !== undefined) updateValues.planId = input.plan_id;
  if (input.subscription_expires_at !== undefined) {
    updateValues.subscriptionExpiresAt = input.subscription_expires_at
      ? new Date(input.subscription_expires_at)
      : null;
  }
  if (input.cpu_limit_override !== undefined) updateValues.cpuLimitOverride = input.cpu_limit_override === null ? null : String(input.cpu_limit_override);
  if (input.memory_limit_override !== undefined) updateValues.memoryLimitOverride = input.memory_limit_override === null ? null : String(input.memory_limit_override);
  if (input.storage_limit_override !== undefined) updateValues.storageLimitOverride = input.storage_limit_override === null ? null : String(input.storage_limit_override);
  if (input.max_sub_users_override !== undefined) updateValues.maxSubUsersOverride = input.max_sub_users_override;
  if (input.monthly_price_override !== undefined) updateValues.monthlyPriceOverride = input.monthly_price_override === null ? null : String(input.monthly_price_override);
  if (input.email_send_rate_limit !== undefined) updateValues.emailSendRateLimit = input.email_send_rate_limit;

  if (Object.keys(updateValues).length > 0) {
    await db.update(clients).set(updateValues).where(eq(clients.id, id));
  }

  // Sync K8s ResourceQuota when resource limits change
  if (input.cpu_limit_override !== undefined || input.memory_limit_override !== undefined || input.storage_limit_override !== undefined || input.plan_id !== undefined) {
    try {
      const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
      const { applyResourceQuota } = await import('../k8s-provisioner/service.js');
      const updatedClient = await getClientById(db, id);
      const [plan] = await db.select().from(hostingPlans).where(eq(hostingPlans.id, updatedClient.planId));
      const k8s = createK8sClients(process.env.KUBECONFIG_PATH);
      await applyResourceQuota(k8s, updatedClient.kubernetesNamespace, {
        cpu: String(updatedClient.cpuLimitOverride ?? plan?.cpuLimit ?? 2),
        memory: String(updatedClient.memoryLimitOverride ?? plan?.memoryLimit ?? 4),
        storage: String(updatedClient.storageLimitOverride ?? plan?.storageLimit ?? 50),
      });
    } catch (err) {
      console.warn('[clients] Failed to sync K8s ResourceQuota:', err instanceof Error ? err.message : String(err));
    }
  }

  // Cascade suspension to related resources
  if (input.status === 'suspended') {
    await db.update(domains).set({ status: 'suspended' }).where(eq(domains.clientId, id));
    await db.update(deployments).set({ status: 'stopped' }).where(eq(deployments.clientId, id));
    await db.update(cronJobs).set({ enabled: 0 }).where(eq(cronJobs.clientId, id));
  }

  // Phase 3.B.3: reconcile Stalwart outbound config when:
  //   - client status changed (suspend → rate=0 in throttle)
  //   - email send rate limit changed
  // Non-blocking — throttle reconcile failures shouldn't fail the
  // client update API call.
  if (input.status !== undefined || input.email_send_rate_limit !== undefined) {
    try {
      const { reconcileOutboundConfig } = await import('../email-outbound/service.js');
      const { createK8sClients } = await import('../k8s-provisioner/k8s-client.js');
      const k8s = createK8sClients(process.env.KUBECONFIG_PATH);
      await reconcileOutboundConfig(db, k8s);
    } catch (err) {
      console.warn('[clients] Failed to reconcile outbound config after status/rate change:', err instanceof Error ? err.message : String(err));
    }
  }

  return getClientById(db, id);
}

export async function deleteClient(db: Database, id: string, k8sClients?: K8sClients) {
  const client = await getClientById(db, id);

  // Best-effort k8s namespace cleanup
  if (k8sClients && client.kubernetesNamespace && client.provisioningStatus === 'provisioned') {
    try {
      await k8sClients.core.deleteNamespace({ name: client.kubernetesNamespace });
    } catch (err: unknown) {
      // Log but don't block — namespace may already be gone
      console.warn(`[client-delete] Failed to delete k8s namespace ${client.kubernetesNamespace}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await db.delete(clients).where(eq(clients.id, id));
}
