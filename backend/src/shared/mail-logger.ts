/**
 * Shared structured logger for the mail modules.
 *
 * Why this exists: the Stalwart-JMAP modules (client, principals-sync,
 * dns-sync, mail-admin, mailboxes, email-domains) historically logged
 * via `console.*`, which bypasses pino's JSON formatter, structured
 * fields, log-level filtering, and any log shipping the operator has
 * configured. They couldn't easily take an `app.log` parameter because
 * the schedulers start during the Fastify boot sequence — before the
 * app is fully constructed.
 *
 * This module exports a process-wide pino instance configured to match
 * Fastify's defaults. It's safe to import from anywhere in the
 * `backend/src` tree because it only depends on pino + LOG_LEVEL env.
 *
 * Test isolation: in unit tests, set LOG_LEVEL=silent to suppress all
 * output. The module re-reads LOG_LEVEL at first import only, so
 * vi.stubEnv('LOG_LEVEL', 'silent') must run BEFORE any module that
 * imports mailLogger.
 */

import pino, { type Logger } from 'pino';

let _instance: Logger | null = null;

/**
 * Get the process-wide structured logger for mail modules.
 *
 * Lazy-initialised so unit tests can stub LOG_LEVEL before first use.
 */
export function mailLogger(): Logger {
  if (_instance !== null) return _instance;
  _instance = pino({
    name: 'mail',
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
  return _instance;
}
