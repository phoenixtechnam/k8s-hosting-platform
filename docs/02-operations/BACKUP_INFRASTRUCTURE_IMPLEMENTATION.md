# Backup Infrastructure Implementation

**Status:** Phase 1 Implementation  
**Last Updated:** March 3, 2026  
**Owner:** Infrastructure Team

## Overview

Technical implementation details for encrypted offsite backup system with per-customer folder structure, database dumps, and settings export.

### Prerequisites

**FUSE device plugin** must be installed on all cluster nodes before deploying backup CronJobs. The backup containers use SSHFS (FUSE-based) to mount the offsite backup server without running as a privileged container.

```bash
# Install the FUSE device plugin DaemonSet (one-time, per cluster)
kubectl apply -f https://raw.githubusercontent.com/kubeflow/kubeflow/master/components/k8s-fuse-device-plugin/fuse-device-plugin.yaml

# Verify the plugin pod is Running on all nodes
kubectl -n kube-system get pods -l name=fuse-device-plugin -o wide
# Expected: one pod per worker node, STATUS: Running

# Verify the FUSE device is schedulable
kubectl get nodes -o json | jq '.items[].status.allocatable["github.com/fuse"]'
# Expected: "1" per node
```

The FUSE device plugin exposes `/dev/fuse` as a Kubernetes device resource (`github.com/fuse`). Backup CronJobs request this resource instead of running `privileged: true`. This maintains the platform security hardening policy (no privileged containers in production).

**Offsite backup server:** The backup server is accessed via plain SSH — it does not need to be on the NetBird mesh. A dedicated SSH keypair is generated for the backup service account and stored as a Sealed Secret. Hetzner StorageBox and any standard SSH-accessible storage server are supported. See the _Offsite Backup Transport_ section for configuration.

---

## System Architecture

### Component Diagram

```
┌─────────────────────────────────────┐
│   Kubernetes Cluster (Platform)     │
├─────────────────────────────────────┤
│                                     │
│  ┌──────────────────────────────┐   │
│  │ Backup CronJob (2 AM UTC)    │   │
│  │                              │   │
│  │ 1. Mount offsite via SSHFS   │   │
│  │ 2. Database dumps → mount    │   │
│  │ 3. File backup → mount       │   │
│  │ 4. Config export → mount     │   │
│  │ 5. Encrypt in-place          │   │
│  │ 6. Unmount SSHFS             │   │
│  └──────────────────────────────┘   │
│                                     │
│  ┌──────────────────────────────┐   │
│  │ Longhorn PV (Local Storage)  │   │
│  │ • Media / branding assets    │   │
│  │ • Staging area (temp data)   │   │
│  └──────────────────────────────┘   │
│                                     │
└─────────────────────────────────────┘
        │ SSHFS mount via NetBird mesh
        ▼
┌─────────────────────────────────────┐
│ Offsite Backup Server               │
│ (External provider, accessed via    │
│  NetBird WireGuard mesh — not       │
│  exposed on public internet)        │
├─────────────────────────────────────┤
│                                     │
│ /backups/                           │
│ ├── daily/                          │
│ │   ├── 2026-03-07/                 │
│ │   │   ├── databases/              │
│ │   │   │   ├── client-acme-corp/   │
│ │   │   │   │   ├── db1.sql.gz.enc  │
│ │   │   │   │   └── db2.sql.gz.enc  │
│ │   │   │   └── client-beta/        │
│ │   │   ├── files/                  │
│ │   │   │   ├── client-acme-corp/   │
│ │   │   │   └── client-beta/        │
│ │   │   ├── config/                 │
│ │   │   │   ├── client-acme-corp/   │
│ │   │   │   │   └── metadata.json   │
│ │   │   │   └── client-beta/        │
│ │   │   └── velero/                 │
│ │   ├── 2026-03-06/                 │
│ │   └── ...                         │
│ └── retention managed by cleanup    │
│                                     │
│ Encryption: AES-256-CBC             │
│ Mount: on-demand (SSHFS)            │
│ Local disk: zero (unmounted)        │
│                                     │
└─────────────────────────────────────┘
```

