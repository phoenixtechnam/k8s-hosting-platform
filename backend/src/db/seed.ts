import { sql } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { getDb, closeDb } from './index.js';
import { rbacRoles, regions, hostingPlans, users, catalogRepositories, oidcProviders } from './schema.js';
import { encrypt } from '../modules/oidc/crypto.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const db = getDb(databaseUrl);

console.log('Seeding database...');

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
const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@k8s-platform.local-dev';
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
  const dexIssuer = process.env.DEX_ISSUER_URL ?? 'http://dind.local:2015/dex';

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
