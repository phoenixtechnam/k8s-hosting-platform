import { eq } from 'drizzle-orm';
import { clients, hostingPlans } from '../../db/schema.js';
import { clientNotFound } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type { UpdateSubscriptionInput } from './schema.js';

export async function getSubscription(db: Database, clientId: string) {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) throw clientNotFound(clientId);

  const [plan] = await db.select().from(hostingPlans).where(eq(hostingPlans.id, client.planId));

  return {
    client_id: client.id,
    plan: plan ?? null,
    status: client.status,
    subscription_expires_at: client.subscriptionExpiresAt,
    created_at: client.createdAt,
  };
}

export async function updateSubscription(db: Database, clientId: string, input: UpdateSubscriptionInput) {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId));
  if (!client) throw clientNotFound(clientId);

  const updateValues: Record<string, unknown> = {};
  if (input.plan_id !== undefined) updateValues.planId = input.plan_id;
  if (input.status !== undefined) updateValues.status = input.status;
  if (input.subscription_expires_at !== undefined) {
    updateValues.subscriptionExpiresAt = new Date(input.subscription_expires_at);
  }

  if (Object.keys(updateValues).length > 0) {
    await db.update(clients).set(updateValues).where(eq(clients.id, clientId));
  }

  return getSubscription(db, clientId);
}