---

## Database Backup Implementation

### CronJob: MariaDB Database Dumps

```yaml
# kubernetes/backup-jobs/mariadb-backup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: mariadb-backup
  namespace: platform
spec:
  # Run daily at 2 AM UTC
  schedule: "0 2 * * *"
  
  # Keep 3 successful backups, 1 failed
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  
  jobTemplate:
    spec:
      backoffLimit: 3
      template:
        spec:
          serviceAccountName: backup-sa
          containers:
          - name: mariadb-backup
            image: mariadb:10.6-alpine
            command:
            - /bin/sh
            - -c
            - |
              set -e
              
              DATE=$(date +%Y%m%d)
              MOUNT_POINT="/mnt/offsite"
              BACKUP_PATH="${MOUNT_POINT}/daily/${DATE}/databases"
              
              # Mount offsite backup server via SSHFS (NetBird mesh)
              mkdir -p "${MOUNT_POINT}"
              sshfs backup@backup-server:/backups "${MOUNT_POINT}" \
                -o IdentityFile=/tmp/id_rsa,reconnect,ServerAliveInterval=15
              trap 'fusermount -u ${MOUNT_POINT} 2>/dev/null' EXIT
              
              mkdir -p "${BACKUP_PATH}"
              
              # Get all databases from each customer namespace
              for NAMESPACE in $(kubectl get ns -l tenant=true -o jsonpath='{.items[*].metadata.name}'); do
                CUSTOMER_ID="${NAMESPACE}"
                
                echo "Backing up databases for ${CUSTOMER_ID}..."
                
                # Create customer backup directory on offsite mount
                CUSTOMER_DIR="${BACKUP_PATH}/${CUSTOMER_ID}"
                mkdir -p "${CUSTOMER_DIR}"
                
                # Get all databases for this customer (from MariaDB)
                DATABASES=$(mysql -h mariadb.platform.svc -u backup_user \
                  -p$BACKUP_USER_PASSWORD \
                  -e "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA \
                      WHERE SCHEMA_NAME LIKE '${CUSTOMER_ID}_%'" \
                  -s -N)
                
                # Dump each database directly to offsite mount
                for DB in $DATABASES; do
                  echo "  Dumping ${DB}..."
                  
                  # Get workload ID from database name pattern
                  WORKLOAD_ID=$(echo $DB | sed "s/${CUSTOMER_ID}_//" | cut -d_ -f1-2)
                  
                  WORKLOAD_DIR="${CUSTOMER_DIR}/${WORKLOAD_ID}"
                  mkdir -p "${WORKLOAD_DIR}"
                  
                  # Dump database with all procedures, triggers, routines
                  mysqldump \
                    -h mariadb.platform.svc \
                    -u backup_user \
                    -p$BACKUP_USER_PASSWORD \
                    --single-transaction \
                    --routines \
                    --triggers \
                    --events \
                    --quick \
                    --lock-tables=false \
                    "${DB}" | \
                    gzip > "${WORKLOAD_DIR}/${DB}.sql.gz"
                  
                  # Store backup info
                  SIZE=$(du -h "${WORKLOAD_DIR}/${DB}.sql.gz" | cut -f1)
                  echo "    ✓ ${DB} (${SIZE})"
                done
              done
              
              echo "✓ All database backups written to offsite mount"
            
            env:
            - name: BACKUP_USER_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: backup-credentials
                  key: mariadb-password
            
            resources:
              requests:
                memory: "1Gi"
                cpu: "500m"
              limits:
                memory: "4Gi"
                cpu: "2"
          
          restartPolicy: OnFailure
```

### CronJob: PostgreSQL Database Dumps

