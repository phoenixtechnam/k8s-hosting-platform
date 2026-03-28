export interface SmtpRelayAdapter {
  readonly providerType: string;
  testConnection(): Promise<{ status: 'ok' | 'error'; message?: string }>;
  getRelayConfig(): { host: string; port: number; username: string; password: string };
}
