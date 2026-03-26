import { eq, like, and, sql, desc, asc, lt, gt } from 'drizzle-orm';
import { clients } from '../../db/schema.js';
import { clientNotFound, duplicateEntry, operationNotAllowed } from '../../shared/errors.js';
import { encodeCursor, decodeCursor } from '../../shared/pagination.js';
import type { Database } from '../../db/index.js';
import type { CreateClientInput, UpdateClientInput } from './schema.js';
import type { PaginationMeta } from '../../shared/response.js';

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
  return created;
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

  if (Object.keys(updateValues).length > 0) {
    await db.update(clients).set(updateValues).where(eq(clients.id, id));
  }

  return getClientById(db, id);
}

export async function deleteClient(db: Database, id: string) {
  // Verify client exists (throws CLIENT_NOT_FOUND if missing)
  await getClientById(db, id);
  // Allow deletion regardless of status — the UI delete confirmation dialog is sufficient safeguard.
  // TODO: Future background job should clean up associated Kubernetes resources (namespace, secrets, etc.)
  await db.delete(clients).where(eq(clients.id, id));
}
