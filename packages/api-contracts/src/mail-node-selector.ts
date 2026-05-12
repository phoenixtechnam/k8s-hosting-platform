import { z } from 'zod';

/**
 * Node selector settings for the Stalwart mail server pod.
 *
 * When using CIFS BlobStore, Stalwart MUST run on the node where the
 * CIFS share is mounted (the kernel CIFS mount is per-node and exposed
 * as a hostPath volume). The platform auto-sets mode='required' when
 * switching to CIFS and reverts to 'any' when switching away.
 *
 * Operators may override to 'preferred' if they want the pod to float
 * to any node during a CIFS node outage (at the cost of blob
 * inaccessibility on the replacement node).
 *
 * PATCH /admin/mail/node-selector
 * GET  /admin/mail/node-selector
 */

export const mailNodeSelectorModeSchema = z.enum(['any', 'preferred', 'required']);
export type MailNodeSelectorMode = z.infer<typeof mailNodeSelectorModeSchema>;

export const mailNodeSelectorUpdateSchema = z.object({
  mode: mailNodeSelectorModeSchema,
  /** Specific node name to pin to. Ignored when mode='any'. */
  nodeName: z.string().min(1).max(253).nullable(),
});
export type MailNodeSelectorUpdate = z.infer<typeof mailNodeSelectorUpdateSchema>;

export const mailNodeSelectorResponseSchema = z.object({
  mode: mailNodeSelectorModeSchema,
  /** Configured node name, or null if mode='any'. */
  nodeName: z.string().nullable(),
  /** Node where the pod is currently running (live from k8s). */
  currentNode: z.string().nullable(),
});
export type MailNodeSelectorResponse = z.infer<typeof mailNodeSelectorResponseSchema>;
