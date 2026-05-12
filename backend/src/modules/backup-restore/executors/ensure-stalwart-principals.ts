/**
 * Ensure Stalwart principals exist for a set of mailbox addresses
 * before invoking jmap-restore.py.
 *
 * Why: jmap-restore.py uses Stalwart master-user proxy auth
 * (`<addr>%<master>`); if the target address's principal was deleted
 * in Stalwart between backup and restore, auth fails with
 * `unauthorized` and no messages can be imported.
 *
 * Recovery semantics (3 cases):
 *   1. Principal EXISTS in Stalwart → nothing to do. Common case for
 *      "I want to restore the last week's mail into my mailbox".
 *   2. Principal MISSING in Stalwart but the platform DB `mailboxes`
 *      row is intact → recreate the Stalwart principal from DB metadata
 *      with a freshly-generated secret (the user's real password
 *      lives separately in Stalwart's secret store, which the
 *      master-user proxy doesn't need anyway — operators can rotate
 *      the user-facing password via the normal flow afterwards).
 *   3. Both the Stalwart principal AND the platform DB row are gone →
 *      this means the mailbox was fully deleted at both layers.
 *      Restoring it requires recreating the DB row first via a
 *      `config-tables` cart item with the `mailboxes` table selected.
 *      We throw `MAILBOX_ROW_MISSING` with a remediation message so
 *      the operator UI can guide them.
 *
 * Why we don't auto-include the mailbox DB row in this executor:
 *   The platform DB row carries cross-tenant constraints (clientId
 *   FK, soft-delete state, lifecycle flags) that belong to the
 *   `config-tables` executor's transactional scope. Mixing concerns
 *   here would mean two executors writing to the same table without
 *   a clear ordering contract — the `config-tables` → `mailboxes-by-
 *   address` ordering in the cart is the contract.
 */

import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { mailboxes as mailboxesTable } from '../../../db/schema.js';
import { createMailbox, findMailboxByEmail, getJmapSession } from '../../stalwart-jmap/client.js';
import { ApiError } from '../../../shared/errors.js';

type EnsureOutcome =
  | { status: 'existing'; address: string }
  | { status: 'recreated'; address: string; stalwartPrincipalId: string }
  | { status: 'failed'; address: string; reason: string };

export interface EnsureStalwartPrincipalsArgs {
  app: FastifyInstance;
  addresses: readonly string[];
  /**
   * Optional override for Stalwart's HTTP base URL — useful for tests.
   * Production reads from STALWART_JMAP_URL env (set in platform-api
   * Deployment). Pass undefined to use the default resolution.
   */
  jmapBaseUrl?: string;
}

export interface EnsureStalwartPrincipalsResult {
  outcomes: ReadonlyArray<EnsureOutcome>;
  recreated: number;
}

/**
 * Generate a strong random secret for the Stalwart principal.
 * Used ONLY as a placeholder password — the operator must rotate it
 * via the normal user-facing flow before the user logs in directly.
 * The master-user proxy auth (used by jmap-restore.py and admin
 * webmail) does NOT consult this secret.
 */
function generatePrincipalSecret(): string {
  // 32 bytes → 256-bit entropy. base64url-encoded for safe Stalwart
  // ingestion (no padding chars that confuse some shell paths).
  return randomBytes(32).toString('base64url');
}