```yaml
# kubernetes/backup-jobs/postgresql-backup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: postgresql-backup
  namespace: platform
spec:
  schedule: "0 2 * * *"
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: backup-sa
          containers:
          - name: postgresql-backup
            image: postgres:16-alpine
            command:
            - /bin/sh
            - -c
            - |
              set -e
              
              DATE=$(date +%Y%m%d)
              MOUNT_POINT="/mnt/offsite"
              BACKUP_PATH="${MOUNT_POINT}/daily/${DATE}/databases"
              
              # Mount offsite backup server via SSHFS (NetBird mesh)
              mkdir -p "${MOUNT_POINT}"
              sshfs backup@backup-server:/backups "${MOUNT_POINT}" \
                -o IdentityFile=/tmp/id_rsa,reconnect,ServerAliveInterval=15
              trap 'fusermount -u ${MOUNT_POINT} 2>/dev/null' EXIT
              
              mkdir -p "${BACKUP_PATH}"
              
              # Similar structure to MariaDB
              # Using pg_dump instead of mysqldump
              # With custom format for better restoration options
              # Writes directly to offsite mount — no local disk consumed
              
              pg_dump \
                -h postgresql.platform.svc \
                -U backup_user \
                -Fc \
                --include-foreign-keys \
                -Z 9 \
                DATABASE_NAME > "${BACKUP_PATH}/DATABASE_NAME.dump"
          
          restartPolicy: OnFailure
```

---

## File Backup Implementation

### CronJob: Workload File Backups

```yaml
# kubernetes/backup-jobs/file-backup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: file-backup
  namespace: platform
spec:
  schedule: "0 3 * * *"  # 3 AM UTC
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: backup-sa
          containers:
          - name: file-backup
            image: ubuntu:22.04
            command:
            - /bin/bash
            - -c
            - |
              set -euo pipefail
              
              apt-get update -qq && apt-get install -y -qq \
                sshfs openssh-client rsync fuse > /dev/null
              
              DATE=$(date +%Y%m%d)
              MOUNT_POINT="/mnt/offsite"
              BACKUP_PATH="${MOUNT_POINT}/daily/${DATE}/files"
              
              # Mount offsite backup server via SSHFS (NetBird mesh)
              mkdir -p "${MOUNT_POINT}"
              sshfs backup@backup-server:/backups "${MOUNT_POINT}" \
                -o IdentityFile=/tmp/id_rsa,reconnect,ServerAliveInterval=15
              trap 'fusermount -u ${MOUNT_POINT} 2>/dev/null' EXIT
              
              mkdir -p "${BACKUP_PATH}"
              
              # For each customer workload — rsync directly to offsite mount
              for CUSTOMER_DIR in /mnt/customer-data/*/; do
                CUSTOMER_ID=$(basename "${CUSTOMER_DIR}")
                DEST="${BACKUP_PATH}/${CUSTOMER_ID}"
                mkdir -p "${DEST}"
                
                for WORKLOAD_DIR in "${CUSTOMER_DIR}"*/; do
                  WORKLOAD_ID=$(basename "${WORKLOAD_DIR}")
                  
                  echo "Backing up ${CUSTOMER_ID}/${WORKLOAD_ID}..."
                  
                  # rsync --archive preserves permissions, timestamps, symlinks
                  # Writes directly to offsite mount — no local disk consumed
                  rsync --archive --delete \
                    "${WORKLOAD_DIR}" \
                    "${DEST}/${WORKLOAD_ID}/"
                  
                  SIZE=$(du -sh "${DEST}/${WORKLOAD_ID}/" | cut -f1)
                  echo "  ✓ ${WORKLOAD_ID} (${SIZE})"
                done
              done
              
              echo "✓ All file backups written to offsite mount (plain filesystem)"
          
          volumes:
          - name: customer-data
            hostPath:
              path: /mnt/customer-data
          
          restartPolicy: OnFailure
```

---

## Configuration & Settings Export

### CronJob: Export Customer Settings

