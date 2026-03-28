import type { SmtpRelayAdapter } from './types.js';

interface PostmarkConfig {
  readonly smtpHost: string;
  readonly smtpPort: number;
  readonly apiKey: string;
}

export class PostmarkAdapter implements SmtpRelayAdapter {
  readonly providerType = 'postmark';
  private readonly config: PostmarkConfig;

  constructor(config: PostmarkConfig) {
    this.config = config;
  }

  async testConnection(): Promise<{ status: 'ok' | 'error'; message?: string }> {
    if (!this.config.apiKey) {
      return { status: 'error', message: 'Incomplete Postmark configuration: API key is required' };
    }

    if (this.config.smtpHost !== 'smtp.postmarkapp.com') {
      return { status: 'error', message: `Invalid Postmark SMTP host: ${this.config.smtpHost}` };
    }

    return { status: 'ok', message: 'Postmark SMTP relay configuration is valid' };
  }

  getRelayConfig(): { host: string; port: number; username: string; password: string } {
    return {
      host: this.config.smtpHost,
      port: this.config.smtpPort,
      username: this.config.apiKey,
      password: this.config.apiKey,
    };
  }
}
