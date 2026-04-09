/**
 * Phase 3 of client-panel email parity round 2: typed notification
 * event helpers.
 *
 * Each helper takes a minimal payload shape, resolves the client's
 * notification recipients via getClientNotificationRecipients, and
 * fans out the pre-formatted notification. Call-sites never build
 * titles/messages by hand — they pass domain data and let the
 * helper produce consistent wording, types, and resource tags.
 *
 * Rationale: notification copy and severity levels should be owned
 * by this module so we can change them in one place. The ecosystem
 * (mailboxes service, DKIM scheduler, IMAPSync runner, email-domains
 * service) should only know about the *event*, not the presentation.
 */

import { notifyUsers } from './service.js';
import { getClientNotificationRecipients } from './recipients.js';
import type { Database } from '../../db/index.js';
import type { MailboxLimitSource } from '../mailboxes/limit.js';

// ──────────────────────────────────────────────────────────────────
// Mailbox limit reached
// ──────────────────────────────────────────────────────────────────

export interface MailboxLimitPayload {
  readonly limit: number;
  readonly current: number;
  readonly source: MailboxLimitSource;
}

/**
 * Fire when a client's create-mailbox call was rejected because the
 * plan (or per-client override) cap is full. Error level — it blocks
 * an action the client is actively trying to take.
 */
export async function notifyClientMailboxLimitReached(
  db: Database,
  clientId: string,
  payload: MailboxLimitPayload,
): Promise<void> {
  const recipients = await getClientNotificationRecipients(db, clientId);
  if (recipients.length === 0) return;

  const sourceText = payload.source === 'client_override' ? 'custom limit' : 'hosting plan';
  await notifyUsers(db, recipients, {
    type: 'error',
    title: 'Mailbox limit reached',
    message:
      `You have used ${payload.current} of ${payload.limit} mailboxes allowed by your ${sourceText}. `
      + 'New mailboxes cannot be created until you remove an existing one or upgrade your plan.',
    resourceType: 'client',
    resourceId: clientId,
  });
}

// ──────────────────────────────────────────────────────────────────
// DKIM key rotated
// ──────────────────────────────────────────────────────────────────

export interface DkimRotatedPayload {
  readonly emailDomainId: string;
  readonly domainName: string;
  readonly selector: string;
}

/**
 * Fire when the DKIM rotation scheduler rolls a new key for a
 * client's email domain. Info level — no action required from the
 * client but they should know the key material changed.
 */
export async function notifyClientDkimRotated(
  db: Database,
  clientId: string,
  payload: DkimRotatedPayload,
): Promise<void> {
  const recipients = await getClientNotificationRecipients(db, clientId);
  if (recipients.length === 0) return;

  await notifyUsers(db, recipients, {
    type: 'info',
    title: 'DKIM key rotated',
    message:
      `A new DKIM signing key (selector "${payload.selector}") was automatically generated for `
      + `${payload.domainName}. No action is required — the platform manages this for you.`,
    resourceType: 'email_domain',
    resourceId: payload.emailDomainId,
  });
}

// ──────────────────────────────────────────────────────────────────
// IMAPSync terminal state
// ──────────────────────────────────────────────────────────────────

// Note: we accept 'completed' as an alias for 'succeeded' so the
// helper remains friendly to future code / tests that use either
// wording. The IMAPSync reconciler uses 'succeeded' as the terminal
// success state.
export type ImapsyncTerminalStatus = 'succeeded' | 'completed' | 'failed' | 'cancelled';

export interface ImapsyncTerminalPayload {
  readonly jobId: string;
  readonly status: ImapsyncTerminalStatus;
  readonly messagesTransferred?: number;
  readonly errorMessage?: string;
}

function isTerminal(status: string): status is ImapsyncTerminalStatus {
  return (
    status === 'succeeded'
    || status === 'completed'
    || status === 'failed'
    || status === 'cancelled'
  );
}

/**
 * Fire when an IMAPSync migration job reaches a terminal state.
 * No-op for non-terminal statuses so the caller can blindly pipe
 * every status transition through this helper.
 */
export async function notifyClientImapsyncTerminal(
  db: Database,
  clientId: string,
  payload: ImapsyncTerminalPayload,
): Promise<void> {
  if (!isTerminal(payload.status)) return;

  const recipients = await getClientNotificationRecipients(db, clientId);
  if (recipients.length === 0) return;

  const title = (() => {
    switch (payload.status) {
      case 'succeeded':
      case 'completed':
        return 'IMAPSync migration completed';
      case 'failed':
        return 'IMAPSync migration failed';
      case 'cancelled':
        return 'IMAPSync migration cancelled';
    }
  })();

  const type: 'success' | 'error' | 'warning' = (() => {
    switch (payload.status) {
      case 'succeeded':
      case 'completed':
        return 'success';
      case 'failed':
        return 'error';
      case 'cancelled':
        return 'warning';
    }
  })();

  const message = (() => {
    if (payload.status === 'succeeded' || payload.status === 'completed') {
      const count = payload.messagesTransferred ?? 0;
      return `IMAPSync migration job finished successfully. ${count} message(s) transferred.`;
    }
    if (payload.status === 'failed') {
      return `IMAPSync migration job failed. ${payload.errorMessage ?? 'See the job details in the client panel for the error log.'}`;
    }
    return 'IMAPSync migration job was cancelled before it could finish.';
  })();

  await notifyUsers(db, recipients, {
    type,
    title,
    message,
    resourceType: 'imapsync_job',
    resourceId: payload.jobId,
  });
}

// ──────────────────────────────────────────────────────────────────
// Email bootstrap confirmation
// ──────────────────────────────────────────────────────────────────

export interface EmailBootstrappedPayload {
  readonly emailDomainId: string;
  readonly domainName: string;
}

/**
 * Fire when a client enables email on a domain for the first time.
 * Success level — confirms a client-initiated action.
 */
export async function notifyClientEmailBootstrapped(
  db: Database,
  clientId: string,
  payload: EmailBootstrappedPayload,
): Promise<void> {
  const recipients = await getClientNotificationRecipients(db, clientId);
  if (recipients.length === 0) return;

  await notifyUsers(db, recipients, {
    type: 'success',
    title: 'Email enabled for domain',
    message:
      `Email hosting is now active for ${payload.domainName}. You can create mailboxes and `
      + 'configure DNS from the client panel Mail page.',
    resourceType: 'email_domain',
    resourceId: payload.emailDomainId,
  });
}
