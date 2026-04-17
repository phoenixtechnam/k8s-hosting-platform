# Backup Export & Migration Guide

**Status:** Phase 1 Implementation  
**Last Updated:** March 3, 2026  
**Owner:** Operations & Support Team

## Overview

This guide provides complete instructions for customers to export their backups and migrate workloads to external hosting systems. All exports are encrypted with AES-256-CBC and include all necessary data and configuration.

---

## Quick Start: Export in 3 Steps

### Step 1: Download Encrypted Backup

1. Log into admin panel
2. Navigate: **Backups → Offsite Backups**
3. Click **Download** on desired backup date
4. Save `backups-[customer-name]-[date].tar.gz.enc` file
5. Note the encryption password (sent to registered email or display in UI)

### Step 2: Decrypt Archive

```bash
# Use the password from your email/UI
openssl enc -aes-256-cbc -d \
  -in backups-acme-corp-2026-03-03.tar.gz.enc \
  -pass pass:"YOUR_PASSWORD" | \
  tar -xz

# Creates directory structure:
# ├── metadata.json
# ├── workload-name-1/
# │   ├── files/     (all workload files)
# │   └── databases/ (SQL dumps)
# └── workload-name-2/
#     ├── files/
#     └── databases/
```

### Step 3: Migrate to New Host

**See detailed migration procedures below for your target hosting platform.**

---

## What's Included in Each Backup

### Directory Structure

```
customer-acme-corp/
├── metadata.json                      ← ALL settings & config
├── web-app-production/
│   ├── files/                         ← All website files
│   │   ├── index.html
│   │   ├── css/
│   │   ├── js/
│   │   ├── images/
│   │   └── uploads/
│   └── databases/                     ← Database dumps
│       ├── wordpress.sql.gz
│       ├── users.sql.gz
│       └── README.md
├── api-service/
│   ├── files/
│   └── databases/
└── background-jobs/
    └── files/
```

### metadata.json Contents

Complete configuration for entire customer account:

```json
{
  "backup_timestamp": "2026-03-03T02:00:00Z",
  "version": "1.0",
  
  "customer": {
    "id": "client-acme-corp",
    "name": "Acme Corporation",
    "plan": "business",
    "region": "us-east-1",
    "subscription_expires": "2026-12-31",
    "timezone": "America/New_York"
  },
  
  "workloads": [
    {
      "id": "workload-web-prod",
      "name": "Web App (Production)",
      "type": "workload",
      "container_image": "php-8.1:latest",
      "replicas": 3,
      "cpu_request_cores": 1.0,
      "memory_request_mb": 512,
      "storage_gb": 25,
      "environment_variables": {
        "APP_ENV": "production",
        "LOG_LEVEL": "error",
        "DATABASE_HOST": "localhost",
        "DATABASE_PORT": "3306",
        "DATABASE_NAME": "wordpress",
        "DATABASE_USER": "wordpress_user"
        # NOTE: DATABASE_PASSWORD NOT included for security
      },
      "health_check": {
        "enabled": true,
        "endpoint": "/health",
        "interval_seconds": 30,
        "timeout_seconds": 5
      },
      "autoscaling": {
        "enabled": true,
        "min_replicas": 1,
        "max_replicas": 5,
        "cpu_target_percent": 80
      }
    }
  ],
  
  "databases": [
    {
      "id": "db-wordpress",
      "name": "WordPress Database",
      "type": "mariadb",
      "version": "10.6",
      "size_mb": 2048,
      "dump_file": "web-app-production/databases/wordpress.sql.gz",
      "charset": "utf8mb4",
      "collation": "utf8mb4_unicode_ci",
      "tables": 12,
      "backup_time": "2026-03-03T02:15:00Z"
    }
  ],
  
  "domains": [
    {
      "domain_name": "acme.com",
      "status": "active",
      "workload_id": "workload-web-prod",
      "dns_records": [
        {
          "type": "A",
          "name": "@",
          "value": "203.0.113.42",
          "ttl": 3600
        },
        {
          "type": "A",
          "name": "www",
          "value": "203.0.113.42",
          "ttl": 3600
        },
        {
          "type": "MX",
          "name": "@",
          "value": "mail.acme.com",
          "priority": 10
        }
      ]
    }
  ],
  
  "storage": {
    "quota_gb": 100,
    "used_gb": 45,
    "breakdown": {
      "workload_files_gb": 30,
      "databases_gb": 12,
      "temporary_gb": 3
    }
  },
  
  "settings": {
    "backup_retention_days": 30,
    "auto_backup_enabled": true,
    "backup_schedule": "0 2 * * *",
    "monitoring_enabled": true,
    "alert_email": "admin@acme.com",
    "sla_level": "99.5%"
  },
  
  "users": [
    {
      "email": "admin@acme.com",
      "name": "Jane Doe",
      "roles": ["client_admin"]
    },
    {
      "email": "developer@acme.com",
      "name": "John Smith",
      "roles": ["client_user"]
    }
  ],
  
  "backup_integrity": {
    "total_files": 1248,
    "total_size_gb": 45.3,
    "compressed_size_gb": 12.8,
    "compression_ratio": "3.5:1",
    "checksum_sha256": "abc123def456...",
    "encryption": "AES-256-CBC",
    "password_hash": "bcrypt_hash_here"
  }
}
```

