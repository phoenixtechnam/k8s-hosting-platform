# Stalwart 0.16 Deployment Runbook

This document covers deployment, bootstrap, backup, and migration for the
Stalwart 0.16 mail server layer (Cut 2 of the mail rearchitecture).

## Resource Requirements

| Component | CPU request | CPU limit | Memory request | Memory limit | Storage |
|-----------|------------|-----------|----------------|--------------|---------|
| mail-pg (CNPG, single) | 50m | 200m | 256Mi | 512Mi | 5Gi (longhorn) |
| stalwart-mail-v016 | 100m | 1000m | 128Mi | 512Mi | none (DB-backed) |
| stalwart-v016-bootstrap (Job, transient) | 100m | 500m | 64Mi | 128Mi | none |

Total steady-state overhead: ~150m CPU, ~400Mi RAM, 5Gi disk.

Production sizing recommendation: bump mail-pg limits to 512Mi/500m CPU;
Stalwart to 256Mi/2000m CPU for clusters with 10+ active domains.

## Bootstrap Flow

Bootstrap is driven by `scripts/bootstrap.sh`. The Stalwart 0.16 step
(`bootstrap_stalwart_v016`) runs **after** `apply_platform_manifests`.

### Step-by-step

1. `generate_platform_secrets` creates `mail-pg-app-credentials` Secret in
   namespace `mail` (username: `stalwart_app`, random password).

2. `apply_platform_manifests` applies the env overlay (which must include
   `k8s/overlays/dev/stalwart-v016/` or the equivalent production path).
   Flux/kubectl creates: CNPG Cluster `mail-pg`, Stalwart Deployment,
   Services, Ingress, bootstrap Job (suspended).

3. `bootstrap_stalwart_v016`:
   - Waits for `mail-pg` CNPG Cluster → Ready (up to 300s)
   - Waits for `stalwart-mail-v016` Deployment rollout (up to 300s)
   - Probes `/jmap/session` on the Stalwart pod via `kubectl exec`
   - **If JMAP 200**: Stalwart is already in full mode → skip.
   - **If JMAP non-200** (bootstrap mode):
     - Generates `stalwart-admin-creds` Secret (adminPassword + recoveryPassword)
     - Renders bootstrap plan from `stalwart-v016-bootstrap-plan` ConfigMap
       (substitutes STALWART_HOSTNAME, STALWART_DOMAIN, STALWART_ADMIN_PASSWORD,
       DKIM private key)
     - Writes rendered plan to `stalwart-bootstrap-plan` Secret
     - Patches `stalwart-v016-bootstrap` Job `spec.suspend = false`
     - Waits for Job completion (up to 300s)
     - `kubectl rollout restart` on the Deployment
     - Verifies `/jmap/session` returns 200 on the new pod

4. `bundle_bootstrap_secrets` captures `mail-pg-app-credentials` and
   `stalwart-admin-creds` in the Tier-1 bundle.

### Idempotency

Re-running `bootstrap.sh` is safe:
- `mail-pg-app-credentials` is skipped if it already exists.
- `stalwart-admin-creds` is skipped if it exists AND `/jmap/session` returns 200.
- The bootstrap Job is only re-run if Stalwart is in bootstrap mode.

## Manual Recovery

If bootstrap fails mid-way:

### Case 1: mail-pg never became Ready

```bash
kubectl describe cluster mail-pg -n mail
kubectl describe pvc -n mail
# Common cause: CNPG operator not installed, or mail-pg-app-credentials missing.
kubectl get secret -n mail mail-pg-app-credentials
# If missing:
kubectl create secret generic mail-pg-app-credentials \
  --namespace=mail \
  --from-literal=username=stalwart_app \
  --from-literal=password=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
```

### Case 2: Bootstrap Job failed

```bash
# Check logs
kubectl logs -n mail -l app.kubernetes.io/component=mail-bootstrap
# Delete the failed Job and re-trigger bootstrap
kubectl delete job stalwart-v016-bootstrap -n mail
# Re-run bootstrap.sh, or manually:
kubectl apply -k k8s/overlays/dev/stalwart-v016/   # re-creates the Job (suspended)
kubectl patch job stalwart-v016-bootstrap -n mail -p '{"spec":{"suspend":false}}'
kubectl wait --for=condition=complete job/stalwart-v016-bootstrap -n mail --timeout=300s
kubectl rollout restart -n mail deploy/stalwart-mail-v016
```

### Case 3: Stalwart stuck in bootstrap mode after Job completion

```bash
kubectl rollout restart -n mail deploy/stalwart-mail-v016
kubectl rollout status -n mail deploy/stalwart-mail-v016
# Verify:
POD=$(kubectl get pod -n mail -l app=stalwart-mail-v016 -o name | head -1)
kubectl exec -n mail $POD -- wget -qO- http://localhost:8080/jmap/session
```

### Case 4: Forgotten admin password

```bash
# On the bootstrap host:
cat /etc/platform/stalwart-v016-credentials
# Or from the cluster:
kubectl get secret -n mail stalwart-admin-creds -o jsonpath='{.data.adminPassword}' | base64 -d
```

## Migrating FROM Stalwart 0.15

Stalwart provides official migration tooling. This platform does not replicate
that logic — follow the upstream guide:

  https://stalw.art/docs/migration/0.16

The recommended approach:
1. Export all data from the 0.15 StatefulSet using `stalwart-cli export`.
2. Deploy Stalwart 0.16 with a clean DB (this runbook's flow).
3. Import the export into 0.16 using `stalwart-cli import`.
4. Verify DNS records (DKIM, SPF, MX) via the dns-sync scheduler.
5. Cut over MX DNS once verified.
6. Disable/delete the 0.15 StatefulSet (`k8s/base/stalwart/`).

The 0.15 StatefulSet remains intact until Cut 3 of the mail rearchitecture.
Do NOT delete it until the migration + cutover is complete.

## Backup and Restore

### CNPG logical backup (mail-pg ScheduledBackup)

- Schedule: daily 03:15 UTC (see `mail-pg/scheduled-backup.yaml`)
- Prerequisite: an active S3 backup config in the admin panel AND barman
  section uncommented in `mail-pg/cluster.yaml` (disabled by default).
- S3 path: `s3://<bucket>/mail/mail-pg/` (prefix `mail/` isolates from
  platform-PG's `platform/` prefix).
- Retention: 7 days (CNPG `retentionPolicy`).

To enable barman backups:
1. Activate an S3 backup config in Admin Panel → System → Backup.
2. Uncomment the `backup.barmanObjectStore` section in `cluster.yaml`.
3. Apply the overlay: `kubectl apply -k k8s/overlays/<env>/stalwart-v016/`.

### Longhorn block backup (mail-pg PVCs)

CNPG-managed PVCs labelled `cnpg.io/cluster=mail-pg` are picked up by the
platform-storage-policy reconciler and tracked in the Storage Operations card.
Longhorn recurring-job-group labels apply when the overlay opts in.

### Restore

For a full restore from CNPG backup:
```bash
# Use CNPG's bootstrap.recovery mechanism — create a new Cluster CR
# referencing the backup as the recovery source.
# See: https://cloudnative-pg.io/documentation/1.22/recovery/
```

For point-in-time recovery from Longhorn snapshot:
See `docs/05-storage/HA_MODE.md` and the Longhorn UI.
