import type { SmtpRelayAdapter } from './types.js';

export class DirectAdapter implements SmtpRelayAdapter {
  readonly providerType = 'direct';

  async testConnection(): Promise<{ status: 'ok' | 'error'; message?: string }> {
    return { status: 'ok', message: 'Direct delivery — no relay configured' };
  }

  getRelayConfig(): { host: string; port: number; username: string; password: string } {
    return { host: '', port: 0, username: '', password: '' };
  }
}
