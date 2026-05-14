# ADR-036 — Custom Deployments (Bring-Your-Own Container / Compose)

**Status:** Accepted · 2026-05-11 (PR-1) — 2026-05-12 (PRs 2–5 shipped)
**Supersedes / related:** ADR-025 (Workload Catalog), ADR-026 (Application Catalog), ADR-033 (Client Lifecycle Hooks), ADR-035 (Tenant Backup Coverage Contract)

## Context

The platform shipped two deployment paths before this ADR:

- **Workload Catalog (ADR-025)** — composable runtimes/databases/services from a Git-tracked catalog (`manifest.json` per entry).
- **Application Catalog (ADR-026)** — managed Helm stacks (WordPress, Nextcloud, etc.).

Operators asked for a third path: let tenants deploy ANY Docker image, or paste a docker-compose YAML and have the platform stand it up. The motivation is the long tail of "I just need to run my own thing": custom apps, internal tools, vendor-supplied images that aren't worth packaging as a catalog entry.

## Decision

Ship a third deployment path called **custom deployments** that:

1. Accepts EITHER a structured single-container input (the simple form) OR a docker-compose YAML body (the editor) — both normalised to the same `customDeploymentSpec` JSONB on the existing `deployments` table.
2. Renders to native k8s primitives (`Deployment`, `Service`, `ConfigMap`, `Secret`) via a dedicated `custom-deployments/k8s-deployer.ts`, NOT through the catalog deployer's `deployCatalogEntry()` (the catalog code has too many catalog-specific assumptions — password-reset init containers, firewall annotations, token expansion in env — that would be dead weight for custom).
3. Discriminates rows via `deployments.source` (`'catalog' | 'custom'`) with a CHECK constraint enforcing the XOR (`source='catalog' ↔ catalog_entry_id NOT NULL ↔ custom_spec IS NULL`).
4. Reuses every cross-cutting consumer (ADR-033 lifecycle hooks, ADR-035 bundle backups, plan-quota math, status reconciler) by living on the same `deployments` table — no parallel schema.

### User-confirmed image-trust trade-offs

The operator (and platform-operator role) explicitly REJECTED three controls that would otherwise have shipped:

- **No registry allowlist.** Tenants pull from any registry, including obscure / self-hosted ones.
- **No image-pin requirement.** `:latest` and missing tags are accepted (an advisory badge surfaces this in the UI; can be silenced via `system_settings.custom_deployments_warn_unpinned_tags`).
- **Private registries via PAT are supported.** Encrypted at rest with the existing `PLATFORM_ENCRYPTION_KEY` envelope.

These choices materially raise the threat surface compared to the catalog path. The platform's defense against malicious tenant images is **Pod isolation, not image trust**:

- `pod-security.kubernetes.io/enforce: baseline` on every tenant namespace (set by `applyNamespace()` in `k8s-provisioner`; backfilled on existing namespaces by `scripts/backfill-tenant-namespace-pss.sh`).
- `pod-security.kubernetes.io/warn: restricted` + `audit: restricted` for visibility on the stricter bar.
- Backend validator's deny-list rejects every known PSS-baseline escape BEFORE the spec reaches the cluster: `hostNetwork`, `hostPort`, `privileged`, `runAsUser:0` (unless admin-flagged `allowRoot`), unsafe `cap_add`, `hostPath` volumes (compose bind mounts), `cgroup_parent`, `pid`/`ipc`/`userns_mode` host sharing, `extends`, `build:`, sysctls outside the safe set, etc.
- Tenant `NetworkPolicy` (default-deny ingress + intra-namespace allow + scoped platform-api ingress) blocks cross-tenant traffic.
- Per-tenant `ResourceQuota` (CPU + memory + storage) caps blast radius.

### What the platform does NOT do (residual risk, accepted)

- **Image content scanning** — no Trivy / cosign in Phase 1. `system_settings.custom_deployments_scan_on_pull` is a Phase-2 reservation (column exists, no-op today). A tenant pulling a typosquatted or compromised image will run it; the platform restricts what it can DO, not what it IS.
- **Tag-mutability detection** — `:latest` can silently change between pulls. Advisory badge only.
- **PAT misuse** — a tenant supplying credentials to a hostile registry could leak those credentials to the registry author. Mitigation: envelope-encrypted at rest, never returned in API responses (only `tokenLastFour`), HTTPS-only registry connections, SSRF guard in the update-checker (rejects `WWW-Authenticate: Bearer realm="http://kubernetes.default.svc:..."` and RFC-1918 / IMDS / `.svc` / `.local` realms).

The trade-offs are written down here so any future operator can read the contract and decide whether to flip the conservative toggles on:

- `custom_deployments_enabled = false` — master kill switch.
- `custom_deployments_allow_compose = false` — disable the compose editor.
- `custom_deployments_allow_private_registries = false` — disable PAT submission.
- `custom_deployments_scan_on_pull = true` — reserved for Phase-2 Trivy.
- `custom_deployments_warn_unpinned_tags = false` — suppress the `:latest` advisory badge.

## Implementation map

Five PRs land the feature end-to-end:

