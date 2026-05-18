# Security / Firewall / Node Hardening — Roadmap

**Status:** Phase 1 + Phase 2 (minus Trivy) implementing 2026-05-18. Phase 3 deferred.
**Owner:** Platform team.
**Related:** [SECURITY_HARDENING.md](SECURITY_HARDENING.md) (operator runbook, ships with Phase 1), [CLUSTER_NETWORK.md](CLUSTER_NETWORK.md), [SECRETS_LIFECYCLE.md](SECRETS_LIFECYCLE.md).

## Why this page exists

Today the platform has a strong firewall foundation (`bootstrap.sh` always-on `set` mode, `cluster_peers_{v4,v6}` nft sets converged from kube-API by `firewall-reconciler`, `ClusterPendingPeer` + `ClusterTrustedRange` CRDs) but **two operational gaps**:

1. **SSH is `tcp dport 22 accept` with no source scoping** (`bootstrap.sh:1462`). Bootstrap assumes the operator gates SSH externally (cloud-firewall, workstation IP). For self-hosted/Hetzner deployments there is no UX path to lock SSH down to a mesh interface.
2. **No single place** to see node-level security posture: which SSH flags are set, whether unattended-upgrades is active, what's actually exposed publicly, which mesh agent is installed where.

The new `/settings/security-hardening` admin page fills both gaps with an observability-first design: probe DaemonSet writes per-node ConfigMaps, backend composes a snapshot, frontend renders 6 tabs. Destructive changes (SSH lockdown, mesh provider switch) surface as **guided runbooks** rather than in-place mutations — operators paste a `bootstrap.sh` re-run command and the UI polls until probe confirms the new state.

## Confirmed scope (Phase 1 + 2, minus Trivy)

