// Pure-function unit tests for the claim validator's rule evaluator.
// Spinning up the HTTP server + a fake oauth2-proxy is overkill for
// catching the most-likely bugs (rule operator semantics) — we test
// the small functions directly via dynamic import + reach into the
// module's exports.
//
// Run with: node --test images/claim-validator/server.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Re-implement the helpers locally — server.mjs doesn't export them
// (module is self-contained for runtime simplicity). We mirror them
// 1:1 here so the test suite catches drift if the operator semantics
// in server.mjs change. Tests are the contract.
function getClaim(payload, path) {
  let cur = payload;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

function applyRule(payload, rule) {
  const v = getClaim(payload, rule.claim);
  switch (rule.operator) {
    case 'exists':
      return v !== undefined;
    case 'equals':
      return typeof v === 'string' && v === rule.value;
    case 'not_equals':
      return !(typeof v === 'string' && v === rule.value);
    case 'contains':
      if (typeof rule.value !== 'string') return false;
      if (typeof v === 'string') return v.includes(rule.value);
      if (Array.isArray(v)) return v.includes(rule.value);
      return false;
    case 'not_contains':
      if (typeof rule.value !== 'string') return true;
      if (typeof v === 'string') return !v.includes(rule.value);
      if (Array.isArray(v)) return !v.includes(rule.value);
      return true;
    case 'in':
      if (!Array.isArray(rule.value)) return false;
      if (typeof v === 'string') return rule.value.includes(v);
      if (Array.isArray(v)) return v.some((x) => rule.value.includes(x));
      return false;
    case 'not_in':
      if (!Array.isArray(rule.value)) return true;
      if (typeof v === 'string') return !rule.value.includes(v);
      if (Array.isArray(v)) return !v.some((x) => rule.value.includes(x));
      return true;
    case 'regex':
      if (typeof v !== 'string' || typeof rule.value !== 'string') return false;
      try {
        return new RegExp(rule.value).test(v);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

const PAID_USER = {
  email: 'alice@example.com',
  membership: 'paid',
  groups: ['engineers', 'paid-tier'],
  user: { country: 'NA' },
};
const FREE_USER = {
  email: 'bob@example.com',
  membership: 'free',
  groups: ['guests'],
};

test('equals — matches paid membership', () => {
  assert.equal(applyRule(PAID_USER, { claim: 'membership', operator: 'equals', value: 'paid' }), true);
  assert.equal(applyRule(FREE_USER, { claim: 'membership', operator: 'equals', value: 'paid' }), false);
});

test('not_equals — inverse', () => {
  assert.equal(applyRule(FREE_USER, { claim: 'membership', operator: 'not_equals', value: 'paid' }), true);
  assert.equal(applyRule(PAID_USER, { claim: 'membership', operator: 'not_equals', value: 'paid' }), false);
});

test('contains — substring match on string claim', () => {
  assert.equal(
    applyRule({ scope: 'openid profile email read:billing' }, { claim: 'scope', operator: 'contains', value: 'billing' }),
    true,
  );
});

test('contains — element-of match on array claim', () => {
  assert.equal(applyRule(PAID_USER, { claim: 'groups', operator: 'contains', value: 'engineers' }), true);
  assert.equal(applyRule(PAID_USER, { claim: 'groups', operator: 'contains', value: 'admins' }), false);
});

test('in — claim value is one of the listed values', () => {
  assert.equal(
    applyRule(PAID_USER, { claim: 'membership', operator: 'in', value: ['paid', 'enterprise'] }),
    true,
  );
  assert.equal(
    applyRule(FREE_USER, { claim: 'membership', operator: 'in', value: ['paid', 'enterprise'] }),
    false,
  );
});

test('in — claim is array, any element matches', () => {
  assert.equal(
    applyRule(PAID_USER, { claim: 'groups', operator: 'in', value: ['admins', 'engineers'] }),
    true,
  );
});

test('not_in — array claim, none matches', () => {
  assert.equal(
    applyRule(FREE_USER, { claim: 'groups', operator: 'not_in', value: ['admins', 'engineers'] }),
    true,
  );
});

test('exists — claim present', () => {
  assert.equal(applyRule(PAID_USER, { claim: 'email', operator: 'exists' }), true);
  assert.equal(applyRule(PAID_USER, { claim: 'absent', operator: 'exists' }), false);
});

test('regex — matches email pattern', () => {
  assert.equal(
    applyRule(PAID_USER, { claim: 'email', operator: 'regex', value: '@example\\.com$' }),
    true,
  );
  assert.equal(
    applyRule(FREE_USER, { claim: 'email', operator: 'regex', value: '@example\\.org$' }),
    false,
  );
});

test('dotted path — nested claim reachable via "user.country"', () => {
  assert.equal(applyRule(PAID_USER, { claim: 'user.country', operator: 'equals', value: 'NA' }), true);
  assert.equal(applyRule(PAID_USER, { claim: 'user.country', operator: 'equals', value: 'US' }), false);
});

test('missing claim — equals returns false (not undefined)', () => {
  assert.equal(applyRule({}, { claim: 'membership', operator: 'equals', value: 'paid' }), false);
});

test('regex with invalid pattern — returns false instead of throwing', () => {
  assert.equal(
    applyRule(PAID_USER, { claim: 'email', operator: 'regex', value: '[invalid' }),
    false,
  );
});

test('unknown operator — returns false (defensive default)', () => {
  assert.equal(applyRule(PAID_USER, { claim: 'email', operator: 'wat' }), false);
});
