# Roadmap

## Implemented (Phase 1)

### OIDC / SSO Authentication
- [x] Multi-provider OIDC support (admin-scoped and client-scoped providers)
- [x] Authorization Code flow with PKCE
- [x] Backchannel logout support
- [x] Provider management UI in admin panel
- [x] Global "Disable Local Auth" toggles (separate for admin/client panels)
- [x] Break-glass emergency login for locked-out admins
- [x] Dex OIDC provider in staging for testing

### RBAC & Panel Enforcement
- [x] 7-role hierarchy: super_admin, admin, billing, support, read_only, client_admin, client_user
- [x] JWT panel/clientId claims with middleware enforcement
- [x] Admin impersonation of client accounts
- [x] Auto-create client_admin user on client creation
- [x] Client sub-user management with plan-based limits

### Platform Features
- [x] Full API endpoint coverage: DNS, hosting settings, protected directories
- [x] Workload CRUD with start/stop/deploy
- [x] Cron job start/stop/run-now
- [x] Client suspension cascade (domains, workloads, cron jobs)
- [x] SSH keys and resource quotas modules
- [x] Subscription management with plan selection

---

## Planned (Phase 2+)

### Client Self-Service Onboarding

**Goal**: Allow clients to register at an external IAM (Dex/Keycloak), then login to the client panel and set up their own hosting account — no admin intervention needed.

**How it works:**

1. Admin configures a client-scoped OIDC provider pointing to the external IAM
2. New client registers at the IAM (self-service registration)
3. Client visits the client panel login → clicks "Sign in with SSO"
4. OIDC callback → user authenticated but no client account exists yet
5. Platform creates a `pending` user with `clientId: null`
6. User is redirected to `/onboarding` page:
   - Company name, email (pre-filled from OIDC)
   - Plan selection (Starter, Business, Premium)
   - Region selection
   - Accept terms of service
7. On submit:
   - Backend creates a new `client` record
   - Links user to client (`clientId`, `roleName: 'client_admin'`)
   - Provisions Kubernetes namespace
   - Optionally: payment gate before provisioning (Stripe/Chargebee)
8. User lands on their dashboard — fully onboarded

**Data model (already prepared):**
- `users` table supports `clientId: null` (pending users with no client)
- `users.status: 'pending'` state exists for pre-onboarding users
- Provider `panel_scope: 'client'` determines that new users enter the client flow

**Implementation phases:**
1. **Onboarding page** — form with plan/region selection, creates client + links user
2. **Email verification** — optional, if IAM doesn't verify emails
3. **Admin approval workflow** — optional gate before account activation
4. **Payment integration** — Stripe/Chargebee checkout before provisioning
5. **OIDC claim mapping** — allow providers to pass role/client_id via custom claims for enterprise setups

### Other Phase 2+ Features
- OIDC claim mapping for enterprise IdP integration
- Custom OIDC provider management (Keycloak, Auth0, Okta, Azure AD)
- PostgreSQL 16 as secondary database
- Longhorn storage (replacing k3s local-path)
- Harbor container registry (replacing GHCR)
- Distributed tracing (Tempo)
- Docker-Mailserver + Roundcube email
- FileBrowser file manager integration
- Plesk migration service
- Geographic sharding / multi-region
