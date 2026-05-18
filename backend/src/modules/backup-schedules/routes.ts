import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  updateBackupScheduleSchema,
  backupScheduleSubsystemEnum,
} from '@k8s-hosting/api-contracts';
import * as service from './service.js';

function actorIdOf(req: FastifyRequest): string | null {
  const u = req.user as { sub?: string; id?: string } | undefined;
  return u?.sub ?? u?.id ?? null;
}

export async function backupSchedulesRoutes(app: FastifyInstance): Promise<void> {
  const adminGate = [authenticate, requireRole('super_admin', 'admin')];

  app.get('/admin/backups/schedules', {
    onRequest: adminGate,
    schema: {
      tags: ['Backup Schedules'],
      summary: 'List every backup schedule with its gate state',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const schedules = await service.listSchedules(app.db);
    return success({ schedules });
  });

  app.get('/admin/backups/schedules/:subsystem', {
    onRequest: adminGate,
    schema: {
      tags: ['Backup Schedules'],
      summary: 'Read one backup schedule',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { subsystem } = request.params as { subsystem: string };
    const row = await service.getSchedule(app.db, subsystem);
    if (!row) {
      throw new ApiError(
        'SUBSYSTEM_NOT_FOUND',
        `No schedule for subsystem '${subsystem}'`,
        404,
      );
    }
    return success(row);
  });

  app.patch('/admin/backups/schedules/:subsystem', {
    onRequest: adminGate,
    schema: {
      tags: ['Backup Schedules'],
      summary: 'Update enable / cron / retention. Strict-gates enable=true.',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { subsystem } = request.params as { subsystem: string };
    // Allow any free-form subsystem string per migration 0011 (so new
    // subsystems land without a contract bump), but reject obvious
    // garbage. The enum guard surfaces unknown subsystems as a 400.
    if (!backupScheduleSubsystemEnum.options.includes(subsystem as never)) {
      throw new ApiError(
        'UNKNOWN_SUBSYSTEM',
        `Subsystem '${subsystem}' is not in the known enum: ${backupScheduleSubsystemEnum.options.join(', ')}`,
        400,
      );
    }
    const parsed = updateBackupScheduleSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    }
    const row = await service.updateSchedule(app.db, subsystem, parsed.data, actorIdOf(request));
    return success(row);
  });
}
