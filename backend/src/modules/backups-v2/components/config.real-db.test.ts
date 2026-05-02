/**
 * Real-DB integration test for buildConfigDump.
 *
 * Why this file exists:
 *   The unit tests in `config.test.ts` mock `db.execute` and assert
 *   on the SQL skeleton. That kind of test passes happily when the
 *   skeleton itself references columns that don't exist in the real
 *   schema — exactly how the `clients.user_id` and
 *   `ingress_auth_configs.client_id` schema-mismatch bugs slipped
 *   through Phase 2 review and only surfaced after a 25-min staging
 *   round-trip.
 *
 *   This test boots an in-memory Postgres (`pg-mem`), creates the
 *   minimum tables that buildConfigDump touches, seeds one row per
 *   CONFIG_DUMP_TABLES entry against a fixture client, and runs the
 *   real buildConfigDump function. If a SELECT references a missing
 *   column it FAILS HERE instead of in production.
 *
 *   It is intentionally schema-narrow — we don't attempt to mirror
 *   every column of every table. Each minimal table has just enough
 *   columns for the relevant FK + a sentinel value the assertion
 *   verifies.
 *
 * Coverage growth pattern:
 *   Phase 3 will add real-DB tests next to this file for the
 *   mailbox + files components in their own *.real-db.test.ts files.
 *   Each phase that adds tables to CONFIG_DUMP_TABLES MUST also add
 *   a seed row here so this test continues to assert non-zero rows
 *   for every table.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { newDb, type IMemoryDb } from 'pg-mem';
import { CONFIG_DUMP_TABLES, buildConfigDump } from './config.js';
import type { Database } from '../../../db/index.js';

/**
 * Minimal Database adapter that translates Drizzle's `sql` template
 * (queryChunks: [stringChunk, paramValue, stringChunk, …]) into a
 * positional Postgres query and runs it via pg-mem. This bypasses
 * Drizzle's node-postgres driver which depends on a pg `Pool` shape
 * pg-mem doesn't fully implement.
 *
 * This adapter only satisfies the surface buildConfigDump uses
 * (`db.execute(sql\`...\`)` returning `{ rows }`). It is NOT a
 * drop-in replacement for the full Drizzle Database type.
 */
function pgMemDatabase(mem: IMemoryDb): Database {
  // Use pg-mem's node-postgres-compatible Pool directly. The Pool's
  // `.query(text, params)` interface is the original libpq shape;
  // Drizzle's Database type is structurally compatible with the
  // subset (`execute`) we need here.
  const adapter = mem.adapters.createPg() as unknown as { Pool: new () => { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } };
  const pool = new adapter.Pool();
  return {
    execute: async (q: { queryChunks: unknown[] }) => {
      let text = '';
      const params: unknown[] = [];
      for (const chunk of q.queryChunks) {
        if (chunk && typeof chunk === 'object' && 'value' in chunk
            && Array.isArray((chunk as { value: unknown }).value)) {
          // String fragment from drizzle's sql template.
          const v = (chunk as { value: unknown[] }).value;
          if (typeof v[0] !== 'string') {
            // Defence against pg-mem-eats-array-param scenarios: the
            // first element of a string-fragment is ALWAYS a string.
            // If we see something else, the chunk-classification
            // logic is wrong — fail loud rather than emit a malformed
            // query that pg-mem may silently accept.
            throw new Error(`pgMemDatabase: expected string fragment, got ${typeof v[0]} (${JSON.stringify(v).slice(0, 60)})`);
          }
          text += v[0];
        } else {
          // Bound parameter — drizzle wraps in Param, sometimes raw.
          const value = (chunk && typeof chunk === 'object' && 'value' in chunk)
            ? (chunk as { value: unknown }).value
            : chunk;
          params.push(value);
          text += `$${params.length}`;
        }
      }
      const r = await pool.query(text, params);
      return { rows: r.rows };
    },
  } as unknown as Database;
}

const FIXTURE_CLIENT_ID = '4ec7436d-6159-4bf0-9282-d7e4cc19410b';
const FIXTURE_OTHER_CLIENT_ID = '00000000-0000-0000-0000-000000000099';

/**
 * Boot an in-memory Postgres + create the minimal schema buildConfigDump
 * touches. Does NOT use Drizzle migrations because pg-mem doesn't speak
 * every Drizzle DDL feature — we hand-roll just enough.
 */
