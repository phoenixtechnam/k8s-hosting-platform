import { sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { getDb, closeDb } from './index.js';
import { rbacRoles, regions, hostingPlans, users, catalogRepositories, oidcProviders, systemSettings } from './schema.js';
import { encrypt } from '../modules/oidc/crypto.js';
import { dexHost, resolveBaseDomain } from '../config/domains.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const db = getDb(databaseUrl);

console.log('Seeding database...');

// System Settings (single row, id='system'). The row may already exist
// because getSettings() auto-creates a minimal version on first API call,
// so we use ON CONFLICT DO UPDATE with COALESCE — only NULL columns get
// populated from env. Admin-configured values (non-NULL) are always
// preserved; re-seeding never clobbers them.
const adminPanelUrl = process.env.ADMIN_PANEL_URL ?? null;
const clientPanelUrl = process.env.CLIENT_PANEL_URL ?? null;
const supportEmail = process.env.SUPPORT_EMAIL ?? null;
const supportUrl = process.env.SUPPORT_URL ?? null;
const ingressBaseDomain = process.env.INGRESS_BASE_DOMAIN ?? null;
const platformName = process.env.PLATFORM_NAME ?? 'Hosting Platform';
const platformTimezone = process.env.PLATFORM_TIMEZONE ?? 'UTC';
const apiRateLimit = process.env.API_RATE_LIMIT ? parseInt(process.env.API_RATE_LIMIT, 10) : 100;

await db.insert(systemSettings).values({
  id: 'system',
  platformName,
  adminPanelUrl,
  clientPanelUrl,
  supportEmail,
  supportUrl,
  ingressBaseDomain,
  apiRateLimit,
  timezone: platformTimezone,
}).onConflictDoUpdate({
  target: systemSettings.id,
  set: {
    // COALESCE(existing, new) — if existing value is already set, keep it.
    // Only fill in NULL columns from env. Respect what the admin chose.
    adminPanelUrl: sql`COALESCE(${systemSettings.adminPanelUrl}, ${adminPanelUrl})`,
    clientPanelUrl: sql`COALESCE(${systemSettings.clientPanelUrl}, ${clientPanelUrl})`,
    supportEmail: sql`COALESCE(${systemSettings.supportEmail}, ${supportEmail})`,
    supportUrl: sql`COALESCE(${systemSettings.supportUrl}, ${supportUrl})`,
    ingressBaseDomain: sql`COALESCE(${systemSettings.ingressBaseDomain}, ${ingressBaseDomain})`,
  },
});
// Also mirror ingressBaseDomain into the platform_settings kv table so
// existing consumers (ingress-routes/service.ts) see it without waiting
// for the admin to open the UI. Only writes if not already set.
if (ingressBaseDomain) {
  await db.execute(sql`
    INSERT INTO platform_settings (setting_key, setting_value, updated_at)
    VALUES ('ingress_base_domain', ${ingressBaseDomain}, NOW())
    ON CONFLICT (setting_key) DO UPDATE
    SET setting_value = COALESCE(NULLIF(platform_settings.setting_value, ''), EXCLUDED.setting_value)
  `);
}
console.log('  Seeded system settings (fills NULL columns only)');

// RBAC Roles
await db.insert(rbacRoles).values([
  { id: crypto.randomUUID(), name: 'super_admin', description: 'Full platform access + OIDC/user management', isSystemRole: 1, permissions: JSON.parse('["*"]') as string[] },
  { id: crypto.randomUUID(), name: 'admin', description: 'Manage clients and all resources', isSystemRole: 1, permissions: JSON.parse('["clients:*","domains:*","databases:*","workloads:*","backups:*","cron-jobs:*","subscriptions:*"]') as string[] },
  { id: crypto.randomUUID(), name: 'billing', description: 'Subscription and billing management', isSystemRole: 1, permissions: JSON.parse('["clients:read","subscriptions:*","billing:*"]') as string[] },
  { id: crypto.randomUUID(), name: 'support', description: 'Client support — domains, databases, backups + impersonate', isSystemRole: 1, permissions: JSON.parse('["clients:read","domains:*","databases:*","backups:*","impersonate"]') as string[] },
  { id: crypto.randomUUID(), name: 'read_only', description: 'View-only access to metrics and status', isSystemRole: 1, permissions: JSON.parse('["clients:read","metrics:read","status:read"]') as string[] },
  { id: crypto.randomUUID(), name: 'client_admin', description: 'Full access to own client account', isSystemRole: 1, permissions: JSON.parse('["own:*"]') as string[] },
  { id: crypto.randomUUID(), name: 'client_user', description: 'View-only access to own client resources', isSystemRole: 1, permissions: JSON.parse('["own:read"]') as string[] },
]).onConflictDoUpdate({ target: rbacRoles.name, set: { description: sql`excluded.description` } });
console.log('  Seeded RBAC roles');

// Regions
await db.insert(regions).values([
  { id: crypto.randomUUID(), code: 'eu-west', name: 'EU West (Falkenstein)', provider: 'hetzner', kubernetesApiEndpoint: null, status: 'active' },
]).onConflictDoUpdate({ target: regions.code, set: { name: sql`excluded.name` } });
console.log('  Seeded regions');

// Hosting Plans
await db.insert(hostingPlans).values([
  { id: crypto.randomUUID(), code: 'starter', name: 'Starter', description: 'Shared hosting for small sites', cpuLimit: '0.50', memoryLimit: '1.00', storageLimit: '10.00', monthlyPriceUsd: '5.00', features: { shared_pod: true, ssl: true, backups: 'daily' }, status: 'active' },
  { id: crypto.randomUUID(), code: 'business', name: 'Business', description: 'Dedicated pod with more resources', cpuLimit: '2.00', memoryLimit: '4.00', storageLimit: '50.00', monthlyPriceUsd: '15.00', features: { dedicated_pod: true, ssl: true, backups: 'daily', waf: true }, status: 'active' },
  { id: crypto.randomUUID(), code: 'premium', name: 'Premium', description: 'Maximum resources with priority support', cpuLimit: '4.00', memoryLimit: '8.00', storageLimit: '200.00', monthlyPriceUsd: '40.00', features: { dedicated_pod: true, ssl: true, backups: 'hourly', waf: true, priority_support: true }, status: 'active' },
]).onConflictDoUpdate({ target: hostingPlans.code, set: { name: sql`excluded.name` } });
console.log('  Seeded hosting plans');

// Catalog entries are populated by syncing catalog repositories — no built-in seed.

// Default admin user
const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@k8s-platform.test';
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) {
  throw new Error('ADMIN_PASSWORD environment variable is required for seeding. Set a strong password.');
}
const adminName = process.env.ADMIN_NAME ?? 'Platform Admin';
const adminPasswordHash = await bcrypt.hash(adminPassword, 12);
await db.insert(users).values([
  {
    id: crypto.randomUUID(),
    email: adminEmail,
    passwordHash: adminPasswordHash,
    fullName: adminName,
    roleName: 'super_admin',
    panel: 'admin',
    status: 'active',
    emailVerifiedAt: new Date(),
  },
]).onConflictDoUpdate({ target: users.email, set: { fullName: sql`excluded.full_name` } });
console.log(`  Seeded default admin user (${adminEmail})`);

