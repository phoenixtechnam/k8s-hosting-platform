import { describe, it, expect } from 'vitest';
import { splitSqlStatements } from './sql-splitter.js';

describe('splitSqlStatements', () => {
  it('splits simple statements', () => {
    const sql = `CREATE TABLE foo (id int); CREATE TABLE bar (id int);`;
    expect(splitSqlStatements(sql)).toEqual([
      'CREATE TABLE foo (id int)',
      'CREATE TABLE bar (id int)',
    ]);
  });

  it('ignores semicolons inside line comments', () => {
    const sql = `
-- This is a comment; it has a semicolon; and another.
CREATE TABLE foo (id int);
-- Another comment; more semicolons; more text
CREATE TABLE bar (id int);
    `;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('CREATE TABLE foo');
    expect(result[1]).toContain('CREATE TABLE bar');
  });

  it('ignores semicolons inside block comments', () => {
    const sql = `
/* Block comment; with semicolons; embedded */
CREATE TABLE foo (id int);
/* Another /* nested-looking */ comment */
CREATE TABLE bar (id int);
    `;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
  });

  it('preserves semicolons inside single-quoted string literals', () => {
    const sql = `INSERT INTO foo (name) VALUES ('hello; world');`;
    expect(splitSqlStatements(sql)).toEqual([
      `INSERT INTO foo (name) VALUES ('hello; world')`,
    ]);
  });

  it('handles escaped single quotes inside string literals', () => {
    const sql = `INSERT INTO foo (name) VALUES ('it''s; a test');`;
    expect(splitSqlStatements(sql)).toEqual([
      `INSERT INTO foo (name) VALUES ('it''s; a test')`,
    ]);
  });

  it('preserves semicolons inside double-quoted identifiers', () => {
    const sql = `SELECT "weird;column" FROM foo;`;
    expect(splitSqlStatements(sql)).toEqual([`SELECT "weird;column" FROM foo`]);
  });

  it('handles dollar-quoted blocks with embedded semicolons', () => {
    const sql = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'foo') THEN
    CREATE ROLE foo WITH LOGIN PASSWORD 'bar;baz';
  END IF;
END
$$;
    `;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('CREATE ROLE foo');
    expect(result[0]).toContain("'bar;baz'");
  });

  it('handles tagged dollar quotes ($tag$...$tag$)', () => {
    const sql = `
CREATE FUNCTION test() RETURNS void AS $body$
  SELECT 1; SELECT 2;
$body$ LANGUAGE sql;
CREATE TABLE bar (id int);
    `;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('CREATE FUNCTION');
    expect(result[0]).toContain('SELECT 1; SELECT 2');
    expect(result[1]).toContain('CREATE TABLE bar');
  });

  it('trims whitespace and drops empty statements', () => {
    const sql = `
;
CREATE TABLE foo (id int);
  ;
    ;
CREATE TABLE bar (id int);
;
    `;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
  });

  it('handles a migration file that mixes everything', () => {
    // This is the exact shape of 0004 that broke the old splitter.
    const sql = `
-- Comment; with semicolons; in it.
-- Another line; more.
CREATE SCHEMA IF NOT EXISTS stalwart;

-- Principals view
-- Stalwart 'name' query reads this; expects columns: foo, bar.
CREATE OR REPLACE VIEW stalwart.principals AS
SELECT 'a' AS name, 'b' AS type;
    `;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('CREATE SCHEMA IF NOT EXISTS stalwart');
    expect(result[1]).toContain("'a'");
  });

  it('returns empty array for empty input', () => {
    expect(splitSqlStatements('')).toEqual([]);
    expect(splitSqlStatements('   \n  ')).toEqual([]);
    expect(splitSqlStatements('-- only a comment\n')).toEqual([]);
  });

  it('handles a final statement without a trailing semicolon', () => {
    const sql = `CREATE TABLE foo (id int)`;
    expect(splitSqlStatements(sql)).toEqual(['CREATE TABLE foo (id int)']);
  });

  it('correctly splits the exact Phase 3 migration pattern with comment semicolons', () => {
    // Mimics the problematic 0009 migration that we had to replace.
    const sql = `
-- Operators can toggle per-domain; this is one way to do it.
ALTER TABLE email_domains ADD COLUMN foo int;
-- The key is; always idempotent.
CREATE INDEX IF NOT EXISTS idx_foo ON email_domains (foo);
    `;
    const result = splitSqlStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain('ALTER TABLE email_domains');
    expect(result[1]).toContain('CREATE INDEX');
  });
});