function makeFixtureDb(): Database {
  const mem = newDb();
  mem.public.none(`
    CREATE TABLE clients (
      id            VARCHAR(36) PRIMARY KEY,
      company_name  VARCHAR(255) NOT NULL,
      kubernetes_namespace VARCHAR(63) NOT NULL
    );
    CREATE TABLE users (
      id         VARCHAR(36) PRIMARY KEY,
      email      VARCHAR(255) NOT NULL,
      client_id  VARCHAR(36) REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE domains (
      id         VARCHAR(36) PRIMARY KEY,
      hostname   VARCHAR(255) NOT NULL,
      client_id  VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE email_domains (
      id         VARCHAR(36) PRIMARY KEY,
      domain     VARCHAR(255) NOT NULL,
      client_id  VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE mailboxes (
      id              VARCHAR(36) PRIMARY KEY,
      address         VARCHAR(255) NOT NULL,
      email_domain_id VARCHAR(36) NOT NULL REFERENCES email_domains(id),
      client_id       VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE email_aliases (
      id              VARCHAR(36) PRIMARY KEY,
      from_addr       VARCHAR(255) NOT NULL,
      to_addr         VARCHAR(255) NOT NULL,
      email_domain_id VARCHAR(36) NOT NULL REFERENCES email_domains(id),
      client_id       VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE mail_submit_credentials (
      id        VARCHAR(36) PRIMARY KEY,
      username  VARCHAR(255) NOT NULL,
      client_id VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE ssh_keys (
      id        VARCHAR(36) PRIMARY KEY,
      label     VARCHAR(255) NOT NULL,
      client_id VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE sftp_users (
      id        VARCHAR(36) PRIMARY KEY,
      username  VARCHAR(255) NOT NULL,
      client_id VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE deployments (
      id        VARCHAR(36) PRIMARY KEY,
      name      VARCHAR(255) NOT NULL,
      client_id VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE ingress_routes (
      id        VARCHAR(36) PRIMARY KEY,
      hostname  VARCHAR(255) NOT NULL,
      domain_id VARCHAR(36) NOT NULL REFERENCES domains(id)
    );
    CREATE TABLE ingress_auth_configs (
      id                VARCHAR(36) PRIMARY KEY,
      ingress_route_id  VARCHAR(36) NOT NULL REFERENCES ingress_routes(id),
      enabled           BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE ssl_certificates (
      id        VARCHAR(36) PRIMARY KEY,
      domain    VARCHAR(255) NOT NULL,
      client_id VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE cron_jobs (
      id        VARCHAR(36) PRIMARY KEY,
      name      VARCHAR(255) NOT NULL,
      client_id VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE resource_quotas (
      id        VARCHAR(36) PRIMARY KEY,
      cpu       VARCHAR(50) NOT NULL,
      client_id VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE client_oidc_providers (
      id        VARCHAR(36) PRIMARY KEY,
      issuer    VARCHAR(500) NOT NULL,
      client_id VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE client_mtls_providers (
      id        VARCHAR(36) PRIMARY KEY,
      ca_cert   TEXT NOT NULL,
      client_id VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE client_ziti_providers (
      id        VARCHAR(36) PRIMARY KEY,
      controller_url VARCHAR(500) NOT NULL,
      client_id VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE
    );
    CREATE TABLE client_zrok_accounts (
      id        VARCHAR(36) PRIMARY KEY,
      account   VARCHAR(255) NOT NULL,
      client_id VARCHAR(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE
    );
  `);
  // Seed the fixture client + one row per dump table — one belonging
  // to the fixture client (assertion target), one to a different
  // client (negative-control: must NOT appear in the dump).
  mem.public.none(`
    INSERT INTO clients(id, company_name, kubernetes_namespace) VALUES
      ('${FIXTURE_CLIENT_ID}', 'Fixture Co', 'client-fixture'),
      ('${FIXTURE_OTHER_CLIENT_ID}', 'Other Co', 'client-other');

    INSERT INTO users(id, email, client_id) VALUES
      ('u1', 'owner@fixture.test', '${FIXTURE_CLIENT_ID}'),
      ('u2', 'sub@fixture.test',   '${FIXTURE_CLIENT_ID}'),
      ('u3', 'other@other.test',   '${FIXTURE_OTHER_CLIENT_ID}');

    INSERT INTO domains(id, hostname, client_id) VALUES
      ('d-fix',   'fixture.test', '${FIXTURE_CLIENT_ID}'),
      ('d-other', 'other.test',   '${FIXTURE_OTHER_CLIENT_ID}');

    INSERT INTO email_domains(id, domain, client_id) VALUES
      ('ed-fix',   'mail.fixture.test', '${FIXTURE_CLIENT_ID}'),
      ('ed-other', 'mail.other.test',   '${FIXTURE_OTHER_CLIENT_ID}');

    INSERT INTO mailboxes(id, address, email_domain_id, client_id) VALUES
      ('mb-fix',   'a@mail.fixture.test', 'ed-fix',   '${FIXTURE_CLIENT_ID}'),
      ('mb-other', 'a@mail.other.test',   'ed-other', '${FIXTURE_OTHER_CLIENT_ID}');
    INSERT INTO email_aliases(id, from_addr, to_addr, email_domain_id, client_id) VALUES
      ('ea-fix',   'al@mail.fixture.test', 'a@mail.fixture.test', 'ed-fix',   '${FIXTURE_CLIENT_ID}'),
      ('ea-other', 'al@mail.other.test',   'a@mail.other.test',   'ed-other', '${FIXTURE_OTHER_CLIENT_ID}');
    INSERT INTO mail_submit_credentials(id, username, client_id) VALUES
      ('msc-fix',   'submit@fixture.test', '${FIXTURE_CLIENT_ID}'),
      ('msc-other', 'submit@other.test',   '${FIXTURE_OTHER_CLIENT_ID}');
    INSERT INTO ssh_keys(id, label, client_id) VALUES
      ('sk-fix',   'workstation',  '${FIXTURE_CLIENT_ID}'),
      ('sk-other', 'other-laptop', '${FIXTURE_OTHER_CLIENT_ID}');
    INSERT INTO sftp_users(id, username, client_id) VALUES
      ('sftp-fix',   'fixture', '${FIXTURE_CLIENT_ID}'),
      ('sftp-other', 'other',   '${FIXTURE_OTHER_CLIENT_ID}');
    INSERT INTO deployments(id, name, client_id) VALUES
      ('depl-fix',   'wp',     '${FIXTURE_CLIENT_ID}'),
      ('depl-other', 'static', '${FIXTURE_OTHER_CLIENT_ID}');
    INSERT INTO ingress_routes(id, hostname, domain_id) VALUES
      ('ir-fix',   'fixture.test', 'd-fix'),
      ('ir-other', 'other.test',   'd-other');
    INSERT INTO ingress_auth_configs(id, ingress_route_id, enabled) VALUES
      ('iac-fix',   'ir-fix',   TRUE),
      ('iac-other', 'ir-other', FALSE);
    INSERT INTO ssl_certificates(id, domain, client_id) VALUES
      ('cert-fix',   'fixture.test', '${FIXTURE_CLIENT_ID}'),
      ('cert-other', 'other.test',   '${FIXTURE_OTHER_CLIENT_ID}');
    INSERT INTO cron_jobs(id, name, client_id) VALUES
      ('cj-fix',   'daily',  '${FIXTURE_CLIENT_ID}'),
      ('cj-other', 'hourly', '${FIXTURE_OTHER_CLIENT_ID}');
    INSERT INTO resource_quotas(id, cpu, client_id) VALUES
      ('rq-fix',   '1', '${FIXTURE_CLIENT_ID}'),
      ('rq-other', '2', '${FIXTURE_OTHER_CLIENT_ID}');
    INSERT INTO client_oidc_providers(id, issuer, client_id) VALUES
      ('coidc-fix',   'https://idp.fixture.test', '${FIXTURE_CLIENT_ID}'),
      ('coidc-other', 'https://idp.other.test',   '${FIXTURE_OTHER_CLIENT_ID}');
    INSERT INTO client_mtls_providers(id, ca_cert, client_id) VALUES
      ('cmtls-fix',   '-----BEGIN CERTIFICATE-----', '${FIXTURE_CLIENT_ID}'),
      ('cmtls-other', '-----BEGIN CERT-OTHER-----',  '${FIXTURE_OTHER_CLIENT_ID}');
    INSERT INTO client_ziti_providers(id, controller_url, client_id) VALUES
      ('cziti-fix',   'https://ziti.fixture.test', '${FIXTURE_CLIENT_ID}'),
      ('cziti-other', 'https://ziti.other.test',   '${FIXTURE_OTHER_CLIENT_ID}');
    INSERT INTO client_zrok_accounts(id, account, client_id) VALUES
      ('czrok-fix',   'fixture-zrok', '${FIXTURE_CLIENT_ID}'),
      ('czrok-other', 'other-zrok',   '${FIXTURE_OTHER_CLIENT_ID}');
  `);

  return pgMemDatabase(mem);
}

