/**
 * Private-worker service layer.
 *
 * Per-client tunnel agents that let an external service (home box, NAS,
 * GPU machine, on-prem VPS) be exposed under the platform's ingress.
 *
 * Token model: a single base64url-encoded JSON blob is shipped to the
 * agent via the `PRIVATE_WORKER_TOKEN` env var. The platform persists
 * only the SHA-256 hash of the inner secret, never the plaintext.
 *
 * See docs/04-deployment/PRIVATE_WORKER.md for the design in full.
 */

import crypto from 'crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  clients,
  privateWorkerAudit,
  privateWorkers,
  type PrivateWorker,
  type PrivateWorkerAuditRow,
} from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';
import type { Database } from '../../db/index.js';
import type {
  CreatePrivateWorkerInput,
  PrivateWorkerAuditEntry,
  PrivateWorkerResponse,
  PrivateWorkerSecretResponse,
  UpdatePrivateWorkerInput,
} from '@k8s-hosting/api-contracts';

// ─── Constants ──────────────────────────────────────────────────────────────

const SECRET_BYTES = 32;
const SLUG_RANDOM_SUFFIX_BYTES = 4;
const DEFAULT_AUDIT_LIMIT = 50;
function getAgentImage(): string {
  return (
    process.env.PRIVATE_WORKER_AGENT_IMAGE
    ?? 'ghcr.io/phoenixtechnam/hosting-platform/private-worker-agent:latest'
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTunnelBaseDomain(): string {
  // Returns the apex of the per-worker subdomain (e.g. `tunnels.example.com`).
  // Each worker gets its own FQDN `<slug>.tunnels.example.com` because frp
  // v0.62 hardcodes its WebSocket path — we cannot route by URL path so
  // each worker must have a distinct hostname. cert-manager issues a
  // per-FQDN HTTP-01 cert at reconcile time.
  //
  // Priority: explicit TUNNEL_BASE_URL env (e.g. wss://tunnels.example.com)
  //  → strip wss:// and extract the host. Otherwise derive from
  // PLATFORM_BASE_DOMAIN as `tunnels.${PLATFORM_BASE_DOMAIN}`.
  const explicit = process.env.TUNNEL_BASE_URL;
  if (explicit && explicit.length > 0) {
    const stripped = explicit
      .replace(/^wss?:\/\//, '')
      .replace(/\/+$/, '');
    return stripped;
  }
  const platformDomain =
    process.env.PLATFORM_BASE_DOMAIN
    ?? process.env.INGRESS_BASE_DOMAIN
    ?? 'k8s-platform.test';
  return `tunnels.${platformDomain}`;
}

function getTunnelScheme(): string {
  // Operator-overridable for local dev. Default WSS. Local dev sets
  // TUNNEL_BASE_URL=ws://... (no TLS) so we honour that.
  const explicit = process.env.TUNNEL_BASE_URL;
  if (explicit && explicit.startsWith('ws://')) return 'ws';
  return 'wss';
}

function buildWorkerServerUrl(slug: string): string {
  return `${getTunnelScheme()}://${slug}.${getTunnelBaseDomain()}/`;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function randomSlugSuffix(): string {
  return crypto.randomBytes(SLUG_RANDOM_SUFFIX_BYTES).toString('hex');
}

async function generateUniqueSlug(db: Database, name: string): Promise<string> {
  const base = slugify(name) || 'worker';
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = `${base}-${randomSlugSuffix()}`;
    // Slug column has a unique constraint at the DB layer; this probe
    // just makes the failure surface as a clean error rather than a
    // raw insert violation when there's a collision.
     
    const [existing] = await db
      .select({ id: privateWorkers.id })
      .from(privateWorkers)
      .where(eq(privateWorkers.slug, candidate));
    if (!existing) return candidate;
  }
  throw new ApiError(
    'SLUG_GENERATION_FAILED',
    'Failed to generate a unique slug after multiple attempts',
    500,
  );
}

function generateSecret(): string {
  return crypto.randomBytes(SECRET_BYTES).toString('base64url');
}

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/**
 * Per-client shared auth token used by frps. frps 0.62 supports exactly one
 * `auth.token` per server, and we run one frps pod per client — so all
 * workers under the same client share a single auth token. Stored plaintext
 * in `clients.private_worker_shared_secret` (column added in migration 0077);
 * generated lazily on first worker mint and re-used for every subsequent
 * worker minted under the same client. Per-worker revocation is enforced
 * separately by the reconciler via frps `allowPorts`.
 */
async function ensureClientSharedSecret(
  db: Database,
  clientId: string,
): Promise<string> {
  const [row] = await db
    .select({ secret: clients.privateWorkerSharedSecret })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (!row) {
    throw new ApiError('CLIENT_NOT_FOUND', `Client '${clientId}' not found`, 404);
  }
  if (row.secret) return row.secret;
  // First worker for this client — mint a shared secret atomically.
  // The conditional UPDATE handles two concurrent mints racing here:
  // whichever one wins sets the value, the loser's UPDATE is a no-op
  // and we then re-read.
  const fresh = generateSecret();
  await db
    .update(clients)
    .set({ privateWorkerSharedSecret: fresh })
    .where(and(eq(clients.id, clientId), isNull(clients.privateWorkerSharedSecret)));
  const [after] = await db
    .select({ secret: clients.privateWorkerSharedSecret })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (!after?.secret) {
    throw new ApiError(
      'PRIVATE_WORKER_SHARED_SECRET_MISSING',
      'Failed to mint or read the per-client shared auth secret',
      500,
    );
  }
  return after.secret;
}

// Token blob v2: cluster-side concerns only. The home-side target
// (where the agent forwards traffic to) is declared by the operator at
// agent runtime via PRIVATE_WORKER_TARGET env, NOT baked into the token.
// This decouples "which cluster port the worker exposes" (platform-owned,
// auto-allocated) from "where the agent should send tunnel traffic"
// (operator-owned, chosen at docker run time).
interface TokenBlobV2 {
  readonly v: 2;
  readonly slug: string;
  readonly server_url: string;
  readonly secret: string;
  readonly expose: ReadonlyArray<{
    readonly name: string;
    readonly remote_port: number;
  }>;
}

function buildTokenBlob(
  slug: string,
  secret: string,
  exposedPort: number,
): string {
  const blob: TokenBlobV2 = {
    v: 2,
    slug,
    server_url: buildWorkerServerUrl(slug),
    secret,
    expose: [
      {
        name: 'web',
        remote_port: exposedPort,
      },
    ],
  };
  return Buffer.from(JSON.stringify(blob), 'utf8').toString('base64url');
}

// Auto-allocated port range. Per-client frps pod has its own Linux
// netns so ports collide only within one client; a 10k-slot pool is
// enormous compared to realistic worker counts.
const PORT_POOL_LOW = 10000;
const PORT_POOL_HIGH = 19999;

/**
 * Pick the lowest unused port in [PORT_POOL_LOW, PORT_POOL_HIGH] for
 * this client by reading existing rows. The DB-level unique index on
 * (client_id, exposed_port) (migration 0089) is what actually prevents
 * a race between SELECT and INSERT — if a concurrent create won the
 * lowest port, the caller's INSERT fails with a unique-violation and
 * we get retried. This function only computes the next-best candidate.
 */
async function pickExposedPortCandidate(
  db: Database,
  clientId: string,
): Promise<number> {
  const used = await db
    .select({ port: privateWorkers.exposedPort })
    .from(privateWorkers)
    .where(eq(privateWorkers.clientId, clientId));
  const usedSet = new Set(used.map((r) => r.port));
  for (let p = PORT_POOL_LOW; p <= PORT_POOL_HIGH; p++) {
    if (!usedSet.has(p)) return p;
  }
  throw new ApiError(
    'PORT_POOL_EXHAUSTED',
    `No free port in [${PORT_POOL_LOW},${PORT_POOL_HIGH}] for this client`,
    503,
  );
}

function isUniqueViolation(err: unknown): boolean {
  // Postgres SQLSTATE 23505 — unique_violation. Drizzle / pg expose it on
  // the wrapped error's `code` (or `cause.code`) depending on the driver.
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  if (e.code === '23505') return true;
  if (e.cause && e.cause.code === '23505') return true;
  return false;
}

function buildDockerRunCommand(token: string): string {
  return [
    'docker run -d',
    '--name private-worker',
    '--restart unless-stopped',
    '--add-host=host.docker.internal:host-gateway',
    `-e PRIVATE_WORKER_TOKEN='${token}'`,
    "-e PRIVATE_WORKER_TARGET='host.docker.internal:8080'",
    getAgentImage(),
  ].join(' ');
}

function buildDockerComposeYaml(token: string): string {
  return [
    'services:',
    '  private-worker:',
    `    image: ${getAgentImage()}`,
    '    container_name: private-worker',
    '    restart: unless-stopped',
    '    # Linux Docker needs an explicit host-gateway for host.docker.internal.',
    '    # Remove this line if your target lives in another compose service.',
    '    extra_hosts:',
    '      - "host.docker.internal:host-gateway"',
    '    environment:',
    `      PRIVATE_WORKER_TOKEN: "${token}"`,
    '      # Where the agent forwards incoming tunnel traffic. Examples:',
    '      #   another compose service:    PRIVATE_WORKER_TARGET: "myapp:80"',
    '      #   docker host loopback:       PRIVATE_WORKER_TARGET: "host.docker.internal:8080"',
    '      #   a LAN device:               PRIVATE_WORKER_TARGET: "192.168.1.5:80"',
    '      PRIVATE_WORKER_TARGET: "host.docker.internal:8080"',
    '',
  ].join('\n');
}

function mapPrivateWorkerToResponse(row: PrivateWorker): PrivateWorkerResponse {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    slug: row.slug,
    status: row.status,
    exposedPort: row.exposedPort,
    description: row.description ?? null,
    serviceName: `pw-${row.id}`,
    tunnelUrl: buildWorkerServerUrl(row.slug),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    lastUsedIp: row.lastUsedIp ?? null,
    bytesIn: row.bytesIn,
    bytesOut: row.bytesOut,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapAuditRowToResponse(row: PrivateWorkerAuditRow): PrivateWorkerAuditEntry {
  return {
    id: row.id,
    privateWorkerId: row.privateWorkerId,
    event: row.event,
    ip: row.ip ?? null,
    detail: row.detail ?? null,
    occurredAt: row.occurredAt.toISOString(),
  };
}

async function writeAudit(
  db: Database,
  privateWorkerId: string,
  event: string,
  ip: string | null,
  detail: Record<string, unknown> | null,
): Promise<void> {
  await db.insert(privateWorkerAudit).values({
    privateWorkerId,
    event,
    ip,
    detail: detail ?? undefined,
  });
}

async function fetchByIdScoped(
  db: Database,
  clientId: string,
  workerId: string,
): Promise<PrivateWorker> {
  const [row] = await db
    .select()
    .from(privateWorkers)
    .where(
      and(
        eq(privateWorkers.id, workerId),
        eq(privateWorkers.clientId, clientId),
      ),
    );
  if (!row) {
    throw new ApiError(
      'PRIVATE_WORKER_NOT_FOUND',
      `Private worker '${workerId}' not found`,
      404,
    );
  }
  return row;
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function listPrivateWorkers(
  db: Database,
  clientId: string,
): Promise<PrivateWorkerResponse[]> {
  const rows = await db
    .select()
    .from(privateWorkers)
    .where(eq(privateWorkers.clientId, clientId))
    .orderBy(desc(privateWorkers.createdAt));
  return rows.map(mapPrivateWorkerToResponse);
}

export async function getPrivateWorker(
  db: Database,
  clientId: string,
  workerId: string,
): Promise<PrivateWorkerResponse> {
  const row = await fetchByIdScoped(db, clientId, workerId);
  return mapPrivateWorkerToResponse(row);
}

export async function createPrivateWorker(
  db: Database,
  clientId: string,
  input: CreatePrivateWorkerInput,
  createdBy: string | null,
  requesterIp?: string | null,
): Promise<PrivateWorkerSecretResponse> {
  // Reject duplicates on (client_id, name) — surfaced as a clean 409
  // rather than a unique-constraint violation from drizzle.
  const [byName] = await db
    .select({ id: privateWorkers.id })
    .from(privateWorkers)
    .where(
      and(
        eq(privateWorkers.clientId, clientId),
        eq(privateWorkers.name, input.name),
      ),
    );
  if (byName) {
    throw new ApiError(
      'DUPLICATE_PRIVATE_WORKER_NAME',
      `A private worker named '${input.name}' already exists for this client`,
      409,
    );
  }

  // Slug — caller-provided OR derived from name. If caller-provided, it
  // must be globally unique because it appears in
  // `tunnels.${DOMAIN}/c/<slug>/` for every client.
  let slug: string;
  if (input.slug) {
    const [collision] = await db
      .select({ id: privateWorkers.id })
      .from(privateWorkers)
      .where(eq(privateWorkers.slug, input.slug));
    if (collision) {
      throw new ApiError(
        'DUPLICATE_PRIVATE_WORKER_SLUG',
        `Slug '${input.slug}' is already taken`,
        409,
      );
    }
    slug = input.slug;
  } else {
    slug = await generateUniqueSlug(db, input.name);
  }

  const id = crypto.randomUUID();
  // The actual frps auth token is the per-client shared secret (one frps
  // pod per client = one auth.token). The per-worker `worker_token_hash`
  // is a per-row marker for record-keeping and future per-worker auth via
  // an frps webhook plugin (post-v1).
  const sharedSecret = await ensureClientSharedSecret(db, clientId);
  const workerTokenHash = hashSecret(sharedSecret);

  // Auto-allocate the cluster-side port. End users never pick this —
  // it's the platform's routing concern (frps allowPorts + Service
  // targetPort). The home-side target where the agent forwards traffic
  // is a separate operator-runtime concern, declared via the
  // PRIVATE_WORKER_TARGET env var on the agent container.
  //
  // Race protection: the DB has a unique (client_id, exposed_port)
  // index (migration 0089). On concurrent creates, both pick the same
  // lowest-free candidate, the second INSERT fails 23505, we retry.
  // The retry budget is small (port pool is huge vs realistic worker
  // counts) — capped at 8 to avoid pathological loops.
  const MAX_PORT_RETRIES = 8;
  let exposedPort = -1;
  let inserted = false;
  for (let attempt = 0; attempt < MAX_PORT_RETRIES; attempt++) {
    exposedPort = await pickExposedPortCandidate(db, clientId);
    try {
      await db.insert(privateWorkers).values({
        id,
        clientId,
        name: input.name,
        slug,
        workerTokenHash,
        status: 'pending',
        exposedPort,
        description: input.description ?? null,
        createdBy,
      });
      inserted = true;
      break;
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Most likely the (client_id, exposed_port) index — racing create.
        // Retry with a new candidate.
        continue;
      }
      throw err;
    }
  }
  if (!inserted) {
    throw new ApiError(
      'PORT_ALLOCATION_RETRY_EXHAUSTED',
      `Could not allocate an unused port after ${MAX_PORT_RETRIES} attempts`,
      503,
    );
  }

  await writeAudit(db, id, 'mint', requesterIp ?? null, {
    createdBy,
    exposedPort,
    slug,
  });

  const [created] = await db
    .select()
    .from(privateWorkers)
    .where(eq(privateWorkers.id, id));
  if (!created) {
    throw new ApiError(
      'PRIVATE_WORKER_CREATE_FAILED',
      'Private worker insert succeeded but row could not be re-fetched',
      500,
    );
  }

  const token = buildTokenBlob(slug, sharedSecret, created.exposedPort);
  return {
    workerId: id,
    token,
    dockerRunCommand: buildDockerRunCommand(token),
    dockerComposeYaml: buildDockerComposeYaml(token),
    worker: mapPrivateWorkerToResponse(created),
  };
}

export async function updatePrivateWorker(
  db: Database,
  clientId: string,
  workerId: string,
  input: UpdatePrivateWorkerInput,
): Promise<PrivateWorkerResponse> {
  await fetchByIdScoped(db, clientId, workerId);

  const updates: Record<string, unknown> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;

  if (Object.keys(updates).length === 0) {
    const row = await fetchByIdScoped(db, clientId, workerId);
    return mapPrivateWorkerToResponse(row);
  }

  // Detect client-scoped name collision before writing.
  if (input.name !== undefined) {
    const [byName] = await db
      .select({ id: privateWorkers.id })
      .from(privateWorkers)
      .where(
        and(
          eq(privateWorkers.clientId, clientId),
          eq(privateWorkers.name, input.name),
        ),
      );
    if (byName && byName.id !== workerId) {
      throw new ApiError(
        'DUPLICATE_PRIVATE_WORKER_NAME',
        `A private worker named '${input.name}' already exists for this client`,
        409,
      );
    }
  }

  await db.update(privateWorkers).set(updates).where(eq(privateWorkers.id, workerId));
  const updated = await fetchByIdScoped(db, clientId, workerId);
  return mapPrivateWorkerToResponse(updated);
}

export async function rotatePrivateWorker(
  db: Database,
  clientId: string,
  workerId: string,
  rotatedBy: string | null,
  requesterIp?: string | null,
): Promise<PrivateWorkerSecretResponse> {
  const existing = await fetchByIdScoped(db, clientId, workerId);

  if (existing.status === 'revoked') {
    throw new ApiError(
      'PRIVATE_WORKER_REVOKED',
      'Cannot rotate token for a revoked private worker; create a new one',
      400,
    );
  }

  // v1 limitation: frps 0.62 supports one auth.token per server, so all
  // workers under a client share the same secret. Rotating one worker
  // rotates the secret for every sibling worker. The UI warns about this.
  const newSharedSecret = generateSecret();
  await db
    .update(clients)
    .set({ privateWorkerSharedSecret: newSharedSecret })
    .where(eq(clients.id, clientId));

  const workerTokenHash = hashSecret(newSharedSecret);
  await db
    .update(privateWorkers)
    .set({
      workerTokenHash,
      revokedAt: null,
      revokedBy: null,
      status: existing.status === 'suspended' ? 'suspended' : 'active',
    })
    .where(eq(privateWorkers.id, workerId));

  // Bump the workerTokenHash on every other active worker for this
  // client so the UI reflects the rotation.
  await db
    .update(privateWorkers)
    .set({ workerTokenHash })
    .where(and(eq(privateWorkers.clientId, clientId), inArray(privateWorkers.status, ['pending', 'active', 'suspended'])));

  await writeAudit(db, workerId, 'rotate', requesterIp ?? null, {
    rotatedBy,
    rotatedSharedSecret: true,
  });

  const refreshed = await fetchByIdScoped(db, clientId, workerId);
  const token = buildTokenBlob(refreshed.slug, newSharedSecret, refreshed.exposedPort);
  return {
    workerId,
    token,
    dockerRunCommand: buildDockerRunCommand(token),
    dockerComposeYaml: buildDockerComposeYaml(token),
    worker: mapPrivateWorkerToResponse(refreshed),
  };
}

export async function revokePrivateWorker(
  db: Database,
  clientId: string,
  workerId: string,
  revokedBy: string | null,
  requesterIp?: string | null,
): Promise<PrivateWorkerResponse> {
  const existing = await fetchByIdScoped(db, clientId, workerId);

  if (existing.status === 'revoked') {
    return mapPrivateWorkerToResponse(existing);
  }

  const now = new Date();
  await db
    .update(privateWorkers)
    .set({
      status: 'revoked',
      revokedAt: now,
      revokedBy,
    })
    .where(eq(privateWorkers.id, workerId));

  await writeAudit(db, workerId, 'revoke', requesterIp ?? null, { revokedBy });

  const refreshed = await fetchByIdScoped(db, clientId, workerId);
  return mapPrivateWorkerToResponse(refreshed);
}

export async function deletePrivateWorker(
  db: Database,
  clientId: string,
  workerId: string,
  deletedBy: string | null,
): Promise<void> {
  const existing = await fetchByIdScoped(db, clientId, workerId);

  // Best-effort revoke first so the audit row records the user-visible
  // "this token is dead" event before the row disappears. We skip the
  // re-fetch overhead — if the worker is already revoked, just delete.
  if (existing.status !== 'revoked') {
    await db
      .update(privateWorkers)
      .set({
        status: 'revoked',
        revokedAt: new Date(),
        revokedBy: deletedBy,
      })
      .where(eq(privateWorkers.id, workerId));
    await writeAudit(db, workerId, 'revoke', null, { revokedBy: deletedBy, reason: 'pre-delete' });
  }

  // Audit rows cascade-delete via FK; explicit cleanup not needed.
  await db.delete(privateWorkers).where(eq(privateWorkers.id, workerId));
}

// ─── Audit ──────────────────────────────────────────────────────────────────

export async function listPrivateWorkerAudit(
  db: Database,
  clientId: string,
  workerId: string,
  limit: number = DEFAULT_AUDIT_LIMIT,
): Promise<PrivateWorkerAuditEntry[]> {
  // Verify the worker belongs to the client before exposing audit rows.
  await fetchByIdScoped(db, clientId, workerId);

  const safeLimit = Math.min(Math.max(limit, 1), 200);
  const rows = await db
    .select()
    .from(privateWorkerAudit)
    .where(eq(privateWorkerAudit.privateWorkerId, workerId))
    .orderBy(desc(privateWorkerAudit.occurredAt))
    .limit(safeLimit);
  return rows.map(mapAuditRowToResponse);
}

// ─── Connection events (called from the internal route) ─────────────────────

export type ConnectEventType = 'connect' | 'disconnect' | 'auth-fail';

export async function recordConnectEvent(
  db: Database,
  slug: string,
  ip: string,
  eventType: ConnectEventType,
): Promise<{ matched: boolean }> {
  const [worker] = await db
    .select()
    .from(privateWorkers)
    .where(eq(privateWorkers.slug, slug));
  if (!worker) {
    return { matched: false };
  }

  // Skip last_seen / last_used_ip updates for revoked workers — a stale
  // agent that hasn't received the revocation yet shouldn't be able to
  // overwrite the operator-visible "last legitimate connection" data.
  // We still write the audit row so auth-fail / connect attempts remain
  // visible for forensics.
  const isRevoked = worker.status === 'revoked';
  const now = new Date();
  if (!isRevoked && eventType === 'connect') {
    await db
      .update(privateWorkers)
      .set({ lastSeenAt: now, lastUsedIp: ip })
      .where(eq(privateWorkers.id, worker.id));
  } else if (!isRevoked && eventType === 'disconnect') {
    await db
      .update(privateWorkers)
      .set({ lastUsedIp: ip })
      .where(eq(privateWorkers.id, worker.id));
  }

  await writeAudit(db, worker.id, eventType, ip, isRevoked ? { fromRevokedWorker: true } : null);
  return { matched: true };
}
