# Custom Deployments — Operator Runbook

Operator-facing reference for the third deployment path introduced
by ADR-036. For the architectural decisions and residual risks see
[ADR-036](../07-reference/ADR-036-custom-deployments.md); for the
tenant-facing usage guide see
[CUSTOM_CONTAINERS_USER_GUIDE.md](../03-features/CUSTOM_CONTAINERS_USER_GUIDE.md).

## What is this

Tenants can deploy ANY container image or a docker-compose YAML
stack, alongside the workload-catalog (ADR-025) and
application-catalog (ADR-026) flows. The platform's defense against
malicious tenant images is Pod isolation — Pod Security Standards
`baseline` enforce on every tenant namespace, plus a backend
validator deny-list, plus `NetworkPolicy` and `ResourceQuota`. There
is **no** image scanning, registry allowlist, or pin enforcement in
Phase 1.

## On-call quick reference

### Kill switches (system_settings)

All five flags are operator-tunable via the admin API
(`PATCH /api/v1/admin/system-settings`):

| Flag | Default | Effect when `false` |
|------|---------|---------------------|
| `customDeploymentsEnabled` | `true` | Master kill switch. `POST /custom-deployments` returns 403 `CUSTOM_DEPLOYMENTS_DISABLED`. Existing rows keep running. |
| `customDeploymentsAllowCompose` | `true` | Compose mode rejected with 403 `COMPOSE_DEPLOYMENTS_DISABLED`. Simple-form still works. |
| `customDeploymentsAllowPrivateRegistries` | `true` | PAT submission rejected. Existing pull-credentials stay materialised. |
| `customDeploymentsImagePullAudit` | `true` | Stops populating `custom_deployment_image_audit`. Existing rows kept. |
| `customDeploymentsScanOnPull` | `false` | Reserved for Phase-2 Trivy. No-op today. |
| `customDeploymentsWarnUnpinnedTags` | `true` | Suppresses the `:latest` advisory issue from `/validate`. |

To kill the feature during an incident:

```bash
TOKEN=$(curl -s …/auth/login …)
curl -X PATCH /api/v1/admin/system-settings \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "custom_deployments_enabled": false }'
```

### "Did the platform actually pull that image?"

The `custom_deployment_image_audit` table records every distinct
`(deployment_id, image, resolvedDigest)` triple as the kubelet
reports it. To inspect:

```sql
SELECT deployment_id, image, resolved_digest, pulled_at
FROM custom_deployment_image_audit
WHERE deployment_id = '<id>'
ORDER BY pulled_at DESC;
```

A NULL `resolved_digest` means "kubelet has not yet finished pulling"
(sentinel row, unique per deployment via `NULLS NOT DISTINCT`).

### "How do I see which custom deployments a tenant has?"

```sql
SELECT id, name, status, source, custom_spec->'services' AS services
FROM deployments
WHERE client_id = '<client-id>' AND source = 'custom';
```

Or via the admin panel: Client detail → Deployments tab → switch the
source filter chip to "Custom".

## Initial rollout

### Apply migrations (one-time)

Migrations land via the standard `npm run db:migrate` path. The two
PR-1 migrations are:

- `0098_custom_deployments.sql` — discriminator + 3 sibling tables.
  Adds 4 sequential `AccessExclusiveLock` acquisitions on the `deployments`
  table.
- `0099_system_settings_custom_deployments.sql` — 6 boolean toggles.
  Single-row table, negligible lock impact.