describe('buildConfigDump (real-DB)', () => {
  let db: Database;

  beforeEach(() => {
    db = makeFixtureDb();
  });

  it('every CONFIG_DUMP_TABLES entry returns rows for the fixture client', async () => {
    const dump = await buildConfigDump(db, FIXTURE_CLIENT_ID);
    // One row per table (or two for users — owner + sub-user). The
    // assertion that matters: every declared table is non-empty in
    // the fixture, which means the SELECT executed successfully.
    for (const t of CONFIG_DUMP_TABLES) {
      const rows = dump.tables[t];
      expect(rows, `table ${t} in CONFIG_DUMP_TABLES must return rows for the fixture client`)
        .toBeDefined();
      expect(Array.isArray(rows), `table ${t} must be an array`).toBe(true);
      expect((rows as unknown[]).length,
        `table ${t} returned 0 rows — the SELECT either failed or excluded the fixture client. ` +
        `Check selectClientRows() in config.ts.`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('users dump returns owner + sub-user (2 rows) for the fixture client only', async () => {
    const dump = await buildConfigDump(db, FIXTURE_CLIENT_ID);
    const users = dump.tables.users as Array<{ email: string; client_id: string }>;
    expect(users).toHaveLength(2);
    expect(new Set(users.map((u) => u.email))).toEqual(new Set(['owner@fixture.test', 'sub@fixture.test']));
    expect(users.every((u) => u.client_id === FIXTURE_CLIENT_ID)).toBe(true);
  });

  it('ingress_auth_configs joins through ingress_routes → domains correctly', async () => {
    const dump = await buildConfigDump(db, FIXTURE_CLIENT_ID);
    const iac = dump.tables.ingressAuthConfigs as Array<{ id: string }>;
    // Only the fixture's iac (`iac-fix`) — not the other client's (`iac-other`).
    expect(iac).toHaveLength(1);
    expect(iac[0]?.id).toBe('iac-fix');
  });

  it('schemaVersion + clientId + exportedAt are populated', async () => {
    const dump = await buildConfigDump(db, FIXTURE_CLIENT_ID);
    expect(dump.schemaVersion).toBe(1);
    expect(dump.clientId).toBe(FIXTURE_CLIENT_ID);
    expect(typeof dump.exportedAt).toBe('string');
    // Must be ISO string parseable.
    expect(() => new Date(dump.exportedAt).toISOString()).not.toThrow();
  });

  it('does not return rows belonging to a different client (cross-tenant safety)', async () => {
    const dump = await buildConfigDump(db, FIXTURE_CLIENT_ID);
    // Every dump table now has at least one OTHER_CLIENT_ID row in
    // the fixture. Assert the dump never includes any of them.
    for (const t of CONFIG_DUMP_TABLES) {
      const rows = dump.tables[t] as Array<Record<string, unknown>>;
      // For each row, every value must NOT include the other-client
      // id either as a `client_id` field OR as an embedded
      // identifier (covers the iac case where the row has no direct
      // client_id but is owned via the join chain).
      for (const r of rows) {
        // Direct client_id mismatch — most tables.
        if ('client_id' in r) {
          expect(r.client_id, `${t} row leaked from other client`).toBe(FIXTURE_CLIENT_ID);
        }
        // Cross-join-owned tables (ingressAuthConfigs) — assert id
        // doesn't end with `-other`, the convention used in the fixture.
        const id = (r as { id?: unknown }).id;
        if (typeof id === 'string') {
          expect(id.endsWith('-other'), `${t} row id ${id} leaked from other client`).toBe(false);
        }
      }
    }
    // Spot-check the count for join-owned tables which the loop's
    // direct field check can't catch.
    const iac = dump.tables.ingressAuthConfigs as Array<{ id: string }>;
    expect(iac).toHaveLength(1);
    expect(iac[0]?.id).toBe('iac-fix');
  });

  // Sanity: a query that references a non-existent column should fail
  // here, not in production. This test documents the contract — if the
  // suite is green, every CONFIG_DUMP_TABLES SELECT executed without
  // a SQL error against a real Postgres-compatible engine.
  it('every SELECT in CONFIG_DUMP_TABLES executes without SQL error', async () => {
    // The previous tests already cover this implicitly (any failure
    // throws), but we re-iterate here so a developer adding a new
    // entry sees the most direct assertion: just running buildConfigDump
    // is the contract.
    await expect(buildConfigDump(db, FIXTURE_CLIENT_ID)).resolves.toBeDefined();
  });

});
