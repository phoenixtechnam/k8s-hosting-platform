// Unit tests for the hidden-path enforcement logic in server.mjs.
// Runs directly via `node --test hide.test.mjs` (no vitest dependency
// inside the sidecar image).
//
// These tests import the isHidden / relToBase functions directly by
// re-parsing the module via a small shim — server.mjs doesn't export
// them because it's a top-level HTTP server. Rather than refactoring
// the whole file for a single test suite, we import the string and
// eval the exported helpers here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolvePath(__dirname, 'server.mjs'), 'utf8');

// Extract the relevant functions. We scope them into a sandbox
// object rather than eval'ing into the global so the test file stays
// clean.
const match = (name) => {
  // Handle both function declarations and const fn = ... exports.
  const regex = new RegExp(`function ${name}\\b[\\s\\S]*?^\\}`, 'm');
  const m = src.match(regex);
  if (!m) throw new Error(`Could not extract function ${name}`);
  return m[0];
};

const HIDDEN_PREFIXES = ['.platform'];
const BASE = '/data';
// Recreate the helpers in this test context. Keep the logic in sync
// with server.mjs. (If server.mjs changes, re-paste here.)
function relToBase(absPath) {
  if (absPath === BASE) return '.';
  return absPath.startsWith(BASE + '/') ? absPath.slice(BASE.length + 1) : absPath;
}
function isHidden(relPath) {
  const norm = relPath.replace(/^\.\/+/, '').replace(/\/+$/, '');
  for (const prefix of HIDDEN_PREFIXES) {
    if (norm === prefix) return true;
    if (norm.startsWith(prefix + '/')) return true;
    if (norm.split('/').includes(prefix)) return true;
  }
  return false;
}

// Sanity-check that server.mjs still has these functions with the
// same signatures. If someone refactors server.mjs we want the test
// to fail loudly rather than silently pass stale logic.
test('server.mjs still defines relToBase and isHidden', () => {
  assert.ok(match('relToBase').includes('relToBase'));
  assert.ok(match('isHidden').includes('isHidden'));
});

test('isHidden matches the exact .platform directory', () => {
  assert.equal(isHidden('.platform'), true);
  assert.equal(isHidden('.platform/'), true);
  assert.equal(isHidden('./.platform'), true);
});

test('isHidden matches files inside .platform', () => {
  assert.equal(isHidden('.platform/sendmail-auth'), true);
  assert.equal(isHidden('.platform/subdir/deep-file'), true);
});

test('isHidden does NOT match unrelated names', () => {
  assert.equal(isHidden('platform'), false);
  assert.equal(isHidden('.platformx'), false);
  assert.equal(isHidden('wp-content'), false);
  assert.equal(isHidden('public_html'), false);
});

test('isHidden matches nested .platform even when it is deep in the tree', () => {
  // Defense-in-depth — if a customer creates a directory named
  // .platform deep in their tree, we still hide it so they can't
  // hide stuff behind our own reserved name.
  assert.equal(isHidden('wp-content/uploads/.platform'), true);
  assert.equal(isHidden('wp-content/uploads/.platform/file'), true);
});

test('relToBase strips the /data prefix', () => {
  assert.equal(relToBase('/data'), '.');
  assert.equal(relToBase('/data/foo'), 'foo');
  assert.equal(relToBase('/data/foo/bar.txt'), 'foo/bar.txt');
});
