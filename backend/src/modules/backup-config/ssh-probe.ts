import { Client as SshClient } from 'ssh2';
import type { TestConnectionResult } from './service.js';

export interface SshProbeInput {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** PEM private key body — either this OR password must be set. */
  readonly privateKey?: string;
  /** Plaintext password — either this OR privateKey must be set. */
  readonly password?: string;
}

// Tight budget — the operator clicked "Test Connection" and is staring
// at the UI. Match the S3 probe's 8 s. ssh2's `readyTimeout` covers the
// auth handshake; we layer a wall-clock timeout on top so a SYN-ACK
// hang doesn't bypass it.
const PROBE_TIMEOUT_MS = 8_000;

/**
 * Probe an SFTP backup target by completing the SSH transport + auth
 * handshake against the configured host. Does NOT exec anything or
 * touch the remote filesystem — auth-only, so it's safe on locked-
 * down accounts (rrsync, chroot-only sftp users) and finishes in
 * 100-500 ms typically.
 *
 * Returns an error code that maps to the admin-panel's classifier:
 *   - INCOMPLETE_CONFIG  — caller fed a config missing host/user/auth
 *   - CONNECTION_REFUSED — TCP RST or unreachable host:port
 *   - TIMEOUT            — neither connect nor auth completed in budget
 *   - AUTH_FAILED        — credentials rejected (most common operator error)
 *   - HOST_KEY_MISMATCH  — server identity changed (TOFU policy issue)
 *   - PROBE_FAILED       — anything else (e.g. protocol-level error)
 */
export async function probeSsh(input: SshProbeInput): Promise<TestConnectionResult> {
  if (!input.privateKey && !input.password) {
    return {
      ok: false,
      latencyMs: 0,
      error: { code: 'INCOMPLETE_CONFIG', message: 'SSH probe requires privateKey or password' },
    };
  }

  const started = Date.now();
  const client = new SshClient();

  return new Promise<TestConnectionResult>((resolve) => {
    let settled = false;
    const settle = (r: TestConnectionResult) => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch { /* ignore */ }
      resolve(r);
    };

    // Wall-clock timeout on top of ssh2's readyTimeout. Some failure
    // modes (TCP RST from a firewall before SYN-ACK) settle quickly
    // via 'error'; others (silent drop after SYN-ACK) only surface
    // through ssh2's internal timer.
    const timer = setTimeout(() => {
      settle({
        ok: false,
        latencyMs: Date.now() - started,
        error: { code: 'TIMEOUT', message: `SSH probe timed out after ${PROBE_TIMEOUT_MS}ms` },
      });
    }, PROBE_TIMEOUT_MS);

    client.on('ready', () => {
      clearTimeout(timer);
      settle({ ok: true, latencyMs: Date.now() - started });
    });

    client.on('error', (err: Error & { code?: string; level?: string }) => {
      clearTimeout(timer);
      // ssh2 surfaces the connection-vs-auth distinction via the
      // `level` field on its error objects.
      let code = 'PROBE_FAILED';
      const msg = err.message || String(err);
      if (err.level === 'client-authentication' || /authentication/i.test(msg)) {
        code = 'AUTH_FAILED';
      } else if (err.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) {
        code = 'CONNECTION_REFUSED';
      } else if (err.code === 'ENOTFOUND' || /ENOTFOUND/.test(msg)) {
        code = 'DNS_NOT_FOUND';
      } else if (err.code === 'ETIMEDOUT' || /timed.out/i.test(msg)) {
        code = 'TIMEOUT';
      } else if (/host[\s-]?key/i.test(msg)) {
        code = 'HOST_KEY_MISMATCH';
      }
      settle({
        ok: false,
        latencyMs: Date.now() - started,
        error: { code, message: msg },
      });
    });

    try {
      client.connect({
        host: input.host,
        port: input.port,
        username: input.user,
        // TOFU: don't validate host key. Matches the streaming Job's
        // RCLONE_CONFIG_REMOTE_KNOWN_HOSTS_FILE='' policy.
        hostHash: undefined,
        algorithms: {
          // Prefer the AES-NI HW-accelerated cipher (same as streaming
          // Job's RCLONE_CONFIG_REMOTE_CIPHERS). ssh2's defaults include
          // legacy ciphers that some hardened servers refuse, so being
          // explicit here also widens compatibility.
          cipher: ['aes128-gcm@openssh.com', 'aes256-gcm@openssh.com', 'aes128-ctr', 'aes256-ctr'],
        },
        readyTimeout: PROBE_TIMEOUT_MS - 200,
        // EITHER privateKey OR password — at least one is set per the
        // guard at the top of this function.
        privateKey: input.privateKey,
        password: input.password,
      });
    } catch (err) {
      // Synchronous throw from ssh2.connect (rare — usually for malformed
      // private keys). Surface as a probe failure rather than crashing.
      clearTimeout(timer);
      settle({
        ok: false,
        latencyMs: Date.now() - started,
        error: {
          code: 'PROBE_FAILED',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });
}
