import type { FastifyInstance } from 'fastify';
import { eq, inArray, desc } from 'drizzle-orm';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { triggerProvisionSchema } from '@k8s-hosting/api-contracts';
import { clients, provisioningTasks } from '../../db/schema.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { createK8sClients } from './k8s-client.js';
import { runProvisionNamespace, PROVISION_STEPS, buildStepsLog } from './service.js';

export async function provisioningRoutes(app: FastifyInstance): Promise<void> {
  // All provisioning routes require auth + admin role
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  // POST /api/v1/admin/clients/:clientId/provision
  // Triggers async namespace provisioning
  app.post('/admin/clients/:clientId/provision', {
    schema: {
      tags: ['Provisioning'],
      summary: 'Trigger namespace provisioning for a client',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['clientId'],
        properties: { clientId: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const { clientId } = request.params as { clientId: string };

    // Validate body
    const parsed = triggerProvisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      throw new ApiError(
        'INVALID_FIELD_VALUE',
        `Validation error: ${firstError.message} (${firstError.path.join('.')})`,
        400,
        { field: firstError.path.join('.') },
      );
    }

    // Verify client exists
    const [client] = await app.db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    if (!client) {
      throw new ApiError('CLIENT_NOT_FOUND', `Client '${clientId}' not found`, 404, { client_id: clientId });
    }

    // Check if already provisioning
    if (client.provisioningStatus === 'provisioning') {
      throw new ApiError('ALREADY_PROVISIONING', 'Client is already being provisioned', 409);
    }

    // Create task record
    const taskId = crypto.randomUUID();
    const stepsLog = buildStepsLog(PROVISION_STEPS);

    await app.db.insert(provisioningTasks).values({
      id: taskId,
      clientId,
      type: 'provision_namespace',
      status: 'pending',
      totalSteps: PROVISION_STEPS.length,
      completedSteps: 0,
      stepsLog,
      startedBy: request.user!.sub,
    });

    // Fire-and-forget: run provisioning in background
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    const k8sClients = createK8sClients(kubeconfigPath);

    // Don't await — this runs async
    runProvisionNamespace(app.db, k8sClients, taskId, clientId, parsed.data).catch((err) => {
      app.log.error({ err, taskId, clientId }, 'Provisioning failed unexpectedly');
    });

    reply.status(202);
    return success({
      taskId,
      clientId,
      status: 'pending',
      totalSteps: PROVISION_STEPS.length,
    });
  });

  // GET /api/v1/admin/clients/:clientId/provision/status
  // Returns the latest provisioning task for this client
  app.get('/admin/clients/:clientId/provision/status', {
    schema: {
      tags: ['Provisioning'],
      summary: 'Get provisioning status for a client',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['clientId'],
        properties: { clientId: { type: 'string' } },
      },
    },
  }, async (request) => {
    const { clientId } = request.params as { clientId: string };

    const [task] = await app.db.select()
      .from(provisioningTasks)
      .where(eq(provisioningTasks.clientId, clientId))
      .orderBy(desc(provisioningTasks.createdAt))
      .limit(1);

    if (!task) {
      throw new ApiError('TASK_NOT_FOUND', 'No provisioning task found for this client', 404);
    }

    return success({
      id: task.id,
      clientId: task.clientId,
      type: task.type,
      status: task.status,
      currentStep: task.currentStep,
      totalSteps: task.totalSteps,
      completedSteps: task.completedSteps,
      stepsLog: task.stepsLog,
      errorMessage: task.errorMessage,
      startedBy: task.startedBy,
      startedAt: task.startedAt?.toISOString() ?? null,
      completedAt: task.completedAt?.toISOString() ?? null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    });
  });

  // GET /api/v1/admin/provisioning/tasks
  // Returns all active (pending/running) provisioning tasks — for header indicator
  app.get('/admin/provisioning/tasks', {
    schema: {
      tags: ['Provisioning'],
      summary: 'List active provisioning tasks',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const activeTasks = await app.db.select()
      .from(provisioningTasks)
      .where(inArray(provisioningTasks.status, ['pending', 'running']));

    // Enrich with client company names
    const clientIds = [...new Set(activeTasks.map(t => t.clientId))];
    const clientMap = new Map<string, string>();

    if (clientIds.length > 0) {
      const clientRows = await app.db.select()
        .from(clients)
        .where(inArray(clients.id, clientIds));
      for (const c of clientRows) {
        clientMap.set(c.id, c.companyName);
      }
    }

    const tasks = activeTasks.map(t => ({
      id: t.id,
      clientId: t.clientId,
      companyName: clientMap.get(t.clientId) ?? 'Unknown',
      type: t.type,
      status: t.status,
      currentStep: t.currentStep,
      completedSteps: t.completedSteps,
      totalSteps: t.totalSteps,
    }));

    return success({
      count: tasks.length,
      tasks,
    });
  });
}