### Files Included

✅ All workload files (exact directory structure)  
✅ All user-uploaded content  
✅ Application configuration files  
✅ Database dumps (SQL format)  
✅ System settings  
✅ Domain configuration  
✅ User accounts & roles  
✅ Backup metadata & checksums  

### Files NOT Included (Security)

❌ Database passwords (must be reset post-migration)  
❌ API tokens or secrets (use env vars on new host)  
❌ Encrypted private keys (stored separately)  
❌ Platform SSH keys (regenerate on new host)  

---

## Encryption & Password Management

### How Encryption Works

**Algorithm:** AES-256-CBC (military-grade)  
**Key derivation:** PBKDF2 with 10,000 iterations  
**Salt:** Unique random salt per backup  
**File size:** Encrypted file is ~1.3x original size  

### Passwords

#### Getting Your Backup Password

**Option 1: From Email**
- Backup password emailed when backup completes
- Subject: "Your encrypted backup is ready"
- Password is one-way hash (can't retrieve lost password)

**Option 2: From Admin Panel**
- Settings → Backup → Show Password
- Only visible for 30 seconds (then hidden)
- Store in password manager securely

**Option 3: Password Recovery**
- Settings → Backup → Can't Remember Password?
- System emails one-time recovery code
- Download new encrypted backup with recovery code
- Recovery code valid for 24 hours only

#### Password Security Tips

✅ **Store password in password manager** (1Password, Bitwarden, KeePass)  
✅ **Don't share password via email** (password already emailed once)  
✅ **Keep password safe** - no one (including us) can recover it  
✅ **Test password before deleting old backups** - decrypt test file first  

### Decryption Commands

#### On Linux/Mac

```bash
# Standard OpenSSL method
openssl enc -aes-256-cbc -d \
  -in backup.tar.gz.enc \
  -pass pass:"YOUR_PASSWORD" \
  -out backup.tar.gz

# Verify checksum
tar -xzf backup.tar.gz metadata.json
sha256sum backup.tar.gz
# Compare with metadata.json "checksum_sha256"

# Extract all files
tar -xzf backup.tar.gz
```

#### On Windows (PowerShell)

```powershell
# Using OpenSSL (install from https://slproweb.com/products/Win32OpenSSL.html)
& 'C:\Program Files\OpenSSL\bin\openssl.exe' enc -aes-256-cbc -d `
  -in backup.tar.gz.enc `
  -pass pass:"YOUR_PASSWORD" `
  -out backup.tar.gz

# Or use 7-Zip (free, open-source)
# File → Open → backup.tar.gz.enc
# Enter password
# Extract to folder
```

#### On macOS (Homebrew)

```bash
# Install OpenSSL if needed
brew install openssl

# Decrypt and extract in one command
openssl enc -aes-256-cbc -d \
  -in backup.tar.gz.enc \
  -pass pass:"YOUR_PASSWORD" | \
  tar -xz

# Result: full directory structure extracted
```

---

## Migration Guides by Platform

### Migration to Traditional Web Hosting (cPanel/Plesk)

#### Prerequisites

- cPanel/Plesk hosting account with SSH access
- FTP or SFTP access
- MariaDB admin credentials
- 2x backup size in free disk space

#### Step 1: Prepare Files

```bash
# On local machine
openssl enc -aes-256-cbc -d \
  -in backup.tar.gz.enc \
  -pass pass:"YOUR_PASSWORD" | \
  tar -xz

# Navigate into backup
cd customer-name/
ls -la
# Shows: metadata.json, workload-1/, workload-2/, etc.
```

#### Step 2: Create Databases

```bash
# SSH into cPanel/Plesk server
ssh user@hosting.example.com

# Create MariaDB databases and users
# For each database dump
mysql -u root -p << EOF
CREATE DATABASE wordpress;
CREATE USER 'wp_user'@'localhost' IDENTIFIED BY 'new_password';
GRANT ALL PRIVILEGES ON wordpress.* TO 'wp_user'@'localhost';
FLUSH PRIVILEGES;
EOF

# Import database dump
mysql -u wp_user -p wordpress < web-app-production/databases/wordpress.sql.gz
```

#### Step 3: Upload Files

```bash
# Via SFTP
sftp user@hosting.example.com

# Navigate to public_html
cd public_html

# Upload all workload files
put -r web-app-production/files/* .

# Verify files
ls -la
```

#### Step 4: Configure Application

```bash
# SSH into server
ssh user@hosting.example.com

# Read metadata.json for settings
cat metadata.json | jq '.workloads[0].environment_variables'

# Create/update .env or config file
cat > ~/.env << EOF
APP_ENV=production
DATABASE_HOST=localhost
DATABASE_NAME=wordpress
DATABASE_USER=wp_user
DATABASE_PASSWORD=new_password
EOF

# Set permissions (important!)
chmod 644 index.php
chmod 755 uploads/
find . -type f -exec chmod 644 {} \;
find . -type d -exec chmod 755 {} \;
```

#### Step 5: Verify & Test

```bash
# Test database connection
mysql -u wp_user -p wordpress -e "SELECT COUNT(*) FROM wp_users;"

# Test web access
curl https://acme.com/

# Check logs
tail -f /var/log/apache2/error.log
```

---

### Migration to Docker/Docker Compose

#### Prerequisites

- Docker & Docker Compose installed
- MariaDB container running
- Reverse proxy (Nginx/Traefik) configured
- 2x backup size in free disk space

#### Step 1: Prepare Backup

```bash
# Decrypt
openssl enc -aes-256-cbc -d \
  -in backup.tar.gz.enc \
  -pass pass:"YOUR_PASSWORD" | \
  tar -xz

# Create migration directory
mkdir -p /opt/migrations/acme-corp
cd /opt/migrations/acme-corp
mv ~/backup/* .
```

#### Step 2: Create Docker Compose File

```yaml
# docker-compose.yml
version: '3.8'

services:
  web:
    image: php:8.1-apache
    container_name: acme-web
    ports:
      - "8080:80"
    volumes:
      - ./web-app-production/files:/var/www/html
    environment:
      DATABASE_HOST: db
      DATABASE_NAME: wordpress
      DATABASE_USER: wp_user
      DATABASE_PASSWORD: ${DB_PASSWORD}
    depends_on:
      - db
    networks:
      - app-network

  db:
    image: mariadb:10.6
    container_name: acme-db
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: wordpress
      MYSQL_USER: wp_user
      MYSQL_PASSWORD: ${DB_PASSWORD}
    volumes:
      - ./web-app-production/databases:/docker-entrypoint-initdb.d
      - db-data:/var/lib/mysql
    networks:
      - app-network

volumes:
  db-data:

networks:
  app-network:
```

#### Step 3: Create .env File

```bash
# .env
MYSQL_ROOT_PASSWORD=secure_root_password
DB_PASSWORD=secure_db_password
```

#### Step 4: Start Services

```bash
# Start containers
docker-compose up -d

# Check status
docker-compose ps

# Check logs
docker-compose logs -f web
docker-compose logs -f db

# Test database connection
docker-compose exec db mysql -u root -p$MYSQL_ROOT_PASSWORD -e "SHOW DATABASES;"
```

#### Step 5: Verify Web Access

```bash
# Test from browser or curl
curl http://localhost:8080/

# Check database
docker-compose exec web php -r "
  \$link = new mysqli('db', 'wp_user', getenv('DB_PASSWORD'), 'wordpress');
  echo 'Database connected: ' . (\$link->connect_errno ? 'NO' : 'YES');
"
```

---

### Migration to Kubernetes Cluster

#### Prerequisites

- Kubernetes cluster (1.20+)
- kubectl configured
- PersistentVolume provisioner (Longhorn, NFS, etc.)
- StorageClass created

#### Step 1: Decrypt Backup

```bash
openssl enc -aes-256-cbc -d \
  -in backup.tar.gz.enc \
  -pass pass:"YOUR_PASSWORD" | \
  tar -xz
```

#### Step 2: Create Namespace & Secrets

```bash
# Create namespace
kubectl create namespace acme-corp

# Create database password secret
kubectl create secret generic db-credentials \
  -n acme-corp \
  --from-literal=password=secure_password \
  --from-literal=root-password=secure_root_password
```

#### Step 3: Create ConfigMap for Files

```bash
# Create ConfigMap from metadata
kubectl create configmap backup-metadata \
  -n acme-corp \
  --from-file=metadata.json

# Or for large files, use PersistentVolume instead
```

#### Step 4: Deploy Database

```yaml
# db-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mariadb
  namespace: acme-corp
spec:
  replicas: 1
  selector:
    matchLabels:
      app: mariadb
  template:
    metadata:
      labels:
        app: mariadb
    spec:
      containers:
      - name: mariadb
        image: mariadb:10.6
        env:
        - name: MYSQL_ROOT_PASSWORD
          valueFrom:
            secretKeyRef:
              name: db-credentials
              key: root-password
        - name: MYSQL_DATABASE
          value: wordpress
        volumeMounts:
        - name: db-backup
          mountPath: /docker-entrypoint-initdb.d
        - name: db-data
          mountPath: /var/lib/mysql
      volumes:
      - name: db-backup
        hostPath:
          path: /path/to/backup/web-app-production/databases
      - name: db-data
        persistentVolumeClaim:
          claimName: mariadb-pvc
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: mariadb-pvc
  namespace: acme-corp
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 20Gi
  storageClassName: standard
```

#### Step 5: Deploy Application

```yaml
# app-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
  namespace: acme-corp
spec:
  replicas: 2
  selector:
    matchLabels:
      app: web-app
  template:
    metadata:
      labels:
        app: web-app
    spec:
      containers:
      - name: php
        image: php:8.1-apache
        ports:
        - containerPort: 80
        env:
        - name: DATABASE_HOST
          value: mariadb
        - name: DATABASE_NAME
          value: wordpress
        volumeMounts:
        - name: app-files
          mountPath: /var/www/html
      volumes:
      - name: app-files
        hostPath:
          path: /path/to/backup/web-app-production/files
```

#### Step 6: Apply Manifests

```bash
kubectl apply -f db-deployment.yaml
kubectl apply -f app-deployment.yaml

# Check status
kubectl get pods -n acme-corp
kubectl logs -f deployment/web-app -n acme-corp
```

---

### Migration to Cloud Platforms (AWS, Azure, GCP)

#### AWS Approach

```bash
# 1. Upload backup to S3
aws s3 cp backup.tar.gz.enc s3://migration-bucket/acme-corp/

# 2. Launch EC2 instance with Ubuntu 20.04
# 3. SSH to instance

# 4. Decrypt backup
wget https://s3.amazonaws.com/migration-bucket/acme-corp/backup.tar.gz.enc
openssl enc -aes-256-cbc -d \
  -in backup.tar.gz.enc \
  -pass pass:"YOUR_PASSWORD" | \
  tar -xz

# 5. Create RDS database
aws rds create-db-instance \
  --db-instance-identifier acme-db \
  --db-instance-class db.t3.micro \
  --engine mariadb

# 6. Import database dump (after RDS is available)
mysql -h acme-db.xxxxx.us-east-1.rds.amazonaws.com \
  -u admin \
  -p < web-app-production/databases/wordpress.sql.gz

# 7. Deploy application
# (Elastic Beanstalk, ECS, or manual)
```

#### Azure Approach

```bash
# 1. Upload to Azure Blob Storage
az storage blob upload \
  --account-name acmestorageacct \
  --container-name backups \
  --name backup.tar.gz.enc \
  --file ./backup.tar.gz.enc

# 2. Deploy database
az mysql server create \
  --resource-group acme-rg \
  --name acme-mysql-server \
  --location eastus

# 3. Restore database
mysql -h acme-mysql-server.mysql.database.azure.com \
  -u admin@acme-mysql-server \
  -p < database-dump.sql

# 4. Deploy app to App Service
```

---

## Verification Checklist

After migration, verify:

- [ ] All files present and readable
- [ ] Database imported successfully
- [ ] Web application accessible
- [ ] Database connectivity working
- [ ] File permissions correct
- [ ] User accounts created (if applicable)
- [ ] Email/SMTP configured
- [ ] SSL/TLS certificates installed
- [ ] Backups configured on new system
- [ ] DNS records updated to point to new host
- [ ] Old system backed up before decommissioning

---

## Troubleshooting

### Decryption Errors

**Error:** "bad decrypt"
- **Cause:** Wrong password
- **Fix:** Verify password from email or use recovery code

**Error:** "Invalid magic number"
- **Cause:** Corrupted file
- **Fix:** Re-download backup from UI

### Database Import Errors

**Error:** "Error 1064: Syntax error"
- **Cause:** Database version mismatch
- **Fix:** Use compatible MySQL/MariaDB version

**Error:** "Error 1040: Too many connections"
- **Cause:** Max connections exceeded
- **Fix:** Increase max_connections in MySQL config

**Error:** "Data too long for column"
- **Cause:** Character encoding mismatch
- **Fix:** Ensure UTF-8 encoding: `SET NAMES utf8mb4;`

### File Permission Errors

**Error:** "Permission denied" when serving files
- **Cause:** Wrong file permissions
- **Fix:** `chmod 644 *.html *.php` and `chmod 755 uploads/`

**Error:** "Cannot write to upload directory"
- **Cause:** Directory not writable
- **Fix:** `chown www-data:www-data uploads/` (if using Apache)

---

## Support Resources

- **Backup issues:** support@k8s-platform.local-dev
- **Migration help:** migration-guide@k8s-platform.local-dev
- **Password recovery:** password-recovery@k8s-platform.local-dev
- **Documentation:** https://docs.k8s-platform.local-dev/backup-migration

---

## References

- BACKUP_STRATEGY.md - Complete backup system documentation
- OpenSSL manual - https://www.openssl.org/docs/
- Docker documentation - https://docs.docker.com/
- Kubernetes documentation - https://kubernetes.io/docs/
