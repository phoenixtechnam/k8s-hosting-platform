import { describe, it, expect } from 'vitest';
import { scanOutput } from './output-scanner.js';

describe('scanOutput', () => {
  it('passes clean HTML through unchanged', () => {
    const html = '<html><body><h1>Hello</h1></body></html>';
    const result = scanOutput(html);
    expect(result.content).toBe(html);
    expect(result.stripped).toHaveLength(0);
    expect(result.refused).toBe(false);
  });

  it('detects LLM refusal', () => {
    const result = scanOutput('REFUSED: This requires a database, which is not supported.');
    expect(result.refused).toBe(true);
    expect(result.refusalMessage).toContain('database');
    expect(result.content).toBe('');
  });

  it('strips PHP tags', () => {
    const result = scanOutput('<html><?php echo "hi"; ?></html>');
    expect(result.content).not.toContain('<?php');
    expect(result.stripped).toContain('PHP code removed');
  });

  it('strips non-allowlisted external scripts', () => {
    const html = '<script src="https://evil.com/bad.js"></script><script src="https://fonts.googleapis.com/ok.js"></script>';
    const result = scanOutput(html);
    expect(result.content).not.toContain('evil.com');
    expect(result.content).toContain('fonts.googleapis.com');
    expect(result.stripped.some((s) => s.includes('evil.com'))).toBe(true);
  });

  it('strips iframes', () => {
    const result = scanOutput('<div><iframe src="https://evil.com"></iframe></div>');
    expect(result.content).not.toContain('<iframe');
    expect(result.stripped).toContain('iframe removed');
  });

  it('strips javascript: URIs', () => {
    const result = scanOutput('<a href="javascript:alert(1)">Click</a>');
    expect(result.content).not.toContain('javascript:');
    expect(result.stripped).toContain('javascript: URI removed');
  });

  it('strips eval() calls', () => {
    const result = scanOutput('<script>eval("alert(1)")</script>');
    expect(result.content).not.toContain('eval(');
    expect(result.stripped).toContain('eval() removed');
  });

  it('strips Function() constructor', () => {
    const result = scanOutput('<script>new Function("return 1")()</script>');
    expect(result.content).not.toContain('Function(');
    expect(result.stripped).toContain('Function() removed');
  });

  it('rejects files over 150KB', () => {
    const big = 'x'.repeat(151 * 1024);
    const result = scanOutput(big);
    expect(result.refused).toBe(true);
    expect(result.refusalMessage).toContain('150KB');
  });

  it('allows Google Fonts script', () => {
    const html = '<script src="https://fonts.googleapis.com/css2?family=Inter"></script>';
    const result = scanOutput(html);
    expect(result.content).toContain('fonts.googleapis.com');
    expect(result.stripped).toHaveLength(0);
  });
});
