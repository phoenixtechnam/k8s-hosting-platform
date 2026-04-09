import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the @kubernetes/client-node KubeConfig + https request flow.
// We test the parser/transformer logic against captured fixture data
// rather than the actual k8s API proxy round-trip.

const service = await import('./service.js');

beforeEach(() => {
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// parsePrometheusToJson — pure function
// ═══════════════════════════════════════════════════════════════════════════

describe('parsePrometheusToJson', () => {
  it('returns counter metrics with their values', () => {
    const text = `
# HELP stalwart_smtp_messages_total Total messages received
# TYPE stalwart_smtp_messages_total counter
stalwart_smtp_messages_total 1234
# HELP stalwart_imap_connections Active IMAP connections
# TYPE stalwart_imap_connections gauge
stalwart_imap_connections 7
`.trim();

    const result = service.parsePrometheusToJson(text);

    expect(result.stalwart_smtp_messages_total).toEqual({
      type: 'counter',
      help: 'Total messages received',
      value: 1234,
    });
    expect(result.stalwart_imap_connections).toEqual({
      type: 'gauge',
      help: 'Active IMAP connections',
      value: 7,
    });
  });

  it('skips comment-only lines without metrics', () => {
    const text = `
# HELP stalwart_only_help Help with no value
# TYPE stalwart_only_help counter
`.trim();
    const result = service.parsePrometheusToJson(text);
    // No value line → metric is omitted
    expect(result.stalwart_only_help).toBeUndefined();
  });

  it('handles labeled metrics by aggregating sum across all labels', () => {
    const text = `
# HELP stalwart_smtp_authentication_failures_total Auth failures
# TYPE stalwart_smtp_authentication_failures_total counter
stalwart_smtp_authentication_failures_total{listener="submission"} 3
stalwart_smtp_authentication_failures_total{listener="submissions"} 5
`.trim();

    const result = service.parsePrometheusToJson(text);
    expect(result.stalwart_smtp_authentication_failures_total).toEqual({
      type: 'counter',
      help: 'Auth failures',
      value: 8,
    });
  });

  it('handles floating-point metric values', () => {
    const text = `
# HELP stalwart_uptime_seconds Process uptime
# TYPE stalwart_uptime_seconds gauge
stalwart_uptime_seconds 12345.67
`.trim();
    const result = service.parsePrometheusToJson(text);
    expect(result.stalwart_uptime_seconds?.value).toBeCloseTo(12345.67);
  });

  it('returns an empty object for empty input', () => {
    expect(service.parsePrometheusToJson('')).toEqual({});
  });

  it('ignores metrics without a preceding TYPE line (defaults to untyped)', () => {
    const text = `
stalwart_orphan 42
`.trim();
    const result = service.parsePrometheusToJson(text);
    expect(result.stalwart_orphan).toEqual({
      type: 'untyped',
      help: '',
      value: 42,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// summarizeMailMetrics — opinionated rollup of Stalwart Prometheus output
// ═══════════════════════════════════════════════════════════════════════════

describe('summarizeMailMetrics', () => {
  it('extracts the headline counters into a flat summary', () => {
    const parsed = {
      stalwart_smtp_messages_received_total: { type: 'counter', help: '', value: 1500 },
      stalwart_smtp_messages_delivered_total: { type: 'counter', help: '', value: 1450 },
      stalwart_smtp_messages_failed_total: { type: 'counter', help: '', value: 50 },
      stalwart_imap_connections: { type: 'gauge', help: '', value: 12 },
      stalwart_queue_size: { type: 'gauge', help: '', value: 3 },
      stalwart_uptime_seconds: { type: 'gauge', help: '', value: 86400 },
    } as const;

    const summary = service.summarizeMailMetrics(parsed as never);

    expect(summary.messagesReceived).toBe(1500);
    expect(summary.messagesDelivered).toBe(1450);
    expect(summary.messagesFailed).toBe(50);
    expect(summary.imapConnections).toBe(12);
    expect(summary.queueSize).toBe(3);
    expect(summary.uptimeSeconds).toBe(86400);
  });

  it('returns 0 for missing metrics rather than throwing', () => {
    const summary = service.summarizeMailMetrics({});
    expect(summary.messagesReceived).toBe(0);
    expect(summary.messagesDelivered).toBe(0);
    expect(summary.queueSize).toBe(0);
    expect(summary.uptimeSeconds).toBe(0);
  });
});
