import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import crypto from 'crypto';
import net from 'net';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { sftpUsers, sftpAuditLog, clients, sshKeys } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import { ensureFileManagerRunning } from '../file-manager/k8s-lifecycle.js';
import { recordFileManagerAccess } from '../file-manager/idle-cleanup.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { success } from '../../shared/response.js';

// ─── Internal Request Schemas ────────────────────────────────────────────────

const passwordAuthSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  source_ip: z.string().ip(),
});

const keyAuthSchema = z.object({
  username: z.string().min(1),
  public_key_fingerprint: z.string().min(1),
  source_ip: z.string().ip(),
});

const auditEventSchema = z.object({
  sftp_user_id: z.string().optional(),
  client_id: z.string().min(1),
  event: z.string().min(1),
  source_ip: z.string().min(1),
  protocol: z.string().optional(),
  session_id: z.string().optional(),
  duration_seconds: z.number().optional(),
  bytes_transferred: z.number().optional(),
  error_message: z.string().max(2000).optional(),
});

const auditBatchSchema = z.object({
  events: z.array(auditEventSchema).min(1),
});

const ensureFileManagerSchema = z.object({
  namespace: z.string().min(1),
});

const updateLoginSchema = z.object({
  username: z.string().min(1),
  source_ip: z.string().ip(),
});

// ─── IP Whitelist Checking ─────────────────────────────────────────────────

function ipToNumber(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipv6Expand(ip: string): string {
  // Expand :: notation to full 8-group form
  const halves = ip.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  const middle = Array(missing).fill('0000');
  const groups = [...left, ...middle, ...right];
  return groups.map((g) => g.padStart(4, '0')).join(':');
}

function ipv6ToBuffer(ip: string): Buffer {
  const expanded = ipv6Expand(ip);
  const groups = expanded.split(':');
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const val = parseInt(groups[i], 16);
    buf.writeUInt16BE(val, i * 2);
  }
  return buf;
}

function isIpInCidr(sourceIp: string, cidr: string): boolean {
  const [network, prefixStr] = cidr.split('/');
  const isSourceV6 = net.isIPv6(sourceIp);
  const isNetworkV6 = net.isIPv6(network);

  // Both must be same family
  if (isSourceV6 !== isNetworkV6) return false;

  if (!isSourceV6) {
    // IPv4
    const prefix = prefixStr ? Number(prefixStr) : 32;
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const srcNum = ipToNumber(sourceIp);
    const netNum = ipToNumber(network);
    return (srcNum & mask) === (netNum & mask);
  }

  // IPv6
  const prefix = prefixStr ? Number(prefixStr) : 128;
  const srcBuf = ipv6ToBuffer(sourceIp);
  const netBuf = ipv6ToBuffer(network);
  const fullBytes = Math.floor(prefix / 8);
  const remainBits = prefix % 8;

  for (let i = 0; i < fullBytes; i++) {
    if (srcBuf[i] !== netBuf[i]) return false;
  }
  if (remainBits > 0 && fullBytes < 16) {
    const mask = (~0 << (8 - remainBits)) & 0xff;
    if ((srcBuf[fullBytes] & mask) !== (netBuf[fullBytes] & mask)) return false;
  }
  return true;
}

function isIpAllowed(sourceIp: string, whitelist: string | null): boolean {
  if (!whitelist || whitelist.trim() === '') return true;

  const cidrs = whitelist.split(',').map((c) => c.trim()).filter(Boolean);
  if (cidrs.length === 0) return true;

  return cidrs.some((cidr) => {
    // If no prefix given, treat as single-host CIDR
    if (!cidr.includes('/')) {
      const bits = net.isIPv6(cidr) ? 128 : 32;
      return isIpInCidr(sourceIp, `${cidr}/${bits}`);
    }
    return isIpInCidr(sourceIp, cidr);
  });
}

// ─── Namespace Lookup ──────────────────────────────────────────────────────

async function getClientNamespace(
  db: Database,
  clientId: string,
): Promise<string | null> {
  const [client] = await db
    .select({ kubernetesNamespace: clients.kubernetesNamespace })
    .from(clients)
    .where(eq(clients.id, clientId));
  return client?.kubernetesNamespace ?? null;
}

// ─── Internal Routes ───────────────────────────────────────────────────────