```yaml
# kubernetes/backup-jobs/config-export-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: config-export
  namespace: platform
spec:
  schedule: "0 6 * * *"  # 6 AM UTC
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: backup-sa
          containers:
          - name: config-export
            image: bitnami/kubectl:latest
            command:
            - /bin/sh
            - -c
            - |
              set -e
              
              BACKUP_DIR="/tmp/backups"
              
              # Export metadata for each customer
              for CUSTOMER_ID in $(kubectl get clients -o jsonpath='{.items[*].metadata.name}'); do
                echo "Exporting config for ${CUSTOMER_ID}..."
                
                CUSTOMER_DIR="${BACKUP_DIR}/customers/${CUSTOMER_ID}"
                mkdir -p "${CUSTOMER_DIR}"
                
                # Export customer details
                kubectl get client ${CUSTOMER_ID} -o json | \
                  jq 'del(.metadata.managedFields)' > \
                  "${CUSTOMER_DIR}/customer.json"
                
                # Export workloads
                kubectl get workloads -l client=${CUSTOMER_ID} -o json | \
                  jq '.items[] | del(.metadata.managedFields)' > \
                  "${CUSTOMER_DIR}/workloads.json"
                
                # Export databases
                kubectl get databases -l client=${CUSTOMER_ID} -o json | \
                  jq '.items[] | del(.metadata.managedFields)' > \
                  "${CUSTOMER_DIR}/databases.json"
                
                # Export domains
                kubectl get domains -l client=${CUSTOMER_ID} -o json | \
                  jq '.items[] | del(.metadata.managedFields)' > \
                  "${CUSTOMER_DIR}/domains.json"
                
                # Build comprehensive metadata.json
                python3 << 'EOF'
                import json
                import os
                from datetime import datetime
                
                customer_id = os.environ.get('CUSTOMER_ID', '')
                backup_dir = f"/tmp/backups/customers/{customer_id}"
                
                metadata = {
                  "backup_timestamp": datetime.utcnow().isoformat() + "Z",
                  "version": "1.0",
                  "customer": json.load(open(f"{backup_dir}/customer.json")),
                  "workloads": [json.loads(line) for line in 
                                open(f"{backup_dir}/workloads.json")],
                  "databases": [json.loads(line) for line in 
                                open(f"{backup_dir}/databases.json")],
                  "domains": [json.loads(line) for line in 
                              open(f"{backup_dir}/domains.json")]
                }
                
                with open(f"{backup_dir}/metadata.json", "w") as f:
                  json.dump(metadata, f, indent=2)
                
                print(f"✓ Created metadata.json for {customer_id}")
                EOF
              done
          
          restartPolicy: OnFailure
```

---

## Encryption & Archive Creation

### CronJob: Encrypt & Package Backups

```yaml
# kubernetes/backup-jobs/backup-encrypt-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: backup-encrypt
  namespace: platform
spec:
  schedule: "0 7 * * *"  # 7 AM UTC (after all backups)
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: backup-sa
          containers:
          - name: backup-encrypt
            image: ubuntu:20.04
            command:
            - /bin/bash
            - -c
            - |
              apt-get update && apt-get install -y \
                openssl curl jq python3
              
              MOUNT_POINT="/mnt/offsite"
              DATE=$(date +%Y%m%d)
              
              # Iterate through each customer backup
              for CUSTOMER_DIR in "${BACKUP_DIR}/customers"/*/; do
                CUSTOMER_ID=$(basename "${CUSTOMER_DIR}")
                
                echo "Encrypting backup for ${CUSTOMER_ID}..."
                
                # Retrieve encryption password from Sealed Secrets
                ENCRYPTION_PASSWORD=$(kubectl get secret \
                  -n platform \
                  "backup-password-${CUSTOMER_ID}" \
                  -o jsonpath='{.data.password}' | \
                  base64 --decode)
                
                # Create encrypted tar.gz archive
                tar -czf - "${CUSTOMER_DIR}" | \
                  openssl enc -aes-256-cbc \
                    -S $(openssl rand -hex 8) \
                    -pass pass:"${ENCRYPTION_PASSWORD}" \
                    -out "${BACKUP_DIR}/${CUSTOMER_ID}-${DATE}.tar.gz.enc"
                
                # Calculate checksum
                CHECKSUM=$(sha256sum \
                  "${BACKUP_DIR}/${CUSTOMER_ID}-${DATE}.tar.gz.enc" | \
                  cut -d' ' -f1)
                
                # Store checksum in metadata
                python3 << EOF
                import json
                
                metadata_file = "${CUSTOMER_DIR}/metadata.json"
                with open(metadata_file, 'r') as f:
                  metadata = json.load(f)
                
                metadata['backup_integrity']['checksum_sha256'] = "${CHECKSUM}"
                
                with open(metadata_file, 'w') as f:
                  json.dump(metadata, f, indent=2)
                EOF
                
                echo "  ✓ Encrypted ${CUSTOMER_ID}"
              done
              
              echo "✓ All backups encrypted"
          
          restartPolicy: OnFailure
```

