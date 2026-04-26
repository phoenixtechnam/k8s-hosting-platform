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

### IPv6 / dual-stack networking
- [ ] **v1 ships IPv4-only** — `--cluster-cidr` and `--node-ip` are IPv4 only;
      most cloud providers and OSS adopters will be on IPv4-friendly networks.
      Adding dual-stack later is non-breaking (additive flag, additive ipPools).
- [ ] **v2: `--ipv6` opt-in flag** — enables dual-stack:
  - k3s gets `--cluster-cidr=10.42.0.0/16,fd42::/48`,
    `--service-cidr=10.43.0.0/16,fd43::/112`, `--node-ip=<v4>,<v6>`
  - Tigera Installation gets a sibling IPv6 ipPool +
    `nodeAddressAutodetectionV6: { canReach: "2606:4700:4700::1111" }`
  - nftables config opens IPv6 equivalents of every cluster-internal port
  - NetworkPolicy `ipBlock` entries get v6 siblings (the `10.42.0.0/16`
    ipBlock for cross-node host→pod becomes `10.42.0.0/16` + `fd42::/48`)
  - Backend audit: every `request.ip` / IP-parsing call must handle
    IPv6-mapped IPv4 (`::ffff:1.2.3.4`) and pure v6
  - Smoke + failover suite: A and AAAA per hostname, v6 pod-IP cells
- [ ] **v3 (deferred): IPv6-only mode** — for cheaper IPv6-only cloud VMs.
      Niche; out of scope until a deployment actually needs it.

Estimated implementation effort for dual-stack v2: 8-10 hours of focused work.
The platform's data model + most code already tolerates v6 strings (audit_logs
accepts varchar(45) which is RFC v6 max); the work is mostly bootstrap
templating + NetworkPolicy duplication + a backend code audit.
