import type { SmtpRelayAdapter } from './types.js';

interface MailgunConfig {
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly authUsername: string;
  readonly authPassword: string;
}

export class MailgunAdapter implements SmtpRelayAdapter {
  readonly providerType = 'mailgun';
  private readonly config: MailgunConfig;

  constructor(config: MailgunConfig) {
    this.config = config;
  }

  async testConnection(): Promise<{ status: 'ok' | 'error'; message?: string }> {
    if (!this.config.smtpHost || !this.config.authUsername || !this.config.authPassword) {
      return { status: 'error', message: 'Incomplete Mailgun configuration: host, username, and password are required' };
    }

    const validHosts = ['smtp.mailgun.org', 'smtp.eu.mailgun.org'];
    if (!validHosts.includes(this.config.smtpHost)) {
      return { status: 'error', message: `Invalid Mailgun SMTP host: ${this.config.smtpHost}` };
    }

    return { status: 'ok', message: 'Mailgun SMTP relay configuration is valid' };
  }

  getRelayConfig(): { host: string; port: number; username: string; password: string } {
    return {
      host: this.config.smtpHost,
      port: this.config.smtpPort,
      username: this.config.authUsername,
      password: this.config.authPassword,
    };
  }
}