// Catalog Repositories (unified — workloads + applications)
await db.insert(catalogRepositories).values([{
  id: crypto.randomUUID(),
  name: 'Official Catalog',
  url: 'https://github.com/phoenixtechnam/k8s-application-catalog',
  branch: 'main',
  syncIntervalMinutes: 60,
  status: 'active',
}]).onConflictDoUpdate({ target: catalogRepositories.url, set: { name: sql`excluded.name` } });
console.log('  Seeded catalog repositories');

// OIDC Providers (local Dex for development)
if (process.env.NODE_ENV !== 'production') {
  const encKey = process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64);
  // Prefer DEX_ISSUER_URL env if explicitly set (useful for staging with
  // a specific Dex URL), otherwise derive from PLATFORM_BASE_DOMAIN →
  // dex.<base>:<ingress-https-port>/dex. Dev default: 2011.
  const devHttpsPort = process.env.DEV_INGRESS_HTTPS_PORT ?? '2011';
  const dexIssuer =
    process.env.DEX_ISSUER_URL ??
    `https://${dexHost(process.env)}:${devHttpsPort}/dex`;
  console.log(`  Dex issuer: ${dexIssuer} (base=${resolveBaseDomain(process.env)})`);

  await db.insert(oidcProviders).values([
    {
      id: crypto.randomUUID(),
      displayName: 'Local Dex (Admin)',
      issuerUrl: dexIssuer,
      clientId: 'hosting-platform-admin',
      clientSecretEncrypted: encrypt('local-dev-secret-admin', encKey),
      panelScope: 'admin',
      enabled: 1,
      displayOrder: 0,
    },
    {
      id: crypto.randomUUID(),
      displayName: 'Local Dex (Client)',
      issuerUrl: dexIssuer,
      clientId: 'hosting-platform-client',
      clientSecretEncrypted: encrypt('local-dev-secret-client', encKey),
      panelScope: 'client',
      enabled: 1,
      displayOrder: 0,
    },
  ]).onConflictDoNothing();
  console.log('  Seeded OIDC providers (local Dex)');
}

console.log('Seed complete.');
await closeDb();