- Admin panel only (super_admin), cluster nodes only.
- Mesh providers (NetBird / Tailscale / WireGuard) are **operator-chosen, opt-in, externally installed**. We detect them, we don't bundle them. Calico's WG/51821 (pod traffic, public-key auth) is **separate** and must remain untouched.
- Read-mostly + safe toggles. Firewall mode flip / mesh provider switch require `bootstrap.sh` re-run.
- Peer enrollment **exclusively** via `ClusterPendingPeer` CR — direct `peer-firewall-add` calls get reverted by the reconciler in ~5s.
- Trivy CVE scanning is **deferred** (originally Phase 2.3, postponed indefinitely — needs scanner image + CronJob + new DB table + retention policy; revisit when there's operator demand).

---

## Phase 1 — Observability + safe SSH lockdown (MVP)

### Goal
Give operators a single page showing what's exposed publicly, which mesh is installed per-node, and a guided runbook to move SSH off `0.0.0.0/0`.

### Components

| Layer | Path | Role |
|---|---|---|
| Contracts | `packages/api-contracts/src/security-hardening.ts` | Zod schemas for snapshot envelope (meshProvider, nodeSshExposure, nodeHardening, firewallPosture, recentEvents) |
| DaemonSet | `k8s/base/security-probe/` | Read-only, drops ALL caps, hostPath read mounts (`/etc/ssh`, `/proc/sys/kernel`, `/sys/class/net`, `/etc/os-release`, `/proc/net/nf_conntrack`) |
| Probe binary | `security-probe/` (Go) | 60s loop: parse `sshd_config` (incl. `Include` + drop-in dir), detect `wt0`/`tailscale0`/`wg0`, conntrack scrape, write one ConfigMap per node |
| Backend | `backend/src/modules/security-hardening/` | `ssh-probe.ts`, `mesh-detect.ts`, `hardening-metrics.ts`, `firewall-posture.ts`, `service.ts`, `routes.ts` (super_admin + audit-logged) |
| Frontend | `frontend/admin-panel/src/pages/SecurityHardeningSettings.tsx` | 6 tabs: Overview, SSH Lockdown, Mesh Status, Firewall Posture, Node Hardening (CIS), Recent Security Events |
| Bootstrap | `scripts/bootstrap.sh` | New **opt-in** `--ssh-via-mesh <iface>` flag — scoped SSH rule (iif + trusted_ranges saddr) |
| CI | `scripts/ci-firewall-check.sh` extended | New invariant: ssh-via-mesh branch must drop public `:22 accept` |
| CI | `scripts/test-ssh-via-mesh.sh` (NEW) | DinD-style render harness |
| Docs | `docs/04-deployment/SECURITY_HARDENING.md` (NEW) | Operator runbook for the three mesh providers + break-glass recovery |

### CIS-style checks (Phase 1, ≤10 hand-picked rules)

| ID | Rule | Severity |
|---|---|---|
| SSH-001 | `PermitRootLogin no` | high |
| SSH-002 | `PasswordAuthentication no` | high |
| SSH-003 | `AllowUsers` set (whitelist) | medium |
| SSH-004 | `Port` ≠ 22 (security through obscurity, info only) | info |
| SSH-005 | `KbdInteractiveAuthentication no` | medium |
| KERNEL-001 | Boot age < 90 days | medium |
| KERNEL-002 | No pending kernel update | medium |
| HARDEN-001 | `fail2ban` OR `sshguard` present | medium |
| HARDEN-002 | `unattended-upgrades` package active | medium |
| NET-001 | SSH not exposed to `0.0.0.0/0` | critical |

### Risks

| Risk | Sev | Mitigation |
|---|---|---|
| **Operator self-lockout** — enables `--ssh-via-mesh` without working mesh | **HIGH** | Runbook modal blocks unless probe confirms `provider != 'none'`; forces typed hostname + "I have console/KVM access" checkbox; bootstrap.sh emits warning + 10s sleep if no mesh interface up; docs link Hetzner Rescue |
| security-probe privilege escalation | MED | Read-only mounts, drop ALL caps, security-reviewer pass before merge |
| sshd_config parser misses `Include` directive → false-secure | MED | Walk drop-in dir; unit-test `Include` case; on parse failure surface "parse failed" not "secure" |
| Probe ConfigMap stale (node down) | LOW | UI shows `lastUpdatedAt`; > 5min flags as "stale"; never silently treats absence as "secure" |
| CIS-style noise overwhelms operators | LOW | Phase 1 ships ≤10 hand-picked rules; severity-tiered; "Hide info-only" toggle |

### Phase 1 success criteria

- [ ] `/settings/security-hardening` loads for super_admin, 403s for others
- [ ] All 6 tabs render with live data from probe within 60s of first deploy
- [ ] `ci-firewall-check.sh` extended with SSH-scoping invariant, passes on main + fails on regression
- [ ] `--ssh-via-mesh` end-to-end on DinD: public-IP SSH refused, mesh-IP SSH accepted, allowlisted workstation IP still allowed
- [ ] Probe DaemonSet runs on every node, writes one ConfigMap per node, ConfigMap GCs on node delete
- [ ] All write routes audit-logged, security-reviewer pass
- [ ] Test coverage ≥ 70% (Phase 1 target per CLAUDE.md)
- [ ] Manual lock-out-and-recover dry-run on staging signed off

### Phase 1 estimate
~7–9 days. Go binary + DaemonSet image pipeline is the long pole.

---

## Phase 2 — Configuration UI (minus Trivy, ~5–8 days)

### Goal
Move beyond observability: convert findings into actions, surface deeper posture, apply hardening defaults.

### Components

#### 2.1 K8s posture tab
- `backend/src/modules/security-hardening/k8s-posture.ts` — enumerate pods, classify by Pod Security Standard, count hostPath mounts, hostNetwork pods, capabilities-added pods
- Frontend tab "K8s Posture" — PSS coverage chart, privileged-pod table, hostPath user table, "Suggested PodSecurity admission labels" copy-paste generator per namespace
- Read-only. The "apply" button generates `kubectl label namespace` commands and copies them (no in-place apply — that's Phase 3).

#### 2.2 Auth/Audit metrics tab
- `backend/src/modules/security-hardening/auth-posture.ts` — failed-login count (24h, 7d), JWT secret age, oldest active session, last admin login per user
- Dex health (`http://dex/healthz`), oauth2-proxy readiness, last successful Dex login
- Reuses existing `audit_logs`, `users`, `auth_sessions` tables — no schema changes

#### 2.3 Denied-connection → trusted-range bridge **— DEFERRED to P2.3.1**
- The probe already samples `/proc/net/nf_conntrack` for the denied count (Phase 1, surfaced under `firewall.deniedCountWindow`)
- Rolling top-N source-IP rollup + per-row "Allow this IP" CTA is deferred — it needs probe-side aggregation (Go) + new contract field + a frontend table with deep-link to the trusted-range create modal. Tracked as `P2.3.1`; revisit when operator demand surfaces.

#### 2.4 NetworkPolicy templates + bulk apply
- Static catalog ships in this PR: `isolate-tenant`, `deny-all-egress`, `allow-dns-only`. Visible as the Network Policies tab.
- **Bulk apply deferred to P2.4.1** — the catalog preview ships in this PR; the apply action ("Apply to all tenant namespaces" as a task-center long-running op) is wired as a disabled button labelled "Preview only (P2.4.1)" until the task-center plumbing + per-tenant override flow is reviewed in its own change. Catalog contracts (`networkPolicyTemplate*`, `applyNetworkPolicyTemplate*`) and route stubs are in place.

#### 2.5 Suggested display items (top 5 from planner — see "Additional Display Items" below)
1. Calico WG (51821) verification card
2. Reserved-platform-hostname collision feed (ADR-040)
3. TLS cert expiry < 30d summary (cert-manager)
4. Backup target encryption + freshness card
5. Audit-log gap detector

### Phase 2 risks

| Risk | Sev | Mitigation |
|---|---|---|
| Probe `/proc/net/nf_conntrack` read on busy nodes is expensive | MED | Sample max N rows, drop CLOSE/TIME_WAIT noise, cap CPU via `resources.limits` |
| Bulk NetworkPolicy apply has high blast radius | HIGH | Task-center confirmation gate + per-template dry-run preview + per-tenant override (don't force on tenants with custom policies) |
| Dex health endpoint requires DNS that may not resolve in-cluster | LOW | Fall back to `kubectl get deployment dex --namespace dex` readiness check |
| Audit-log gap detector raises false positives on idle systems | LOW | Threshold based on observed insert rate (rolling avg), not absolute |

### Phase 2 estimate
~5–8 days (without Trivy).

---

## Phase 3 — Stretch (deferred, ~12–15 days)

**Not in current scope.** Documented here for future planning.

### 3.1 Mesh agent lifecycle from UI
- Install/uninstall NetBird/Tailscale/WireGuard per-node via one-shot privileged Job (hostPath `/usr/local/bin`)
- HIGH blast radius — typed-confirm + super_admin + audit log + circuit breaker

### 3.2 Per-node firewall chain gating (cluster-network Phase 6.5)
- Tie firewall chain selection to existing `platform.phoenix-host.net/exposure` label
- Private nodes drop all workload ports at the input chain
- Coordinate with `firewall-reconciler` (Go) work

### 3.3 Live Felix log tail
- New log shipper (no scraper exists today despite stale memory claim)
- WebSocket stream to a "Live Denied Connections" panel

### 3.4 Trivy CVE scanning (originally Phase 2.3, deferred indefinitely)
- Nightly CronJob scans all images pulled by tenant Deployments
- New `image_cve_scans` table with retention policy
- Per-tenant + per-image rollup tab
- Decision point: only revisit if operator demand surfaces — most tenant images are vendored stacks (catalog) where CVE noise:signal is unfavorable.

---

## Additional display items (codebase-grounded suggestions)

All 10 surfaced by the planner. Top 5 implemented in Phase 2.5; remaining 5 documented for Phase 3+ or as future work.

### Phase 2.5 (implementing now)

| # | Card | Codebase tie-in |
|---|---|---|
| 1 | **Calico WG (51821) verification** | [CLAUDE.md cluster firewall section]: Calico WG MUST remain on UDP/51821 with public-key auth. Assert: listening on every node, public-key auth confirmed. Important because the page thesis is "lock down SSH" — operators will ask "what about all this other UDP traffic?" |
| 2 | **Reserved-platform-hostname collision feed** | ADR-040: refuses `RESERVED_PLATFORM_HOSTNAME` 409s at `createDomain` / `createDnsRecord`. Audit-log filter surfaces tenant probing or accidental misconfig. |
| 3 | **TLS cert expiry < 30d summary** | cert-manager tracked in `cluster-health/service.ts:26-27`. Sources from `certificates.cert-manager.io` — admin-panel / client-panel / longhorn / stalwart / webmail TLS + `AcmeRenewal` (Phase K bug fixes). |
| 4 | **Backup target encryption + freshness** | Snapshot overhaul Phase 11+12 (commit `8c55e615`): per-target `PLATFORM_ENCRYPTION_KEY`, primary connection-test, last-successful-snapshot age. An unencrypted off-site backup with stale creds IS a security problem. |
| 5 | **Audit-log gap detector** | Recent-insert timestamp, retention active, no row-deletion since session start. Compromise of audit logging is a precondition for undetected attacks. |

### Deferred to Phase 3+

| # | Card | Codebase tie-in | Why deferred |
|---|---|---|---|
| 6 | Longhorn replica health + encryption-at-rest | `longhorn-system` tracked in `cluster-health/service.ts:29`. Cross-ref `snapshot-quota.ts` retention. | Longhorn has its own UI; duplication risk. Add only if operators ask. |
| 7 | CNPG TLS + WAL-archive posture | `cnpg-system` tracked in `cluster-health/service.ts:25`. mTLS, current primary, WAL lag. | CNPG Operator UI exists; mostly observability sugar. |
| 8 | oauth2-proxy + Dex session age + admin-ui label coverage | Cross-ref `platform.phoenix-host.net/admin-ui` label per CLAUDE.md admin-only UIs section. | Partial coverage in Phase 2.2 (auth metrics tab); the label-coverage piece is its own work. |
| 9 | Tenant lifecycle hook breaker status | ADR-033 hook registry; existing `Settings → Lifecycle Hooks` page. | Better lives on its own page; cross-link from Security page when relevant. |
| 10 | SFTP chroot integrity | `sftp-gateway` (4 security review rounds). Chroot active, N sessions, last failed-auth. | Existing SFTP-users page covers this; add summary row if there's space. |

---

## Cross-cutting concerns

### Audit logging
All write routes use the existing `app.log.warn({ userId, ... })` pattern from `cluster-network/routes.ts:108`. Audit-logs middleware captures HTTP path/method automatically.

### RBAC
All routes `super_admin` only via existing `requireRole('super_admin')` middleware. UI gated via existing `SuperAdminOnly` wrapper used in `App.tsx`.

### Task-center integration
- Phase 1: SSH-lockdown runbook is operator-driven (runs bootstrap.sh on a node) — no task-center entry, UI polls probe ConfigMap.
- Phase 2: "Apply NetworkPolicies to all tenants" goes through `tasks.start/progress/finish` per [project_mail_ops_task_center_2026_05_16] + PR #69.

### Feature flags
`SECURITY_HARDENING_PROBE_ENABLED` (default true) in `platform_settings` table — operators can disable the DaemonSet if it ever misbehaves.

### Test strategy (per CLAUDE.md)
- Coverage target Phase 1: ≥70%
- Unit (vitest): all backend modules + rule encoders + parser edge cases
- Unit (Go): sshd_config parser fixtures (Include, drop-in dir, AllowUsers space-separated, multiple Port directives)
- Integration (DinD): probe DS writes ConfigMap → backend reads + renders; trusted_range CR change reflected in firewall posture within 30s poll
- E2E (Playwright): page loads, all tabs render, deep-links navigate, lockdown modal confirmation gate enforced
- Shell: ci-firewall-check passes default branch + fails on regression; ssh-via-mesh render asserts expected nft text
- Manual: probe ConfigMap eyeball in local DinD; lock-out-and-recover dry-run on staging with KVM/console access

---

## Phase dependencies

```
Phase 1 (MVP)
  └─ Phase 2 — needs Phase 1 page shell + audit hooks + task-center pattern
       └─ Phase 3 (deferred) — needs Phase 2 task-center patterns + RBAC
```

Each phase independently mergeable.

---

## Reference paths

| File | Role |
|---|---|
| `scripts/bootstrap.sh:1462` | Current public SSH gap |
| `scripts/ci-firewall-check.sh` | CI guard to extend |
| `backend/src/modules/cluster-network/routes.ts` | Pattern: super_admin + audit |
| `backend/src/modules/cluster-health/service.ts` | TRACKED constant for system namespaces |
| `backend/src/modules/audit-logs/routes.ts` | Filter source for Recent Events tab |
| `backend/src/modules/tasks/service.ts` | Task-center pattern for Phase 2 destructive ops |
| `frontend/admin-panel/src/pages/ClusterNetworkingSettings.tsx` | Page-shell template |
| `frontend/admin-panel/src/pages/Settings.tsx` | Hub to add sub-page card |
| `frontend/admin-panel/src/App.tsx` | Route registration |
| `packages/api-contracts/src/cluster-network.ts` | Schema template |
| `k8s/base/firewall-reconciler/daemonset.yaml` | DaemonSet topology to mirror |
