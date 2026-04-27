/**
 * In-app notification channel — the always-on default.
 *
 * The notification row was already inserted by `createNotification`
 * before any channel runs (the in-app feed IS the persisted row),
 * so this channel is a no-op delivery: returning `delivered` simply
 * confirms the in-app feed entry is in place. Future enhancements
 * (e.g. server-sent-events push to open browser tabs) hang off here
 * without touching call-sites.
 *
 * `isAvailable()` is hardcoded to `true` because the database is
 * always present — if the DB is down, `createNotification` already
 * threw before we reach this channel.
 */

import type { NotificationChannel, DeliveryContext, DeliveryResult } from './types.js';

export const inAppChannel: NotificationChannel = {
  id: 'in_app',
  isAvailable(): boolean {
    return true;
  },
  async deliver(_ctx: DeliveryContext): Promise<DeliveryResult> {
    return { status: 'delivered' };
  },
};
