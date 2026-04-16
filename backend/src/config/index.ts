import { z } from 'zod';

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url().or(z.string().startsWith('postgresql://')).or(z.string().startsWith('postgres://')),
  JWT_SECRET: z.string().min(16),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: z.string().optional(),
  OIDC_ENCRYPTION_KEY: z.string().min(32).optional(),
  KUBECONFIG_PATH: z.string().optional(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  PLATFORM_ENV: z.enum(['development', 'dev', 'staging', 'production']).default('development'),
  PLATFORM_VERSION: z.string().default('0.1.0'),
  PLATFORM_INTERNAL_SECRET: z.string().optional(),
  DEFAULT_STORAGE_CLASS: z.string().default('local-path'),
  INGRESS_BASE_DOMAIN: z.string().optional(),
  INGRESS_DEFAULT_IPV4: z.string().optional(),
  CLUSTER_ISSUER_NAME: z.string().optional(),
  PLATFORM_NAMESPACE: z.string().default('platform'),
  FILE_MANAGER_IMAGE: z.string().default('ghcr.io/phoenixtechnam/file-manager:latest'),
  DISABLE_RATE_LIMIT: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.flatten().fieldErrors;
    const message = Object.entries(formatted)
      .map(([key, errors]) => `  ${key}: ${errors?.join(', ')}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${message}`);
  }
  const config = result.data;
  if (config.PLATFORM_ENV === 'production' && !config.OIDC_ENCRYPTION_KEY) {
    console.error('[config] CRITICAL: OIDC_ENCRYPTION_KEY is not set in production. Stored credentials will use a zero key and are NOT secure.');
  }
  return config;
}
