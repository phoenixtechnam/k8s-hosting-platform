import { z } from 'zod';

// ─── Snapshot Accounting (Phase 1 of snapshot-storage overhaul) ─────────
//
// Per-tenant + per-subsystem aggregate view of all snapshots tracked in
// `storage_snapshots`. The admin UI Storage > Overview tab consumes this
// to surface accountability: which tenant has how many snapshots, how
// much disk they consume, when the most recent one landed.
//
// `snapshotClass` and `subsystem` mirror the columns added in migration
// 0003. Future phases (per-class target routing, quota enforcement) read
// the same shape — keeping a single contract avoids drift between the
// observability and policy paths.

export const snapshotClassEnum = z.enum([
  'tenant_snapshot',
  'tenant_bundle',
  'system_snapshot',
  'system_etcd',
  'system_secrets',
]);
export type SnapshotClass = z.infer<typeof snapshotClassEnum>;

// Free-form string in the DB (varchar 64) so new subsystems can land
// without a schema change, but we declare the known producers here so
// the UI can render friendly names + colours.
export const knownSubsystems = [
  'tenant-pvc',
  'mail-rocksdb',
  'longhorn-volume',
  'system-etcd',
  'system-secrets',
  'hostpath-archive',
] as const;
export type KnownSubsystem = (typeof knownSubsystems)[number];

// ─── Per-class aggregate ────────────────────────────────────────────────

export const snapshotClassAggregateSchema = z.object({
  snapshotClass: z.string().min(1).max(32),
  subsystem: z.string().min(1).max(64),
  totalCount: z.number().int().nonnegative(),
  totalBytes: z.number().nonnegative(),
  // Most recent created_at across the matching rows. ISO-8601, nullable
  // when no snapshots exist yet for this (class, subsystem) pair.
  lastSnapshotAt: z.string().datetime().nullable(),
  // Most recent successful upload (status='ready'). Diverges from
  // lastSnapshotAt when the only recent snapshots failed mid-stream.
  lastReadyAt: z.string().datetime().nullable(),
});
export type SnapshotClassAggregate = z.infer<typeof snapshotClassAggregateSchema>;

// ─── Per-tenant aggregate ───────────────────────────────────────────────

export const tenantSnapshotAggregateSchema = z.object({
  tenantId: z.string().uuid(),
  tenantName: z.string(),
  totalCount: z.number().int().nonnegative(),
  totalBytes: z.number().nonnegative(),
  lastSnapshotAt: z.string().datetime().nullable(),
  // Per-class breakdown for this tenant. Empty array if the tenant has
  // no snapshots yet.
  byClass: z.array(z.object({
    snapshotClass: z.string().min(1).max(32),
    count: z.number().int().nonnegative(),
    bytes: z.number().nonnegative(),
  })),
});
export type TenantSnapshotAggregate = z.infer<typeof tenantSnapshotAggregateSchema>;

// ─── Top-level accounting response ──────────────────────────────────────

export const snapshotAccountingResponseSchema = z.object({
  // Aggregate sums across all snapshots, all tenants, all classes.
  total: z.object({
    count: z.number().int().nonnegative(),
    bytes: z.number().nonnegative(),
  }),
  // One row per (snapshot_class, subsystem) pair.
  byClass: z.array(snapshotClassAggregateSchema),
  // One row per tenant that has at least one snapshot, sorted by
  // totalBytes DESC. Capped at 100 — the UI will paginate if needed.
  topTenants: z.array(tenantSnapshotAggregateSchema),
  // Generated-at timestamp so the UI can show "as of X seconds ago".
  generatedAt: z.string().datetime(),
});
export type SnapshotAccountingResponse = z.infer<typeof snapshotAccountingResponseSchema>;