export async function ensureStalwartPrincipals(
  args: EnsureStalwartPrincipalsArgs,
): Promise<EnsureStalwartPrincipalsResult> {
  const { app, addresses, jmapBaseUrl } = args;
  const outcomes: EnsureOutcome[] = [];
  let recreated = 0;

  if (addresses.length === 0) {
    return { outcomes: [], recreated: 0 };
  }

  // 1. Resolve the principals JMAP account ID once.
  let principalsAccountId: string;
  try {
    const session = await getJmapSession(jmapBaseUrl, process.env);
    const id = session.primaryAccounts['urn:ietf:params:jmap:principals'];
    if (!id) {
      throw new ApiError(
        'STALWART_UNAVAILABLE',
        'Stalwart JMAP session has no principals account — cannot ensure mailbox principals',
        500,
      );
    }
    principalsAccountId = id;
  } catch (err) {
    // Hard failure: without JMAP access we cannot make ANY principal
    // decisions. Surface as a clear restore failure rather than
    // silently calling jmap-restore.py and watching it auth-fail per
    // address.
    throw new ApiError(
      'STALWART_UNAVAILABLE',
      `Stalwart JMAP session failed: ${err instanceof Error ? err.message : String(err)}`,
      503,
    );
  }

  // 2. Pre-fetch all platform DB rows in one query (the addresses
  //    list is at most a few hundred per cart, and the column is
  //    indexed). Saves N+1 queries.
  const dbRows = await app.db
    .select({
      id: mailboxesTable.id,
      fullAddress: mailboxesTable.fullAddress,
      stalwartPrincipalId: mailboxesTable.stalwartPrincipalId,
      displayName: mailboxesTable.displayName,
      quotaMb: mailboxesTable.quotaMb,
    })
    .from(mailboxesTable)
    .where(inArray(mailboxesTable.fullAddress, addresses as string[]));
  const dbByAddress = new Map<string, typeof dbRows[number]>();
  for (const row of dbRows) {
    dbByAddress.set(row.fullAddress.toLowerCase(), row);
  }

  // 3. For each address, decide whether to recreate.
  for (const address of addresses) {
    try {
      const existing = await findMailboxByEmail({
        accountId: principalsAccountId,
        email: address,
        baseUrl: jmapBaseUrl,
        env: process.env,
      });
      if (existing) {
        outcomes.push({ status: 'existing', address });
        continue;
      }
      // Stalwart says the principal doesn't exist. Look up DB row.
      const dbRow = dbByAddress.get(address.toLowerCase());
      if (!dbRow) {
        outcomes.push({
          status: 'failed',
          address,
          reason: 'MAILBOX_ROW_MISSING: platform DB has no row for this address either. '
            + 'Add a config-tables(mailboxes) restore item BEFORE the mailboxes-by-address '
            + 'item in this cart to recreate the DB row from the bundle, then re-run.',
        });
        continue;
      }
      // Recreate principal with random placeholder secret.
      const secret = generatePrincipalSecret();
      const created = await createMailbox({
        accountId: principalsAccountId,
        baseUrl: jmapBaseUrl,
        env: process.env,
        input: {
          type: 'individual',
          name: dbRow.fullAddress,  // Stalwart's principal `name` is the
                                    // canonical address; the displayName is
                                    // a profile attribute on Email objects.
          description: dbRow.displayName ?? undefined,
          emails: [dbRow.fullAddress],
          secrets: [secret],
          // Platform DB stores quota in MB; Stalwart's PrincipalQuota.storage
          // is bytes. Mailboxes that opted out of a quota land with
          // quotaMb=0 or NULL — leave undefined in that case so Stalwart
          // applies the tenant or global default.
          quota: dbRow.quotaMb && dbRow.quotaMb > 0
            ? { storage: dbRow.quotaMb * 1024 * 1024 }
            : undefined,
        },
      });
      if (!created.id) {
        outcomes.push({
          status: 'failed',
          address,
          reason: 'PRINCIPAL_CREATE_NO_ID: Stalwart returned no id for new principal',
        });
        continue;
      }
      // Back-fill the platform DB row's stalwartPrincipalId so the
      // next principals-sync run doesn't see the row as an orphan.
      await app.db
        .update(mailboxesTable)
        .set({ stalwartPrincipalId: created.id })
        .where(eq(mailboxesTable.id, dbRow.id));
      outcomes.push({ status: 'recreated', address, stalwartPrincipalId: created.id });
      recreated++;
      app.log.info(
        {
          module: 'ensure-stalwart-principals',
          address,
          stalwartPrincipalId: created.id,
          mailboxId: dbRow.id,
        },
        'recreated deleted Stalwart principal for restore',
      );
    } catch (err) {
      outcomes.push({
        status: 'failed',
        address,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { outcomes, recreated };
}