export async function sftpInternalRoutes(app: FastifyInstance): Promise<void> {
  // Cache K8s client — created once per plugin registration, not per request.
  const kubeconfigPath = process.env.KUBECONFIG;
  const k8sClients = kubeconfigPath ? createK8sClients(kubeconfigPath) : null;

  // Verify X-Internal-Auth header matches PLATFORM_INTERNAL_SECRET
  app.addHook('onRequest', async (request, reply) => {
    const secret = process.env.PLATFORM_INTERNAL_SECRET;
    const provided = request.headers['x-internal-auth'];
    if (
      !secret ||
      typeof provided !== 'string' ||
      provided.length !== secret.length ||
      !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret))
    ) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
  });

  // POST /internal/sftp/auth — Password-based authentication
  app.post('/internal/sftp/auth', async (request) => {
    const { username, password, source_ip } = passwordAuthSchema.parse(request.body);

    const [user] = await app.db
      .select()
      .from(sftpUsers)
      .where(eq(sftpUsers.username, username));

    if (!user || !user.passwordHash) {
      return success({ allowed: false });
    }

    // Check enabled
    if (user.enabled !== 1) {
      return success({ allowed: false });
    }

    // Check expiry
    if (user.expiresAt && user.expiresAt < new Date()) {
      return success({ allowed: false });
    }

    // Check IP whitelist
    if (!isIpAllowed(source_ip, user.ipWhitelist)) {
      return success({ allowed: false });
    }

    // Verify password
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return success({ allowed: false });
    }

    const namespace = await getClientNamespace(app.db, user.clientId);

    return success({
      allowed: true,
      sftp_user_id: user.id,
      client_id: user.clientId,
      namespace,
      home_path: user.homePath,
      allow_write: user.allowWrite === 1,
      allow_delete: user.allowDelete === 1,
      max_concurrent_sessions: user.maxConcurrentSessions,
    });
  });

  // POST /internal/sftp/auth-key — Public key authentication
  app.post('/internal/sftp/auth-key', async (request) => {
    const { username, public_key_fingerprint, source_ip } = keyAuthSchema.parse(request.body);

    // Look up SFTP user to get clientId
    const [user] = await app.db
      .select()
      .from(sftpUsers)
      .where(eq(sftpUsers.username, username));

    if (!user) {
      return success({ allowed: false });
    }

    // Check enabled
    if (user.enabled !== 1) {
      return success({ allowed: false });
    }

    // Check expiry
    if (user.expiresAt && user.expiresAt < new Date()) {
      return success({ allowed: false });
    }

    // Check IP whitelist
    if (!isIpAllowed(source_ip, user.ipWhitelist)) {
      return success({ allowed: false });
    }

    // Look up SSH key by fingerprint for this client
    const [key] = await app.db
      .select()
      .from(sshKeys)
      .where(
        and(
          eq(sshKeys.clientId, user.clientId),
          eq(sshKeys.keyFingerprint, public_key_fingerprint),
        ),
      );

    if (!key) {
      return success({ allowed: false });
    }

    const namespace = await getClientNamespace(app.db, user.clientId);

    return success({
      allowed: true,
      sftp_user_id: user.id,
      client_id: user.clientId,
      namespace,
      home_path: user.homePath,
      allow_write: user.allowWrite === 1,
      allow_delete: user.allowDelete === 1,
      max_concurrent_sessions: user.maxConcurrentSessions,
    });
  });

  // POST /internal/sftp/audit — Batch insert audit events
  app.post('/internal/sftp/audit', async (request, reply) => {
    const parsed = auditBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400).send({ error: 'No events provided' });
      return;
    }
    const { events } = parsed.data;

    const rows = events.map((e) => ({
      id: crypto.randomUUID(),
      sftpUserId: e.sftp_user_id ?? null,
      clientId: e.client_id,
      event: e.event,
      sourceIp: e.source_ip,
      protocol: e.protocol ?? 'sftp',
      sessionId: e.session_id ?? null,
      durationSeconds: e.duration_seconds ?? null,
      bytesTransferred: e.bytes_transferred != null ? String(e.bytes_transferred) : null,
      errorMessage: e.error_message ?? null,
    }));

    await app.db.insert(sftpAuditLog).values(rows);
    return success({ inserted: rows.length });
  });

  // POST /internal/sftp/ensure-file-manager — Start file-manager sidecar
  app.post('/internal/sftp/ensure-file-manager', async (request, reply) => {
    const { namespace } = ensureFileManagerSchema.parse(request.body);

    // Verify namespace belongs to an actual client (prevent arbitrary namespace access)
    const [client] = await app.db
      .select({ id: clients.id })
      .from(clients)
      .where(eq(clients.kubernetesNamespace, namespace));
    if (!client) {
      return reply.status(403).send({ error: 'Unknown namespace' });
    }

    const k8s = k8sClients ?? createK8sClients(process.env.KUBECONFIG);
    const image = process.env.FILE_MANAGER_IMAGE ?? 'ghcr.io/phoenixtechnam/file-manager:latest';

    await ensureFileManagerRunning(k8s, namespace, image);
    recordFileManagerAccess(namespace);

    return success({ pod_name: `file-manager` });
  });

  // POST /internal/sftp/update-login — Record last login
  app.post('/internal/sftp/update-login', async (request) => {
    const { username, source_ip } = updateLoginSchema.parse(request.body);

    const [user] = await app.db
      .select()
      .from(sftpUsers)
      .where(eq(sftpUsers.username, username));

    if (!user) {
      return success({ updated: false });
    }

    await app.db
      .update(sftpUsers)
      .set({
        lastLoginAt: new Date(),
        lastLoginIp: source_ip,
      })
      .where(eq(sftpUsers.id, user.id));

    return success({ updated: true });
  });
}
