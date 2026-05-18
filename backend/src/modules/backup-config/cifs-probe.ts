import net from 'node:net';
import type { TestConnectionResult } from './service.js';

export interface CifsProbeInput {
  readonly host: string;
  readonly port: number;
  /** Used only for the latency-context info — NOT actually authenticated. */
  readonly share?: string;
}

// Same 8 s budget as S3/SSH probes.
const PROBE_TIMEOUT_MS = 8_000;

/**
 * Probe a CIFS/SMB backup target by opening a TCP connection to the
 * configured host:port (default 445). Does NOT perform an SMB
 * negotiation handshake or authenticate — Node has no native SMB
 * client and shelling out to `smbclient` would require it in the
 * backend image, which is intentionally minimal.
 *
 * What this catches:
 *   - host is unreachable / DNS doesn't resolve
 *   - port 445 is firewalled (most common operator mistake — corporate
 *     networks routinely block 445 outbound)
 *   - TCP RST from a wrong-host or off service
 *
 * What this does NOT catch:
 *   - wrong username / password
 *   - missing share / wrong share name
 *   - permission issues on the share
 *
 * Full validation (auth + share access + read/write perms) is via the
 * Speedtest action, which spawns an rclone Job. Surface this caveat
 * in the success message so operators know to click Run Speedtest for
 * end-to-end confirmation.
 */
export async function probeCifs(input: CifsProbeInput): Promise<TestConnectionResult> {
  const started = Date.now();
  return new Promise<TestConnectionResult>((resolve) => {
    let settled = false;
    const socket = new net.Socket();
    const settle = (r: TestConnectionResult) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(r);
    };

    const timer = setTimeout(() => {
      settle({
        ok: false,
        latencyMs: Date.now() - started,
        error: { code: 'TIMEOUT', message: `CIFS probe timed out after ${PROBE_TIMEOUT_MS}ms` },
      });
    }, PROBE_TIMEOUT_MS);

    socket.setTimeout(PROBE_TIMEOUT_MS);

    socket.on('connect', () => {
      clearTimeout(timer);
      settle({
        ok: true,
        latencyMs: Date.now() - started,
        // Surface in the success message that this is TCP-only.
        // The TestConnectionResult shape doesn't carry a free-text
        // success field today, so this stays as a code-comment
        // contract — the admin-panel renders a static "Speedtest for
        // full validation" hint next to CIFS rows.
      });
    });

    socket.on('error', (err: Error & { code?: string }) => {
      clearTimeout(timer);
      let code = 'PROBE_FAILED';
      const msg = err.message || String(err);
      if (err.code === 'ECONNREFUSED') code = 'CONNECTION_REFUSED';
      else if (err.code === 'ENOTFOUND') code = 'DNS_NOT_FOUND';
      else if (err.code === 'ETIMEDOUT') code = 'TIMEOUT';
      else if (err.code === 'EHOSTUNREACH') code = 'HOST_UNREACHABLE';
      settle({
        ok: false,
        latencyMs: Date.now() - started,
        error: { code, message: msg },
      });
    });

    socket.on('timeout', () => {
      clearTimeout(timer);
      settle({
        ok: false,
        latencyMs: Date.now() - started,
        error: { code: 'TIMEOUT', message: `CIFS probe TCP timeout after ${PROBE_TIMEOUT_MS}ms` },
      });
    });

    socket.connect(input.port, input.host);
  });
}
