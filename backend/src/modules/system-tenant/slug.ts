/**
 * Constants + helpers for the SYSTEM tenant (ADR-040).
 *
 * The SYSTEM tenant is the platform-owned singleton that:
 *   - Reserves the platform apex domain (`<PLATFORM_BASE_DOMAIN>`)
 *   - Owns the platform's transactional mailbox addresses (noreply@,
 *     postmaster@, etc.) once those are provisioned
 *   - Cannot be suspended, archived, or deleted
 *
 * `tenants.is_system = TRUE` is the canonical identifier. The slug
 * and namespace below are stable so operators can refer to SYSTEM
 * deterministically in logs / kubectl output.
 */

/** Display slug for the SYSTEM tenant. Not a route key — UI groups
 *  by isSystem flag, not by name. */
export const SYSTEM_TENANT_NAME = 'SYSTEM';

/** Deterministic k8s namespace for the SYSTEM tenant. Bypasses the
 *  random-suffix scheme used by normal tenants because SYSTEM is a
 *  singleton — operators want `kubectl get ns tenant-system` to work.
 *  Length: 13 chars, well under the 63-byte k8s label limit. */
export const SYSTEM_TENANT_NAMESPACE = 'tenant-system';

/** Synthetic primary email for the SYSTEM tenant's tenant_admin user.
 *  Prefixed with `_` so it cannot collide with a customer-facing
 *  `system@<apex>` alias the operator may want to publish later.
 *  This account exists so admin impersonation works, but its mailbox
 *  is never delivered to — `email_verified_at` is stamped at insert
 *  and there's no password recovery flow against it. */
export function systemTenantEmail(apex: string): string {
  return `_system@${apex.trim().replace(/^\.+/, '')}`;
}