---

## Offsite Backup Implementation (SSHFS Mount-Based)

The offsite backup uses **SSHFS mount-on-demand**: the backup CronJob mounts the external backup
server as a local filesystem, writes backups directly to it, then unmounts when done. This avoids
storing a second copy of all backups locally, conserving cluster disk space.

The backup server is accessed via **NetBird WireGuard mesh** — SSH is not exposed on the public internet.

### CronJob: Mount → Backup → Unmount

```yaml
# kubernetes/backup-jobs/offsite-backup-cronjob.yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: offsite-backup
  namespace: platform
spec:
  schedule: "0 2 * * *"  # 2 AM UTC
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          serviceAccountName: backup-sa
          securityContext:
            runAsUser: 0
          # FUSE device plugin DaemonSet must be deployed on all nodes.
          # Install once per cluster:
          #   kubectl apply -f https://raw.githubusercontent.com/kubeflow/kubeflow/master/components/k8s-fuse-device-plugin/fuse-device-plugin.yaml
          # This exposes /dev/fuse as a schedulable device resource (github.com/fuse/fuse).
          # The plugin runs as a DaemonSet in kube-system and requires no ongoing maintenance.
          containers:
          - name: offsite-backup
            image: ubuntu:22.04
            securityContext:
              privileged: false  # Not required when using FUSE device plugin
              allowPrivilegeEscalation: false
            resources:
              limits:
                github.com/fuse: 1  # Request FUSE device from device plugin
            command:
            - /bin/bash
            - -c
            - |
              set -euo pipefail
              
              # --- Install dependencies ---
              apt-get update -qq && apt-get install -y -qq \
                sshfs openssh-client mariadb-client postgresql-client \
                rsync openssl curl fuse > /dev/null
              
              # --- Configuration ---
              DATE=$(date +%Y-%m-%d)
              MOUNT_POINT="/mnt/offsite"
              BACKUP_PATH="${MOUNT_POINT}/daily/${DATE}"
              
              OFFSITE_HOST=$(kubectl get configmap \
                -n platform backup-config \
                -o jsonpath='{.data.offsite_host}')
              OFFSITE_USER=$(kubectl get configmap \
                -n platform backup-config \
                -o jsonpath='{.data.offsite_user}')
              OFFSITE_PATH=$(kubectl get configmap \
                -n platform backup-config \
                -o jsonpath='{.data.offsite_path}')
              
              # Extract SSH key from secret
              kubectl get secret -n platform offsite-ssh-key \
                -o jsonpath='{.data.private_key}' | \
                base64 --decode > /tmp/id_rsa
              chmod 600 /tmp/id_rsa
              
              # --- Cleanup function (always unmount) ---
              cleanup() {
                echo "[$(date)] Unmounting SSHFS..."
                fusermount -u "${MOUNT_POINT}" 2>/dev/null || true
                echo "[$(date)] Cleanup complete"
              }
              trap cleanup EXIT
              
              # --- Step 1: Mount offsite via SSHFS ---
              echo "[$(date)] Mounting offsite backup server via SSHFS..."
              mkdir -p "${MOUNT_POINT}"
              sshfs "${OFFSITE_USER}@${OFFSITE_HOST}:${OFFSITE_PATH}" \
                "${MOUNT_POINT}" \
                -o IdentityFile=/tmp/id_rsa \
                -o StrictHostKeyChecking=no \
                -o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3 \
                -o allow_other
              
              mkdir -p "${BACKUP_PATH}"/{databases,files,config,velero}
              echo "[$(date)] ✓ Mounted at ${MOUNT_POINT}"
              
              # --- Step 2: Database dumps (direct to mount) ---
              echo "[$(date)] Starting database backups..."
              
              # MariaDB: dump each client database
              MYSQL_HOST=$(kubectl get configmap -n platform db-config \
                -o jsonpath='{.data.mariadb_host}')
              MYSQL_USER=$(kubectl get secret -n platform db-credentials \
                -o jsonpath='{.data.mariadb_backup_user}' | base64 --decode)
              MYSQL_PASS=$(kubectl get secret -n platform db-credentials \
                -o jsonpath='{.data.mariadb_backup_password}' | base64 --decode)
              
              for DB in $(mysql -h "${MYSQL_HOST}" -u "${MYSQL_USER}" \
                -p"${MYSQL_PASS}" -N -e "SHOW DATABASES" | \
                grep -E "^client_"); do
                CUSTOMER_ID=$(echo "${DB}" | sed 's/^client_//')
                mkdir -p "${BACKUP_PATH}/databases/${CUSTOMER_ID}"
                mysqldump -h "${MYSQL_HOST}" -u "${MYSQL_USER}" \
                  -p"${MYSQL_PASS}" "${DB}" | \
                  gzip > "${BACKUP_PATH}/databases/${CUSTOMER_ID}/${DB}.sql.gz"
                echo "  ✓ MariaDB: ${DB}"
              done
              
              # PostgreSQL: dump each client database
              PG_HOST=$(kubectl get configmap -n platform db-config \
                -o jsonpath='{.data.postgres_host}')
              export PGPASSWORD=$(kubectl get secret -n platform db-credentials \
                -o jsonpath='{.data.postgres_backup_password}' | base64 --decode)
              PG_USER=$(kubectl get secret -n platform db-credentials \
                -o jsonpath='{.data.postgres_backup_user}' | base64 --decode)
              
              for DB in $(psql -h "${PG_HOST}" -U "${PG_USER}" -d postgres \
                -t -c "SELECT datname FROM pg_database WHERE datname LIKE 'client_%'"); do
                DB=$(echo "${DB}" | xargs)  # trim whitespace
                CUSTOMER_ID=$(echo "${DB}" | sed 's/^client_//')
                mkdir -p "${BACKUP_PATH}/databases/${CUSTOMER_ID}"
                pg_dump -h "${PG_HOST}" -U "${PG_USER}" -Fc "${DB}" \
                  > "${BACKUP_PATH}/databases/${CUSTOMER_ID}/${DB}.dump"
                echo "  ✓ PostgreSQL: ${DB}"
              done
              echo "[$(date)] ✓ Database backups complete"
              
              # --- Step 3: File backups (rsync --archive to mount) ---
              echo "[$(date)] Starting file backups..."
              mkdir -p "${BACKUP_PATH}/files"
              
              rsync --archive --delete \
                /mnt/customer-data/ \
                "${BACKUP_PATH}/files/"
              echo "[$(date)] ✓ File backups complete (plain filesystem copy)"
              
              # --- Step 4: Config export ---
              echo "[$(date)] Exporting platform config..."
              for NS in $(kubectl get namespaces -o name | grep client-); do
                CUSTOMER_ID=$(echo "${NS}" | sed 's|namespace/||')
                mkdir -p "${BACKUP_PATH}/config/${CUSTOMER_ID}"
                kubectl get all,configmaps,secrets,ingress,pvc \
                  -n "${CUSTOMER_ID}" -o json \
                  > "${BACKUP_PATH}/config/${CUSTOMER_ID}/resources.json"
                echo "  ✓ Config: ${CUSTOMER_ID}"
              done
              echo "[$(date)] ✓ Config export complete"
              
              # --- Step 5: Velero snapshot ---
              echo "[$(date)] Taking Velero snapshot..."
              velero backup create "daily-${DATE}" \
                --wait 2>/dev/null || echo "  ⚠ Velero backup skipped (not installed or failed)"
              echo "[$(date)] ✓ Velero snapshot complete"
              
              # --- Step 6: Encryption pass ---
              echo "[$(date)] Encrypting database dumps..."
              ENC_KEY=$(kubectl get secret -n platform backup-encryption \
                -o jsonpath='{.data.encryption_key}' | base64 --decode)
              find "${BACKUP_PATH}/databases" -name "*.sql.gz" -o -name "*.dump" | \
                while read -r FILE; do
                  openssl enc -aes-256-cbc -salt -pbkdf2 \
                    -in "${FILE}" -out "${FILE}.enc" -pass pass:"${ENC_KEY}"
                  rm "${FILE}"
                  echo "  ✓ Encrypted: $(basename ${FILE})"
                done
              echo "[$(date)] ✓ Encryption complete"
              
              # --- Step 7: Write checksums ---
              echo "[$(date)] Generating checksums..."
              find "${BACKUP_PATH}" -type f | while read -r FILE; do
                sha256sum "${FILE}" >> "${BACKUP_PATH}/checksums.sha256"
              done
              echo "[$(date)] ✓ Checksums written"
              
              # --- Step 8: Retention cleanup (remove backups older than policy) ---
              RETENTION_DAYS=$(kubectl get configmap -n platform backup-config \
                -o jsonpath='{.data.retention_days}' || echo "30")
              find "${MOUNT_POINT}/daily" -maxdepth 1 -type d \
                -mtime "+${RETENTION_DAYS}" -exec rm -rf {} \; 2>/dev/null || true
              echo "[$(date)] ✓ Retention cleanup done (>${RETENTION_DAYS} days removed)"
              
              # Unmount happens automatically via trap
              echo "[$(date)] ✓ Offsite backup complete"
            
            volumeMounts:
            - name: customer-data
              mountPath: /mnt/customer-data
              readOnly: true
            - name: fuse-device
              mountPath: /dev/fuse
          
          volumes:
          - name: customer-data
            hostPath:
              path: /var/lib/longhorn/  # Adjust to actual customer data path
          - name: fuse-device
            hostPath:
              path: /dev/fuse
          
          restartPolicy: OnFailure
```

