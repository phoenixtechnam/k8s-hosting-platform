/**
 * Pre-capture DB dump orchestration glue.
 *
 * Wraps `preCaptureDatabaseDumps` (database-predump.ts) with the
 * platform-specific bits the orchestrator needs:
 *   - Query the tenant's deployment rows JOINED with catalog_entries
 *     so we know which deployments are databases.
 *   - Build a DbManagerContext per deployment via the existing SQL
 *     Manager primitive `db-manager.buildDbContext`.
 *   - Hand off to `preCaptureDatabaseDumps`.
 *
 * Kept separate from the orchestrator file so it can be unit-tested
 * with a stubbed db + a stubbed kube client. The orchestrator
 * remains a thin coordinator that calls this once.
 */

import { eq, and } from 'drizzle-orm';
import type { Database } from '../../../db/index.js';
import type { K8sClients } from '../../k8s-provisioner/k8s-client.js';
import { deployments, catalogEntries } from '../../../db/schema.js';
import {
  buildDbContext,
  exportDatabaseToPvc,
  listDatabases,
  type Engine,
} from '../../deployments/db-manager.js';
import {
  preCaptureDatabaseDumps,
  type PreDumpDeployment,
  type PreDumpDeploymentResult,
} from './database-predump.js';

export interface RunPreCaptureDumpsArgs {
  readonly db: Database;
  readonly k8s: K8sClients;
  readonly clientId: string;
  readonly namespace: string;
  readonly backupId: string;
  readonly kubeconfigPath?: string;
  readonly onProgress?: (msg: string) => void;
}

/**
 * Resolve every database deployment for the tenant and run the pre-
 * capture dump hook. Returns per-deployment results for the
 * orchestrator to log; never throws (failures are recorded in the
 * result rows so a single broken deployment does not abort the bundle).
 */
export async function runPreCaptureDatabaseDumps(
  args: RunPreCaptureDumpsArgs,
): Promise<ReadonlyArray<PreDumpDeploymentResult>> {
  // SELECT the database deployments. JOIN against catalog_entries
  // so we know runtime + type without a second round-trip.
  const rows = await args.db
    .select({
      deploymentId: deployments.id,
      deploymentName: deployments.name,
      configuration: deployments.configuration,
      catalogCode: catalogEntries.code,
      catalogRuntime: catalogEntries.runtime,
      catalogType: catalogEntries.type,
    })
    .from(deployments)
    .innerJoin(catalogEntries, eq(deployments.catalogEntryId, catalogEntries.id))
    .where(
      and(
        eq(deployments.clientId, args.clientId),
        eq(catalogEntries.type, 'database'),
      ),
    );

  if (rows.length === 0) {
    return [];
  }

  const dumpInputs: PreDumpDeployment[] = rows.map((r) => ({
    deploymentId: r.deploymentId,
    deploymentName: r.deploymentName,
    namespace: args.namespace,
    catalogCode: r.catalogCode,
    catalogRuntime: r.catalogRuntime,
    catalogType: r.catalogType,
    configuration: (r.configuration ?? {}) as Record<string, unknown>,
  }));

  return preCaptureDatabaseDumps(
    dumpInputs,
    {
      buildDbContext: async (dep) =>
        buildDbContext(
          args.k8s,
          args.kubeconfigPath,
          dep.namespace,
          dep.deploymentName,
          { runtime: dep.catalogRuntime, code: dep.catalogCode },
          (dep.configuration ?? {}) as Record<string, unknown>,
        ),
      // The DbManagerContext from buildDbContext carries k8s; the
      // hook adapter strips it back out per its narrower interface,
      // so the lambdas below cast to the shape preCaptureDatabaseDumps
      // expects.
      listDatabases: async (ctx) =>
        listDatabases(ctx as Parameters<typeof listDatabases>[0]),
      exportDatabaseToPvc: async (ctx, database, outputFileName, deploymentSubPath) =>
        exportDatabaseToPvc(
          ctx as Parameters<typeof exportDatabaseToPvc>[0],
          database,
          outputFileName,
          deploymentSubPath,
        ),
    },
    {
      backupId: args.backupId,
      onProgress: args.onProgress,
    },
  );
}

// Re-export for orchestrator imports + ergonomic typing.
export type { PreDumpDeploymentResult, Engine };