| PR | Scope | Files (approx) |
|----|-------|---------------|
| #10 (PR-1) | Substrate: shared Zod schemas, DB schema + 2 migrations, PSS labels in `applyNamespace`, backfill script. | `packages/api-contracts/src/custom-deployments.ts` + `compose.ts`, `backend/src/db/migrations/0098,0099`, `backend/src/modules/k8s-provisioner/service.ts`, `scripts/backfill-tenant-namespace-pss.sh` |
| #11 (PR-2) | Simple-mode runtime: validator, image-reference parser, semver, PAT store, update-checker, image-audit, k8s-deployer (single service), reconcile integration, service + routes. | `backend/src/modules/custom-deployments/{validator,image-reference,semver-compare,pat-store,update-checker,image-audit,k8s-deployer,reconcile,service,routes,role-types}.ts` |
| #12 (PR-3) | Compose parser + multi-service runtime: hand-written compose 3.7–3.9 parser, JSON Schema export, k8s-deployer multi-service refactor (depends_on initContainers, healthcheck→probe rendering, per-service Deployments). | `backend/src/modules/custom-deployments/{compose-parser,compose-schema-export}.ts`, edits to `k8s-deployer.ts` + `service.ts` + `routes.ts` |
| #13 (PR-4) | UI: client-panel "Custom Containers" tab with simple wizard + compose editor (textarea + JSON-schema served, Monaco follow-up) + updates pill + PAT modal; admin-panel source filter chip + per-row badge. | `frontend/client-panel/src/components/custom-deployments/*`, `frontend/client-panel/src/hooks/use-custom-deployments.ts`, edits to `Applications.tsx` + admin-panel `ClientDetail.tsx` + `use-deployments.ts` |
| this PR (PR-5) | Integration harness, lifecycle/bundle verification, operator + tenant docs, this ADR. | `scripts/integration-custom-deployments.sh`, `docs/02-operations/CUSTOM_DEPLOYMENTS.md`, `docs/03-features/CUSTOM_CONTAINERS_USER_GUIDE.md`, this file |

## Consequences

### Positive

- Long tail of "run my own thing" requests is covered. Tenants no longer need an operator to add a catalog entry for a one-off image.
- The substrate (PR-1) hardens EVERY tenant namespace with PSS — even catalog deployments benefit from the new baseline-enforce posture.
- The compose parser's strict subset gives a clear contract: every field is either documented as accepted, ignored-with-warning, or rejected with a specific error code. No silent acceptance.
- All cross-cutting consumers (lifecycle, bundles, plan-quota, status reconciler) work for custom deployments without any registry/coverage changes because the row lives on the same `deployments` table.

### Negative

- A genuinely-malicious image runs in a tenant namespace. PSS-baseline contains it but does not detect it.
- The compose subset is opinionated; some legitimate compose features (`build:`, host-network, `cap_drop`, devices) are unavailable. Operators are responsible for explaining this to tenants.
- PAT custody adds a sensitive-data surface. The current envelope encryption is the same shape used by the mTLS provider's private keys and OIDC client secrets; a future key-rotation event affects all three.

### Mitigations

- ADR-035 backup coverage already covers `custom_spec` (the BundleComponent `config` dumps the whole `deployments` row), and the tenant PVC is already covered by the `files` BundleComponent. Confirmed by the CI audit script.
- `scripts/integration-custom-deployments.sh` exercises the full create → deploy → upgrade → PAT → compose-stack → delete chain against a real cluster on every release.
- The five `system_settings.custom_deployments_*` toggles let an operator turn off the feature, the compose mode, or the PAT surface independently during an incident.
- Each PR carried independent `security-reviewer`, `code-reviewer`, and (for PR-1) `database-reviewer` BLOCK gates. Every BLOCK finding was resolved before merge.

## Out of scope (deferred)

- **Per-service compose-mode patch surface.** PR-3's `updateCustomDeployment` rejects `image` / `env` / `resources` patches on compose stacks with `NOT_SUPPORTED_FOR_COMPOSE`. The UI honours this — only simple-mode rows show "Upgrade tag" in the action menu. To change a compose stack today, edit the YAML and re-deploy. Phase-2 will add `PATCH /custom-deployments/:id/services/:serviceName` for fine-grained per-service patches.
- **Monaco / monaco-yaml** in the compose editor. The JSON Schema endpoint is already served at `GET /custom-deployments/compose-schema`; PR-4 ships a plain `<textarea>`. A Phase-2 PR drops Monaco in with no API change.
- **admin-only `allowRoot` toggle in the admin panel.** Requires a new admin-only endpoint (`POST /admin/custom-deployments/:id/allow-root`) not in any merged PR. The validator's `ALLOW_ROOT_REQUIRES_ADMIN` issue surfaces if a stored spec has `allowRoot=true` without admin-role — but today admins can only set it by direct DB write.
- **Trivy image scanning.** `system_settings.custom_deployments_scan_on_pull` is a no-op column reserved for Phase 2.
- **cosign signature verification.** No verification today. A future PR could add a signature-required mode behind another toggle.

## References

- PR #10 — substrate
- PR #11 — simple-mode runtime
- PR #12 — compose parser + multi-service
- PR #13 — UI
- PR #14 (this one) — integration harness + docs
- `docs/02-operations/CUSTOM_DEPLOYMENTS.md` — operator runbook
- `docs/03-features/CUSTOM_CONTAINERS_USER_GUIDE.md` — tenant guide
- ADR-025, ADR-026, ADR-033, ADR-035