**Key design decisions:**
- **SSHFS** chosen over NFS/CIFS because the backup server is accessed via NetBird mesh (SSH already available, no additional protocol needed)
- **`trap cleanup EXIT`** ensures unmount even on script failure
- **`reconnect,ServerAliveInterval`** SSHFS options handle transient network issues during long backup windows
- **Privileged container** required for FUSE mount — production hardening should use a FUSE device plugin instead
- **No local disk consumed** — all writes go directly to the mounted remote filesystem
- **Retention cleanup** runs on the remote filesystem at the end of each backup, removing old daily directories

---

## Retention Cleanup (Offsite Server)

### Cleanup Script

Retention cleanup runs as the final step of the daily backup CronJob, directly on the
SSHFS-mounted offsite filesystem. Replaces the former MinIO lifecycle policies (see ADR-015).

```bash
# Retention cleanup — runs on the mounted offsite filesystem
# Removes daily backup directories older than RETENTION_DAYS

RETENTION_DAYS=30
MOUNT_POINT="/mnt/offsite"

echo "Cleaning up backups older than ${RETENTION_DAYS} days..."
find "${MOUNT_POINT}/daily/" -maxdepth 1 -mindepth 1 -type d \
  -mtime +${RETENTION_DAYS} -exec rm -rf {} +

# Customer-created backups: per-customer retention
# Each customer has a configurable retention (7/14/30/90/365 days)
# The backup API sets expires_at on creation; cleanup script checks it
for CUSTOMER_DIR in "${MOUNT_POINT}/customer-backups"/*/; do
  CUSTOMER_ID=$(basename "${CUSTOMER_DIR}")
  # Read retention from metadata file
  RETENTION=$(cat "${CUSTOMER_DIR}/.retention_days" 2>/dev/null || echo 30)
  find "${CUSTOMER_DIR}" -maxdepth 1 -mindepth 1 -type d \
    -mtime +${RETENTION} -exec rm -rf {} +
done

echo "✓ Retention cleanup complete"
```

