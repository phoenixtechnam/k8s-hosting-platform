/**
 * Notification channel abstraction.
 *
 * A NotificationChannel is one delivery mechanism — e.g. in-app feed,
 * email, Slack webhook. The notification service iterates the channel
 * registry on each notifyUser call; each available channel decides
 * whether to deliver based on its own config.
 *
 * This is intentionally a minimal seam, NOT an event bus. We do not
 * support per-channel retry, queuing, or pluggable third-party
 * channels yet — those are roadmap items (see PHASE_1_ROADMAP.md
 * "Notification system phases 2-6"). Today's channels are an
 * always-on InAppChannel + an opt-in EmailChannel.
 *
 * Adding a new channel:
 *   1. Implement the interface in `channels/<name>.ts`
 *   2. Add it to the registry in `channels/registry.ts`
 *   3. Channel `isAvailable()` decides at app-init whether the channel
 *      participates (e.g. SMTP configured, webhook URL set)
 *   4. No call-site changes — `notifyUser` automatically iterates
 */

import type { Database } from '../../../db/index.js';

export type ChannelId = 'in_app' | 'email' | 'slack' | 'webhook' | 'sms';

export type NotificationType = 'info' | 'warning' | 'error' | 'success';

/**
 * The persisted notification row that triggered a delivery. Channels
 * receive this rather than the original opts so they can report
 * accurate IDs in their delivery logs and the same row can be
 * re-delivered on retry (Phase 2 roadmap item).
 */
export interface NotificationRecord {
  readonly id: string;
  readonly userId: string;
  readonly type: NotificationType;
  readonly title: string;
  readonly message: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
}

/**
 * Per-call delivery context. The notification service builds this once
 * and hands the same instance to every channel — channels MUST NOT
 * mutate it. Adding new fields here is preferable to growing the
 * channel interface signature.
 */
export interface DeliveryContext {
  readonly db: Database;
  readonly notification: NotificationRecord;
  /**
   * Decryption key for any channel-specific secret material (e.g.
   * SMTP password, webhook HMAC secret). Channels that don't need it
   * should ignore the field.
   */
  readonly encryptionKey?: string;
}

export type DeliveryResult =
  | { readonly status: 'delivered' }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'failed'; readonly error: string };

export interface NotificationChannel {
  readonly id: ChannelId;
  /**
   * Returns true when this channel can attempt delivery on the current
   * deployment (e.g. SMTP env vars set, webhook URL configured).
   * Evaluated once per registry build at app startup; channels that
   * become available at runtime require an app restart to register.
   *
   * Returning false short-circuits delivery before any per-recipient
   * work — used to skip the email channel cleanly on dev installs
   * with no SMTP relay configured.
   */
  isAvailable(): boolean;
  /**
   * Attempt to deliver the notification through this channel. MUST be
   * fire-and-forget safe — the caller wraps every invocation in a
   * promise that swallows rejections. Channels SHOULD return a typed
   * DeliveryResult so future delivery-tracking (roadmap Phase 2) can
   * record outcomes without grovelling for thrown errors.
   */
  deliver(ctx: DeliveryContext): Promise<DeliveryResult>;
}
