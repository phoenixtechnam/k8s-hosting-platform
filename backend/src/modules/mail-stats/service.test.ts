import { describe, it, expect } from 'vitest';
import { __testing__ } from './service.js';

const { parsePrometheusText } = __testing__;

describe('parsePrometheusText', () => {
  it('parses simple metric lines', () => {
    const text = `
# HELP stalwart_messages_received_total Total messages received
# TYPE stalwart_messages_received_total counter
stalwart_messages_received_total 42
stalwart_messages_sent_total 17
    `;
    const result = parsePrometheusText(text);
    expect(result.stalwart_messages_received_total).toBe(42);
    expect(result.stalwart_messages_sent_total).toBe(17);
  });

  it('parses labelled metrics', () => {
    const text = `
stalwart_queue_size{priority="high"} 3
stalwart_queue_size{priority="normal"} 12
    `;
    const result = parsePrometheusText(text);
    expect(result['stalwart_queue_size{priority="high"}']).toBe(3);
    expect(result['stalwart_queue_size{priority="normal"}']).toBe(12);
  });

  it('ignores comment lines and blank lines', () => {
    const text = `
# HELP foo Foo metric
# TYPE foo counter

foo 1
    `;
    const result = parsePrometheusText(text);
    expect(Object.keys(result)).toEqual(['foo']);
    expect(result.foo).toBe(1);
  });

  it('handles scientific notation', () => {
    const text = `storage_bytes 1.5e9`;
    const result = parsePrometheusText(text);
    expect(result.storage_bytes).toBe(1.5e9);
  });

  it('skips non-numeric values', () => {
    const text = `
valid 42
invalid abc
    `;
    const result = parsePrometheusText(text);
    expect(result.valid).toBe(42);
    expect(result.invalid).toBeUndefined();
  });

  it('returns empty for empty input', () => {
    expect(parsePrometheusText('')).toEqual({});
  });
});