---

## Service Accounts & RBAC

### Backup Service Account

```yaml
# kubernetes/rbac/backup-sa.yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: backup-sa
  namespace: platform

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: backup-role
rules:
- apiGroups: [""]
  resources: ["namespaces"]
  verbs: ["list", "get"]
- apiGroups: [""]
  resources: ["persistentvolumes"]
  verbs: ["list", "get"]
- apiGroups: [""]
  resources: ["secrets"]
  verbs: ["list", "get"]
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get"]
- apiGroups: ["k8s-platform.test"]
  resources: ["clients", "workloads", "databases", "domains"]
  verbs: ["list", "get"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: backup-role-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: backup-role
subjects:
- kind: ServiceAccount
  name: backup-sa
  namespace: platform
```

---

## Monitoring & Alerting

### Prometheus Rules

```yaml
# kubernetes/monitoring/backup-alerts.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: backup-alerts
  namespace: platform
spec:
  groups:
  - name: backup.rules
    interval: 30s
    rules:
    - alert: BackupJobFailed
      expr: |
        increase(backup_job_failures_total[1h]) > 0
      for: 10m
      labels:
        severity: critical
      annotations:
        summary: "Backup job failed for {{ $labels.job }}"
    
    - alert: OffsiteBackupFailed
      expr: |
        time() - backup_offsite_write_timestamp > 86400
      for: 30m
      labels:
        severity: warning
      annotations:
        summary: "No successful offsite backup (SSHFS mount+write) in 24+ hours"
    
    - alert: OffsiteMountFailed
      expr: |
        increase(backup_offsite_mount_failures_total[1h]) > 0
      for: 5m
      labels:
        severity: critical
      annotations:
        summary: "SSHFS mount to offsite backup server failed"
    
    - alert: BackupStorageHigh
      expr: |
        (node_filesystem_avail_bytes{mountpoint="/mnt/offsite"} / node_filesystem_size_bytes{mountpoint="/mnt/offsite"}) < 0.2
      for: 5m
      labels:
        severity: warning
      annotations:
        summary: "Offsite backup server storage at 80%+ capacity"
```

---

## Checklist

- [ ] Create offsite backup CronJob (SSHFS mount → DB dump → file backup → config export → encrypt → unmount)
- [ ] Configure retention cleanup script for customer-created backups (find + rm on offsite server)
- [ ] Create Sealed Secrets for encryption passwords
- [ ] Create SSH keys for offsite backup server (accessible via NetBird mesh)
- [ ] Verify FUSE/SSHFS available on worker nodes (or install FUSE device plugin)
- [ ] Set up RBAC for backup service account
- [ ] Configure Prometheus monitoring (mount failures, write duration, success/failure)
- [ ] Set up alerting rules (OffsiteBackupFailed, OffsiteMountFailed, BackupJobFailed)
- [ ] Test full backup & restore cycle (mount → write → unmount → verify checksums)
- [ ] Test restore from offsite: mount offsite server, read backup, restore to cluster
- [ ] Document runbooks for operations team

---

## References

- BACKUP_STRATEGY.md - Complete backup strategy
- BACKUP_EXPORT_MIGRATION_GUIDE.md - Customer migration guide
- DATABASE_SCHEMA.md - Database structure
- SECRETS_MANAGEMENT.md - Encryption & credential management
