// Shared API contracts for the K8s Hosting Platform
//
// This package is the SINGLE SOURCE OF TRUTH for all API types.
// Both backend and frontend import from here.
//
// Usage:
//   import { createClientSchema, type ClientResponse } from '@k8s-hosting/api-contracts';
//
// Rules:
//   1. ALL API input/output types MUST be defined here
//   2. Backend validates with Zod schemas from this package
//   3. Frontend uses inferred TypeScript types from this package
//   4. NEVER define API types locally in backend or frontend
//   5. PaginationParams enforces limit <= MAX_PAGE_LIMIT (100)

export * from './shared.js';
export * from './auth.js';
export * from './clients.js';
export * from './domains.js';
export * from './databases.js';
export * from './workloads.js';
export * from './backups.js';
export * from './cron-jobs.js';
export * from './metrics.js';
export * from './subscriptions.js';
export * from './container-images.js';
export * from './workload-repos.js';
export * from './dashboard.js';
export * from './dns-records.js';
export * from './protected-directories.js';
export * from './hosting-settings.js';
