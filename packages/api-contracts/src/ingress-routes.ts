import { z } from 'zod';
import { uuidField } from './shared.js';

// ─── Response ───────────────────────────────────────────────────────────────

export const ingressRouteResponseSchema = z.object({
  id: uuidField,
  domainId: z.string(),
  hostname: z.string(),
  deploymentId: z.string().nullable(),
  ingressCname: z.string(),
  nodeHostname: z.string().nullable(),
  isApex: z.number(),
  tlsMode: z.enum(['auto', 'custom', 'none']),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ─── Input ──────────────────────────────────────────────────────────────────

export const createIngressRouteSchema = z.object({
  hostname: z.string().min(1).max(255),
  deployment_id: uuidField.nullable().optional(),
});

export const updateIngressRouteSchema = z.object({
  deployment_id: uuidField.nullable().optional(),
  tls_mode: z.enum(['auto', 'custom', 'none']).optional(),
  node_hostname: z.string().max(255).nullable().optional(),
});

// ─── Platform Ingress Settings ──────────────────────────────────────────────

export const ingressSettingsResponseSchema = z.object({
  ingressBaseDomain: z.string(),
  ingressDefaultIpv4: z.string(),
  ingressDefaultIpv6: z.string().nullable(),
});

export const updateIngressSettingsSchema = z.object({
  ingressBaseDomain: z.string().min(1).max(255).optional(),
  ingressDefaultIpv4: z.string().min(1).max(45).optional(),
  ingressDefaultIpv6: z.string().max(45).nullable().optional(),
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type IngressRouteResponse = z.infer<typeof ingressRouteResponseSchema>;
export type CreateIngressRouteInput = z.infer<typeof createIngressRouteSchema>;
export type UpdateIngressRouteInput = z.infer<typeof updateIngressRouteSchema>;
export type IngressSettingsResponse = z.infer<typeof ingressSettingsResponseSchema>;
export type UpdateIngressSettingsInput = z.infer<typeof updateIngressSettingsSchema>;
