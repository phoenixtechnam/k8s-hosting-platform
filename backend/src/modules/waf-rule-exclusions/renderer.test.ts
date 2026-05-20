import { describe, expect, it } from 'vitest';
import type { WafRuleExclusion } from '@k8s-hosting/api-contracts';
import {
  DYNAMIC_RULE_ID_BASE,
  DYNAMIC_RULE_ID_MAX,
  renderExclusions,
  renderOneExclusion,
} from './renderer.js';

const baseExclusion: WafRuleExclusion = {
  id: '00000000-0000-0000-0000-000000000001',
  ruleId: '930120',
  hostnameRegex: '^admin\\.example\\.com$',
  scope: 'args_names_only',
  reason: 'JSON field name false-positive on secretsRestoredCount',
  createdBy: 'admin@example.com',
  createdAt: '2026-05-20T10:00:00.000Z',
  updatedAt: '2026-05-20T10:00:00.000Z',
  disabled: false,
};

describe('renderOneExclusion', () => {
  it('emits args_names_only ctl for the standard scope', () => {
    const out = renderOneExclusion(baseExclusion, 0);
    expect(out).toContain('REQUEST_HEADERS:X-Forwarded-Host');
    expect(out).toContain('@rx ^admin\\.example\\.com$');
    expect(out).toContain('ctl:ruleRemoveTargetById=930120;ARGS_NAMES');
    expect(out).toContain(`id:${DYNAMIC_RULE_ID_BASE},`);
    expect(out).not.toContain('ruleRemoveById=930120"'); // not the full-disable form
  });

  it('emits full_disable ctl when scope is full_disable', () => {
    const out = renderOneExclusion({ ...baseExclusion, scope: 'full_disable' }, 5);
    expect(out).toContain('ctl:ruleRemoveById=930120');
    expect(out).toContain(`id:${DYNAMIC_RULE_ID_BASE + 5},`);
    expect(out).not.toContain('ARGS_NAMES');
  });

  it('strips CR/LF from reason in the comment line', () => {
    const out = renderOneExclusion(
      { ...baseExclusion, reason: 'multi\nline\rreason\n' },
      0,
    );
    expect(out).not.toMatch(/^.*reason\n.*$/m);
    expect(out).toContain('multi line reason');
  });

  it('strips quotes from createdBy in the comment line', () => {
    const out = renderOneExclusion(
      { ...baseExclusion, createdBy: 'attacker"\nname' },
      0,
    );
    // The `[\r\n"]+` collapse means consecutive matching chars become one `_`.
    expect(out).toContain('by attacker_name');
  });

  it('truncates reason to 256 chars in the comment', () => {
    const out = renderOneExclusion(
      { ...baseExclusion, reason: 'a'.repeat(500) },
      0,
    );
    const commentLine = out.split('\n').find((l) => l.startsWith('# rule'));
    expect(commentLine?.length).toBeLessThanOrEqual(512);
  });

  it('hostnameRegex with double-quote is refused at render time (CRITICAL — would escape @rx string)', () => {
    expect(() => renderOneExclusion(
      { ...baseExclusion, hostnameRegex: '^evil".*' },
      0,
    )).toThrow(/unsafe hostnameRegex characters/);
  });

  it('hostnameRegex with trailing backslash is refused at render time (CRITICAL — would CrashLoopBackOff modsec-crs)', () => {
    expect(() => renderOneExclusion(
      { ...baseExclusion, hostnameRegex: 'api\\.example\\.com\\' },
      0,
    )).toThrow(/trailing backslash/);
  });

  it('legitimate escaped-dot regex renders cleanly (helper-generated form)', () => {
    // buildHostnameRegexFromEventHost produces strings like
    // `^admin\.example\.com$` — backslash escapes for `.` are allowed.
    const out = renderOneExclusion(
      { ...baseExclusion, hostnameRegex: '^admin\\.example\\.com$' },
      0,
    );
    expect(out).toContain('@rx ^admin\\.example\\.com$');
  });

  it('uses sequential rule IDs starting at DYNAMIC_RULE_ID_BASE', () => {
    expect(renderOneExclusion(baseExclusion, 0)).toContain(`id:${DYNAMIC_RULE_ID_BASE},`);
    expect(renderOneExclusion(baseExclusion, 1)).toContain(`id:${DYNAMIC_RULE_ID_BASE + 1},`);
    expect(renderOneExclusion(baseExclusion, 999)).toContain(`id:${DYNAMIC_RULE_ID_MAX},`);
  });
});

describe('renderExclusions', () => {
  it('returns the empty-body banner for zero exclusions', () => {
    const result = renderExclusions([]);
    expect(result.count).toBe(0);
    expect(result.body).toContain('No DB-rendered exclusions are currently enabled.');
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('renders multiple exclusions with sequential rule IDs', () => {
    const a = baseExclusion;
    const b: WafRuleExclusion = { ...baseExclusion, id: '00000000-0000-0000-0000-000000000002', ruleId: '931100' };
    const result = renderExclusions([a, b]);

    expect(result.count).toBe(2);
    expect(result.body).toContain(`id:${DYNAMIC_RULE_ID_BASE},`);
    expect(result.body).toContain(`id:${DYNAMIC_RULE_ID_BASE + 1},`);
    expect(result.body).toContain('930120');
    expect(result.body).toContain('931100');
  });

  it('hash changes when content changes', () => {
    const a = renderExclusions([baseExclusion]);
    const b = renderExclusions([{ ...baseExclusion, ruleId: '931100' }]);
    expect(a.hash).not.toBe(b.hash);
  });

  it('hash is stable for identical input', () => {
    const a = renderExclusions([baseExclusion]);
    const b = renderExclusions([baseExclusion]);
    expect(a.hash).toBe(b.hash);
  });

  it('hash differs from the empty body', () => {
    const a = renderExclusions([]);
    const b = renderExclusions([baseExclusion]);
    expect(a.hash).not.toBe(b.hash);
  });

  it('throws when input exceeds the reserved rule-ID range', () => {
    const tooMany = Array.from({ length: 1001 }, (_, i) => ({
      ...baseExclusion,
      id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    }));
    expect(() => renderExclusions(tooMany)).toThrow(/exceeds reserved rule-ID range/);
  });

  it('every rendered SecRule uses X-Forwarded-Host (never Host)', () => {
    const result = renderExclusions([
      baseExclusion,
      { ...baseExclusion, id: '00000000-0000-0000-0000-000000000002', ruleId: '931100' },
    ]);
    expect(result.body).toContain('REQUEST_HEADERS:X-Forwarded-Host');
    // The literal regex `REQUEST_HEADERS:Host"` (followed by a quote = end of header name)
    // would indicate the bug yesterday's CI guard catches. Make sure we never emit it.
    expect(result.body).not.toMatch(/REQUEST_HEADERS:Host[^a-zA-Z-]/);
  });
});
