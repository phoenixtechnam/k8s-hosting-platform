/**
 * Backup-rclone-shim admin HTTP surface (R-X5).
 *
 *   GET  /api/v1/admin/backup-rclone-shim/assignments
 *   PUT  /api/v1/admin/backup-rclone-shim/assignments/:className
 *   POST /api/v1/admin/backup-rclone-shim/drain-now
 *   GET  /api/v1/admin/backup-rclone-shim/status
 *
 * Auth: super_admin only (Tier-1 backup primitives — a misassignment
 * could expose data to a wrong upstream).
 *
 * Every state-changing operation returns `{ data, taskId }` so the
 * frontend can open the task-center progress modal. R-X10 builds the
 * UI on top.
 */

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import {
  backupShimClassEnum,
  drainNowRequestSchema,
  putShimAssignmentRequestSchema,
  shimAssignmentRowSchema,
  shimStatusResponseSchema,
  type BackupShimClass,
  type DrainNowResponse,
  type ListShimAssignmentsResponse,
  type PutShimAssignmentResponse,
  type ShimStatusResponse,
} from '@k8s-hosting/api-contracts';
import * as k8s from '@kubernetes/client-node';

import { authenticate, requireRole } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import {
  applyShimAssignmentChange,
  runDrainNow,
} from './apply-assignment.js';
import { snapshotInflightShimConsumers } from './drain.js';
import {
  listCurrentShimAssignments,
  readShimStatus,
} from './status.js';

const classParamSchema = z.object({
  className: backupShimClassEnum,
});

interface RoutesDeps {
  /** Build the k8s clients the orchestrator needs. Called on every
   *  request so the kubeconfig can be re-read in cases where it
   *  rotates underneath us (e.g. operator-driven cert renewal). The
   *  return is two cheap wrapper objects — no network I/O. Injected so
   *  tests can stub. */
  readonly buildK8sClients: () => { core: k8s.CoreV1Api; apps: k8s.AppsV1Api };
  readonly encryptionKey: string;
}

export async function backupRcloneShimRoutes(
  app: FastifyInstance,
  deps: RoutesDeps,
): Promise<void> {
  const adminGate = [authenticate, requireRole('super_admin')];

  // ─── List ────────────────────────────────────────────────────────
  app.get('/admin/backup-rclone-shim/assignments', {
    onRequest: adminGate,
    schema: {
      tags: ['Backup Rclone Shim'],
      summary: 'List the current binding for each shim class',
      security: [{ bearerAuth: [] }],
    },
  }, async (): Promise<ListShimAssignmentsResponse> => {
    const assignments = await listCurrentShimAssignments(app.db);
    return success({ assignments });
  });

  // ─── Replace assignment for one class ───────────────────────────
  app.put<{
    Params: { className: BackupShimClass };
    Body: z.infer<typeof putShimAssignmentRequestSchema>;
  }>('/admin/backup-rclone-shim/assignments/:className', {
    onRequest: adminGate,
    schema: {
      tags: ['Backup Rclone Shim'],
      summary: 'Bind a shim class to a backup target (or unassign)',
      security: [{ bearerAuth: [] }],
    },
  }, async (request): Promise<PutShimAssignmentResponse> => {
    const params = classParamSchema.parse(request.params);
    const body = putShimAssignmentRequestSchema.parse(request.body ?? {});
    const userId = (request.user as { sub?: string } | undefined)?.sub;
    if (!userId) {
      throw new ApiError('UNAUTHORIZED', 'Authenticated user id missing', 401);
    }

    const result = await applyShimAssignmentChange(
      {
        db: app.db,
        k8s: deps.buildK8sClients(),
        encryptionKey: deps.encryptionKey,
        log: request.log,
      },
      {
        className: params.className,
        targetId: body.targetId,
        force: body.force,
        drainTimeoutSecondsOverride: body.drainTimeoutSecondsOverride,
        userId,
      },
    );

    // Validate the row against the contract before serialising —
    // belt-and-braces against silent schema drift.
    const validated = shimAssignmentRowSchema.parse(result.assignment);
    return { data: validated, taskId: result.taskId };
  });

  // ─── Drain-now ──────────────────────────────────────────────────
  app.post<{ Body: z.infer<typeof drainNowRequestSchema> }>(
    '/admin/backup-rclone-shim/drain-now',
    {
      onRequest: adminGate,
      schema: {
        tags: ['Backup Rclone Shim'],
        summary: 'Wait for in-flight shim consumers to drain (no config change)',
        security: [{ bearerAuth: [] }],
      },
    },
    async (request): Promise<DrainNowResponse> => {
      const body = drainNowRequestSchema.parse(request.body ?? {});
      const userId = (request.user as { sub?: string } | undefined)?.sub;
      if (!userId) {
        throw new ApiError('UNAUTHORIZED', 'Authenticated user id missing', 401);
      }
      const { drain, taskId } = await runDrainNow(
        { db: app.db, log: request.log },
        {
          classes: body.classes,
          drainTimeoutSecondsOverride: body.drainTimeoutSecondsOverride,
          userId,
        },
      );
      return { data: drain, taskId };
    },
  );

  // ─── Status (operator visibility) ───────────────────────────────
  app.get('/admin/backup-rclone-shim/status', {
    onRequest: adminGate,
    schema: {
      tags: ['Backup Rclone Shim'],
      summary: 'Read the shim status ConfigMap + live in-flight counter',
      security: [{ bearerAuth: [] }],
    },
  }, async (request): Promise<ShimStatusResponse> => {
    const status = await readShimStatus(deps.buildK8sClients().core, request.log);
    const inflight = await snapshotInflightShimConsumers(app.db);
    const payload = {
      ...status,
      inflightConsumerCount: inflight.total,
    };
    return shimStatusResponseSchema.parse(success(payload));
  });
}