**For 0098, set `lock_timeout` to fail fast under contention** (the
migration's header has the same advice):

```sql
SET lock_timeout = '3s';
\i 0098_custom_deployments.sql
```

If a lock wait exceeds 3s, the DDL fails with SQLSTATE `55P03` and
you retry. The alternative — queueing behind a long transaction —
stalls every API request that hits the `deployments` table for the
duration of the wait.

### Backfill PSS labels on existing tenant namespaces

`applyNamespace()` patches PSS labels on every provisioning touch, but
existing tenants only converge when their namespace is next touched
(deployment create / delete / quota change). To force convergence:

```bash
# Dry-run preview — lists any pod that would VIOLATE PSS baseline:
./scripts/backfill-tenant-namespace-pss.sh

# Apply labels (refuses if violators present):
./scripts/backfill-tenant-namespace-pss.sh --apply

# Apply DESPITE violators — running pods keep running, new pods
# matching baseline-violating securityContext are rejected:
./scripts/backfill-tenant-namespace-pss.sh --apply --force
```

The script enumerates pods in BOTH `containers` and `initContainers`
(PR-1 H-3 fix). It runs against any cluster reachable via the
default `kubectl` context.

## Day-2 operations

### "A deployment is stuck in `deploying`"

Most likely causes (in order):

1. **`ImagePullBackOff`** — image typo, private-registry without PAT,
   or the registry is down. Check:
   ```bash
   kubectl describe pod -n <tenant-ns> -l app=<deployment-name>
   ```
   If the PAT exists but the pull still fails, confirm the Secret
   was materialised: `kubectl get secret -n <tenant-ns> image-pull-<id>`.
   If the Secret is missing, re-PUT the PAT via the API — the
   service throws `ENCRYPTION_KEY_MISSING` loudly rather than
   silently skipping (PR-2 H-4).

2. **PSS baseline rejection** — the validator's deny-list should
   catch this before the cluster sees it, but a hand-crafted CURL
   could slip past. Check:
   ```bash
   kubectl describe rs -n <tenant-ns> <deployment>-* | grep "violates PodSecurity"
   ```

3. **`depends_on` waiting** — compose stack dependency Pod isn't
   ready. The waiter's 60s timeout will mark the Pod failed.
   `kubectl logs -n <tenant-ns> <pod> -c wait-<dep>` shows the
   `nc -z` retry loop.

4. **Quota exhaustion** — `kubectl describe deployment` will show
   `cannot create pod, exceeded quota`.

### "I need to revoke a tenant's PAT immediately"

Either:

```bash
# API path (preferred — also deletes the k8s Secret):
curl -X DELETE /api/v1/clients/<cid>/custom-deployments/<id>/pull-credentials \
  -H "Authorization: Bearer $TOKEN"
```

Or directly via SQL + manual Secret delete:

```sql
DELETE FROM custom_deployment_image_credentials WHERE deployment_id = '<id>';
```
```bash
kubectl delete secret -n <tenant-ns> image-pull-<id>
```

Pods running with cached image continue running; the NEXT pull (e.g.
after a node reboot) will fail with `ImagePullBackOff`.

### "A tenant's custom deployment is OOMKilling the node"

The validator caps memory limits at 1.5× request when not explicit
(PR-2). To clamp harder for a specific tenant, edit their `customSpec`
JSONB directly and restart:

```sql
UPDATE deployments
SET custom_spec = jsonb_set(
  custom_spec,
  '{services,web,resources,memoryLimit}',
  '"256Mi"'
)
WHERE id = '<id>';
```

Then `PATCH … {"restart": true}` to redeploy.

### "A tenant image needs to run as root (uid 0)"

By default `runAsNonRoot: true` is enforced in the Pod security context. If an
image cannot be rebuilt and must run as uid 0, a `super_admin` can grant the
exception via the admin-only endpoint:

```bash
# Grant
curl -X PATCH /api/v1/admin/clients/<cid>/custom-deployments/<id>/allow-root \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"allowRoot": true}'

# Revoke
curl -X PATCH /api/v1/admin/clients/<cid>/custom-deployments/<id>/allow-root \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"allowRoot": false}'
```

This flips the `allowRoot` field in the stored `customSpec`. The next
reconcile cycle applies the change (you can force it with a `POST …/restart`).

> **Security note:** `allowRoot` only disables `runAsNonRoot`; PSS
> `baseline`, `NetworkPolicy`, and `ResourceQuota` remain active. The
> residual risk is contained within the tenant namespace.

The admin panel's **Deployments** tab shows a **Root OFF / Root ON** toggle for
`source='custom'` rows — visible only to `super_admin` sessions.

## Backup + lifecycle

Custom deployments are covered by the existing fabric — **no new
BundleComponent or lifecycle hook was required**:

- **ADR-035 backup coverage** — the `config` BundleComponent dumps
  every row from the `deployments` table, which includes `custom_spec`.
  The `files` BundleComponent covers the entire tenant PVC, including
  the `custom/<deployment>/<volume>` subPaths. Tenant Backup v2's
  CI audit (`scripts/ci-tenant-bundles-resource-audit.sh`) was run
  against PR-1 and confirmed no missing coverage.
- **ADR-033 lifecycle hooks** — `db-deployments` operates on the
  `deployments` table by `clientId`, so all five transitions
  (`active` / `suspended` / `archived` / `restored` / `deleted`)
  transparently cover custom rows. `integration-lifecycle-e2e.sh`
  has a custom-row scenario from PR-5.

  > **`deleted` transition note:** Unlike catalog deployments, there is no
  > dedicated `LifecycleHook` for custom deployment teardown. Kubernetes
  > resource cleanup (Deployments, Services, PVC subPaths) is handled by the
  > platform reconciler's `deleteCustomDeploymentResources()` path, which
  > label-sweeps everything owned by `platform.phoenix-host.net/deployment-id`.
  > The ADR-033 `db-deployments` hook removes the DB row on `deleted`.
  > No manual cleanup is needed beyond `DELETE /custom-deployments/:id`.

## Threat model

The defining design decision is: **the platform's defense is
Pod isolation, not image trust**. ADR-036 §user-confirmed image-trust
trade-offs lists exactly what we accept; this section translates
that into operator-facing guidance.

### Accepted residual risks

| Risk | Why we accept it | Mitigation |
|------|------------------|------------|
| Typosquat / malicious image | No registry allowlist (user override) | PSS baseline + NetworkPolicy + Quota contain blast radius |
| `:latest` silently changes | No image-pin requirement (user override) | Advisory badge in UI; warn-toggle to suppress |
| PAT custody / leak | Encrypted at rest + never returned in API; HTTPS-only registry probe; SSRF-guarded auth realm | Audit log of every materialisation; rotate via PUT |
| Tenant pulls from hostile registry | No registry allowlist | `WWW-Authenticate` realm blocked at RFC-1918 / IMDS / `.svc` / `.local` |

### Indicators worth alerting on

Add Prometheus / Grafana alerts (post-PR-5) for:

- `rate(deployments_failed_total{source="custom"}[5m])` exceeds
  baseline — a wave of failures often means a registry incident.
- New row appearing in `custom_deployment_image_audit` with a digest
  matching a known-bad list (operator-curated; integrate with your
  SOC tooling).
- `custom_deployment_image_check_cache` row with `severity='major'`
  not acted on for >7 days — major-version updates often carry
  security fixes.

## CI guards

Two CI checks gate this feature:

- **`scripts/ci-tenant-bundles-resource-audit.sh`** — fails if a new
  table is added without a backup decision (custom-deployments PRs
  documented "no new BundleComponent needed").
- **(no new guard added in Phase 1)** — Phase-2 plans a guard that
  enforces every new tenant-facing custom-deployment field is
  documented in the JSON Schema at `/compose-schema`, to prevent
  parser/schema drift.

## See also

- [ADR-036](../07-reference/ADR-036-custom-deployments.md) — architectural decisions, threat model, trade-offs
- [CUSTOM_CONTAINERS_USER_GUIDE.md](../03-features/CUSTOM_CONTAINERS_USER_GUIDE.md) — tenant-facing usage guide
- `scripts/integration-custom-deployments.sh` — E2E harness
- `scripts/backfill-tenant-namespace-pss.sh` — PSS label backfill
