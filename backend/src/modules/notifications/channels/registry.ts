/**
 * Channel registry — assembled at module-load and consumed by the
 * notification service on each delivery.
 *
 * Order matters: in-app FIRST so the persisted row is always present
 * before any external channel attempts delivery. Email second because
 * users tolerate a slow email more than a slow webhook ack. Future
 * channels (Slack, webhook, SMS) append at the end.
 *
 * The exported `channels` is a `readonly` array; the implementing
 * functions are pure and side-effect-free at registry-build time
 * (channel objects are statically defined). Tests can override via
 * the `setChannelsForTesting` hook below — this is a deliberate
 * carve-out so vitest can swap in fakes without monkey-patching
 * imports.
 *
 * Why not import-time auto-discovery / decorators / dynamic plugins?
 * Three channels does not warrant a registration framework. When the
 * roadmap brings a 4th and 5th, this list grows by one line each;
 * if it ever exceeds ~10, revisit.
 */

import { inAppChannel } from './in-app.js';
import { emailChannel } from './email.js';
import type { NotificationChannel } from './types.js';

const DEFAULT_CHANNELS: ReadonlyArray<NotificationChannel> = [
  inAppChannel,
  emailChannel,
];

let activeChannels: ReadonlyArray<NotificationChannel> = DEFAULT_CHANNELS;

/**
 * Returns the list of channels that should attempt delivery for the
 * current process. Filtered to channels whose `isAvailable()` returns
 * true so callers don't need to re-check.
 */
export function getActiveChannels(): ReadonlyArray<NotificationChannel> {
  return activeChannels.filter((c) => c.isAvailable());
}

/**
 * Test-only seam for replacing the channel array. Production code
 * MUST NOT call this. Vitest helpers in service.test.ts and
 * channels/registry.test.ts swap in fakes via this hook.
 */
export function setChannelsForTesting(replacement: ReadonlyArray<NotificationChannel>): void {
  activeChannels = replacement;
}

/**
 * Restore the default channel set. Call from `afterEach` in tests
 * that mutated the registry to avoid bleed-through.
 */
export function resetChannelsForTesting(): void {
  activeChannels = DEFAULT_CHANNELS;
}
