// Routes for per-class snapshot target assignments.
//
//   GET  /api/v1/admin/snapshots/classes
//   PUT  /api/v1/admin/snapshots/classes/:class/assignments
//   POST /api/v1/admin/snapshots/classes/:class/test
//
// All admin-only. The test endpoint is a small reachability probe (no
// real upload until Phase 4); for now it confirms (a) a target is
// assigned to the class and (b) the assigned target's credentials
// decrypt cleanly — a working canary for the credential-encryption
// path.

import type { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import * as service from './service.js';
import {
  setAssignmentsInputSchema,
  snapshotClassEnum,
  type SnapshotClass,
  type TestClassResponse,
} from '@k8s-hosting/api-contracts';

function parseSnapshotClass(raw: string): SnapshotClass {
  const parsed = snapshotClassEnum.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      'INVALID_SNAPSHOT_CLASS',
      `Unknown snapshot_class '${raw}' — valid values: ${snapshotClassEnum.options.join(', ')}`,
      400,
    );
  }
  return parsed.data;
}

export async function snapshotClassesRoutes(app: FastifyInstance): Promise<void> {
  const adminGate = [authenticate, requireRole('super_admin', 'admin')];

  // ─── List ───────────────────────────────────────────────────────────
  app.get('/admin/snapshots/classes', {
    onRequest: adminGate,
    schema: {
      tags: ['Snapshot Classes'],
      summary: 'List every snapshot class with its current target assignment set',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    return success(await service.listClasses(app.db));
  });

  // ─── Bulk reverse summary ───────────────────────────────────────────
  //
  // For each backup target, list the classes that route to it (with
  // priority). Drives the per-target "Used by classes" pill on the
  // backup-settings page so the operator can see at a glance which
  // targets are unassigned (safe to delete) and which are load-bearing.
  app.get('/admin/snapshots/target-summaries', {
    onRequest: adminGate,
    schema: {
      tags: ['Snapshot Classes'],
      summary: 'Per-target reverse view of class assignments',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const summaries = await service.getAllTargetAssignmentsSummaries(app.db);
    return success({ summaries });
  });

  // ─── Replace assignments for one class ──────────────────────────────
  app.put('/admin/snapshots/classes/:class/assignments', {
    onRequest: adminGate,
    schema: {
      tags: ['Snapshot Classes'],
      summary: 'Replace the target assignment set for one snapshot class',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { class: rawClass } = request.params as { class: string };
    const snapshotClass = parseSnapshotClass(rawClass);
    const parsed = setAssignmentsInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0].message, 400);
    }
    return success(await service.setAssignments(app.db, snapshotClass, parsed.data));
  });

  // ─── Probe assigned primary target ──────────────────────────────────
  //
  // Lightweight in this phase: resolve primary, decrypt credentials,
  // return ok/latency. Phase 4 will swap the body for a real 1 KiB
  // upload-probe against the resolved StreamingSnapshotStore.
  app.post('/admin/snapshots/classes/:class/test', {
    onRequest: adminGate,
    schema: {
      tags: ['Snapshot Classes'],
      summary: 'Probe the primary target assigned to a snapshot class',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { class: rawClass } = request.params as { class: string };
    const snapshotClass = parseSnapshotClass(rawClass);
    const t0 = Date.now();
    const primary = await service.resolvePrimaryTarget(app.db, snapshotClass);

    if (!primary) {
      const resp: TestClassResponse = {
        snapshotClass,
        targetId: null,
        targetName: null,
        ok: false,
        latencyMs: Date.now() - t0,
        error: {
          code: 'NO_SNAPSHOT_TARGET',
          message: `No target assigned to ${snapshotClass} — configure one at /settings/snapshot-classes`,
        },
      };
      return success(resp);
    }

    // Credential-decrypt probe: re-uses the existing backup-config
    // testConnection helper which validates credentials end-to-end
    // for each backend type. This gives us "credentials decrypt and
    // the storage backend handshakes" in one call.
    //
    // PLATFORM_ENCRYPTION_KEY must be set in any non-dev install — a
    // zero-byte fallback would silently misdecrypt real ciphertext and
    // make the probe meaningless. Throw a clear 500 instead.
    const { testConnection } = await import('../backup-config/service.js');
    const encryptionKey = process.env.PLATFORM_ENCRYPTION_KEY;
    if (!encryptionKey) {
      throw new ApiError(
        'CONFIGURATION_ERROR',
        'PLATFORM_ENCRYPTION_KEY is not set — cannot decrypt target credentials',
        500,
      );
    }
    try {
      const result = await testConnection(app.db, primary.targetId, encryptionKey);
      const resp: TestClassResponse = {
        snapshotClass,
        targetId: primary.targetId,
        targetName: primary.targetName,
        ok: result.ok,
        latencyMs: Date.now() - t0,
        error: result.ok ? null : {
          code: result.error?.code ?? 'PROBE_FAILED',
          message: result.error?.message ?? 'Probe failed',
        },
      };
      return success(resp);
    } catch (err) {
      const resp: TestClassResponse = {
        snapshotClass,
        targetId: primary.targetId,
        targetName: primary.targetName,
        ok: false,
        latencyMs: Date.now() - t0,
        error: {
          code: 'PROBE_FAILED',
          message: err instanceof Error ? err.message : String(err),
        },
      };
      return success(resp);
    }
  });
}
