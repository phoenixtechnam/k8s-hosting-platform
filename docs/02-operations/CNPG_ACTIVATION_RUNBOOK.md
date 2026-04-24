# CloudNative-PG (CNPG) Activation Runbook (M10)

Runbook for flipping platform Postgres from a single-StatefulSet
topology to an active-passive CNPG Cluster. Applies **only when the
cluster is at 3+ server nodes** (M8 has landed) and HA is actually
worth the complexity.

Referenced from ADR-031 §7. The operator is already installed passive
via `bootstrap.sh install_cnpg` — no platform components depend on it
until a `Cluster` CR is applied. Activation is a controlled operator
step, not a push-to-main.

## Before you start

Pre-requisites (none are automated — this is a "do it yourself"
operation with review gates):

- **3+ server nodes** labelled `platform.phoenix-host.net/node-role=server`.
  `kubectl get nodes -L platform.phoenix-host.net/node-role` should
  show at least 3 `server` rows, all Ready.
- **Longhorn system-ha StorageClass** available (check
  `kubectl get sc longhorn-system-ha`). CNPG will provision replica
  PVCs against this class — 3 replicas per volume.
- **Fresh pg_dump** of the current platform database, stored off-
  cluster. The activation flow imports from the existing PVC but a
  dump is the rollback safety net.
- **~15 minutes of planned downtime** for the Postgres cutover. Admin
  API + panels will return 503 during the switch. Announce to clients.
- **Monitoring** in place — at minimum, a Grafana panel showing
  Postgres replication lag and leader identity. Check
  `kubectl get pods -n cnpg-system` before starting; operator must be
  Running.

## Steps

### 1. Dump platform Postgres off-cluster

```bash
ssh root@<control-plane>
kubectl -n platform exec postgres-0 -- \
  pg_dump -U platform hosting_platform \
  | gzip > /root/platform-pg-pre-cnpg-$(date -u +%Y%m%dT%H%MZ).sql.gz
scp /root/platform-pg-pre-cnpg-*.sql.gz  operator-workstation:/safe/place/
```

Verify the dump file size is non-trivial (>100KB for a populated DB).

### 2. Scale down the existing StatefulSet

This is the start of the downtime window.

```bash
kubectl -n platform scale statefulset postgres --replicas=0
kubectl -n platform wait --for=delete pod/postgres-0 --timeout=120s
```

### 3. Apply the Cluster CR

Use the manifest at `k8s/base/cnpg-cluster.yaml` (to be added when
M10 activation actually happens — do not apply this manifest
currently). Example shape:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: platform-pg
  namespace: platform
spec:
  instances: 3                  # 1 primary + 2 standby
  imageName: ghcr.io/cloudnative-pg/postgresql:16
  storage:
    size: 10Gi
    storageClass: longhorn-system-ha
  bootstrap:
    recovery:                   # import from the old StatefulSet's PVC
      source: platform-pg-pvc
  externalClusters:
    - name: platform-pg-pvc
      # details vary — see CNPG docs for "import existing data from
      # unsupported-provisioner PVC"; typically via `pg_basebackup`
      # against a temporary read-only pg12/pg16 instance mounted on
      # the original PVC.
  postgresql:
    parameters:
      shared_buffers: "256MB"
      effective_cache_size: "1GB"
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: platform.phoenix-host.net/node-role
                operator: In
                values: [server]
    topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: DoNotSchedule
```

Apply and wait:

```bash
kubectl apply -f platform-pg-cluster.yaml
kubectl -n platform wait --for=condition=Ready cluster/platform-pg --timeout=600s
```

### 4. Update the platform-api DATABASE_URL

The CNPG Cluster exposes a Service named `<cluster>-rw` (writes to
primary) and `<cluster>-ro` (reads from any replica). platform-api
should point at `-rw`:

```bash
kubectl -n platform set env deploy/platform-api \
  DATABASE_URL="postgres://platform:<password>@platform-pg-rw.platform.svc:5432/hosting_platform"
```

(Credential rotation: the CNPG operator generates a fresh
`platform-pg-app` Secret; read it, update the platform-secrets
Secret, and restart the deploy. `<password>` can be `kubectl -n
platform get secret platform-pg-app -o jsonpath='{.data.password}' |
base64 -d`.)

### 5. Verify

```bash
kubectl -n platform get cluster platform-pg -o yaml | yq .status
kubectl -n platform exec platform-api-xxxxx -- \
  psql "${DATABASE_URL}" -c '\dt'   # confirm tables visible
```

Hit the admin API:

```bash
curl -H "Authorization: Bearer ${TOKEN}" \
  https://admin.phoenix-host.net/api/v1/admin/clients
```

### 6. Decommission the old StatefulSet

Only after 24h of stable runtime against CNPG:

```bash
kubectl -n platform delete statefulset postgres      # empty already
kubectl -n platform delete pvc data-postgres-0        # releases old storage
```

## Rollback

If anything goes wrong between step 3 and step 5:

1. Delete the Cluster CR: `kubectl -n platform delete cluster platform-pg`
2. Scale the old StatefulSet back: `kubectl -n platform scale statefulset postgres --replicas=1`
3. If data corrupted: restore from the dump via
   `gunzip < platform-pg-pre-cnpg-*.sql.gz | psql -U platform`.
4. Update platform-api DATABASE_URL back to
   `postgres-rw.platform.svc:5432` (or whatever the old Service was).

## Known gotchas

- **CNPG volume reclaim** — the operator creates its own PVCs. The
  old StatefulSet PVC is NOT reused; data is imported via recovery.
  Plan for 2× storage during cutover.
- **Primary failover is not instant** — CNPG takes ~30s to promote a
  standby. platform-api connections hang during the failover. Add
  `connect_timeout=5` to the DATABASE_URL to fail fast and let the
  Fastify retry middleware handle it.
- **Longhorn replicaCount=3 vs CNPG instances=3 interaction** — CNPG
  runs 3 logical replicas, each backed by a Longhorn volume that's
  itself 3-replicated. Net 9× storage overhead. For a platform
  database that's <1GB this is fine; if the DB grows past 10GB
  consider dropping Longhorn replicaCount to 2 for CNPG volumes.

## When NOT to activate

- Single-server cluster. CNPG with instances=1 is just a more
  complicated StatefulSet.
- Cluster running at <70% RAM utilization but >70% disk. CNPG doubles
  disk usage during cutover (import phase); don't do it with <50%
  free disk.
- You haven't run a pg_dump recovery drill against a scratch DB in
  the last 3 months. The runbook above assumes the dump is known
  good.
