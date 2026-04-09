import { z } from 'zod';

/**
 * Sub-user (client-panel team member) API contracts.
 *
 * Endpoints under `/api/v1/clients/:clientId/users*`:
 *   GET    — list the client's team (client_admin + client_user + staff)
 *   POST   — create a sub-user (client_admin + staff only)
 *   DELETE — remove a sub-user (client_admin + staff only)
 *
 * Role semantics:
 *   client_admin — full team management (create/edit/delete sub-users)
 *   client_user  — read-only access to own client resources
 *
 * Plan limits are enforced server-side via
 * `hostingPlans.maxSubUsers + clients.maxSubUsersOverride`.
 */

// ─── Roles ──────────────────────────────────────────────────────────────────

export const subUserRoleSchema = z.enum(['client_admin', 'client_user']);
export type SubUserRole = z.infer<typeof subUserRoleSchema>;

// ─── Create ─────────────────────────────────────────────────────────────────

export const createSubUserSchema = z.object({
  email: z.string().email('email must be a valid email address'),
  full_name: z.string().min(1, 'full_name is required').max(255),
  password: z.string().min(8, 'password must be at least 8 characters').max(255),
  /**
   * Optional — defaults to `client_user` server-side. Only
   * `client_admin` (or staff) callers may create another
   * `client_admin`; a `client_user` caller cannot reach this route
   * at all because backend middleware rejects it.
   */
  role_name: subUserRoleSchema.optional(),
});
export type CreateSubUserInput = z.infer<typeof createSubUserSchema>;

// ─── Update (Phase 3) ───────────────────────────────────────────────────────

/**
 * Partial update of a sub-user. All fields optional — callers should
 * send only the fields they want to change. Password changes go
 * through a separate reset-password endpoint in Phase 4, not here.
 */
export const updateSubUserSchema = z.object({
  full_name: z.string().min(1, 'full_name cannot be empty').max(255).optional(),
  role_name: subUserRoleSchema.optional(),
  /**
   * Lifecycle state. `active` = can log in; `disabled` = cannot
   * log in but row is preserved (soft-delete); `pending` is
   * reserved for invitation flows (Phase 8+) and cannot be set
   * via this endpoint.
   */
  status: z.enum(['active', 'disabled']).optional(),
}).refine(
  (data) => Object.values(data).some((v) => v !== undefined),
  { message: 'at least one field (full_name, role_name, status) must be provided' },
);
export type UpdateSubUserInput = z.infer<typeof updateSubUserSchema>;

// ─── Response shapes ────────────────────────────────────────────────────────

/**
 * Date fields are typed as `string | Date` because Drizzle returns
 * `Date` objects from PostgreSQL in-process while the JSON wire
 * format (Fastify's serializer) converts them to ISO strings. Both
 * shapes need to parse cleanly; `new Date(value)` works for either.
 */
const dateLike = z.union([z.string(), z.date()]);

export const subUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string(),
  roleName: subUserRoleSchema,
  status: z.string(),
  createdAt: dateLike,
  lastLoginAt: dateLike.nullable(),
});
export type SubUser = z.infer<typeof subUserSchema>;

export const createdSubUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string(),
  roleName: subUserRoleSchema,
  status: z.string(),
  createdAt: dateLike,
});
export type CreatedSubUser = z.infer<typeof createdSubUserSchema>;
