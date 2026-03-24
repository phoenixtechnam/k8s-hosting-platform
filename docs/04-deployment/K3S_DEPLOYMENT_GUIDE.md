# k3s Deployment Guide — Phase 1 PoC

This document describes how to provision k3s on admin1 and deploy the management API as a proof-of-concept.

> **ADR-022**: The k3s cluster is a standalone, single-node deployment. NetBird mesh networking is an external service — the k3s node joins it as a peer. There is no dependency on ns1/ns2 for cluster operations. DNS and NetBird provisioning via Ansible are out of scope for this guide.

## Overview

**Phase 1 (PoC):**
- Single-node k3s cluster on admin1
- Management API deployed as a Deployment (1 replica)
- MariaDB StatefulSet (1 replica, local storage)
- No HA, no multi-zone setup
- Traefik and ServiceLB disabled (use reverse proxy external to k3s if needed)

**Later phases** can add:
- Multi-node cluster
- HA control plane with etcd quorum
- Persistent volume provisioning from Longhorn or Hetzner volumes
- NGINX Ingress controller for routing

## Prerequisites

1. **NetBird connectivity** — the external NetBird mesh must be available; join the k3s node as a peer before proceeding:
   ```bash
   netbird status
   # Must show "Connected" and mesh connectivity verified
   ```

2. **SSH key loaded** — admin1 must be reachable:
   ```bash
   ssh -i ~/phoenix-host.key root@46.224.122.58 "hostname"
   # Should return: admin1
   ```

3. **Ansible installed** — version 2.15+:
   ```bash
   ansible --version
   ```

4. **Gitignored files populated**:
   - `ansible/inventory/hosts.yml` — filled from `hosts.example.yml`
   - `ansible/group_vars/all.yml` — filled from `all.example.yml`

## Provisioning Steps

### 1. Update Inventory

Ensure `ansible/inventory/hosts.yml` includes admin1 in the `k3s_control` group:

```yaml
k3s_control:
  hosts:
    admin1:
      # (admin1 inherits connection settings from management_api group)
```

If not already there, add this section.

### 2. Run k3s Provisioning Playbook

```bash
cd /config/hosting-platform/ansible

# Dry-run to check for errors
ansible-playbook -i inventory/hosts.yml provision_k3s.yml --check

# Apply (takes 5-10 minutes)
ansible-playbook -i inventory/hosts.yml provision_k3s.yml
```

**What happens:**
1. k3s binary is downloaded and installed (with `--flannel-backend=none --disable-network-policy` to disable built-in Flannel)
2. Calico CNI is installed (provides NetworkPolicy enforcement for tenant isolation from day one)
3. k3s systemd service is enabled and started
4. Platform and ingress-nginx namespaces are created
4. Management API Docker image is built locally
5. Image is imported into k3s containerd
6. Kubernetes manifests are applied (ConfigMaps, Secrets, StatefulSets, Deployments)
7. Waits for MariaDB StatefulSet to be ready (30-60 seconds)
8. Waits for management API Deployment to be ready (30-60 seconds)
9. Tests the `/api/v1/admin/status` endpoint

### 3. Verify Deployment

On admin1, check the k3s cluster:

```bash
# Via SSH
ssh -i ~/phoenix-host.key root@46.224.122.58

# On admin1:
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# View nodes
kubectl get nodes

# View pods in platform namespace
kubectl -n platform get pods

# View services
kubectl -n platform get svc

# Follow API pod logs
kubectl -n platform logs -f deployment/management-api
```

### 4. Access the API

The management API runs on `http://127.0.0.1:3000` inside the cluster (ClusterIP service, not exposed externally yet).

To test from outside the cluster, use a port-forward:

```bash
# From your workstation, SSH to admin1 with port-forward
ssh -i ~/phoenix-host.key -L 3000:127.0.0.1:3000 root@46.224.122.58

# In another terminal:
curl http://127.0.0.1:3000/api/v1/admin/status
# Expected response: {"database":"ok","pdns_ns1":"ok","pdns_ns2":"ok"}
```

Or access via the NetBird IP (if exposed in the future):

```bash
# Once we add an Ingress or Service of type LoadBalancer
curl http://100.76.98.87:3000/api/v1/admin/status
```

## Secrets Management

The deployment uses Kubernetes Secrets for sensitive data. Before running the playbook, you can customize these in `ansible/group_vars/all.yml`:

```yaml
# Optional: set custom values (defaults to "change-me")
mariadb_root_password: "your-secure-password"
management_api_db_password: "your-secure-password"
admin_password: "your-secure-password"
jwt_secret: "your-secure-jwt-secret"
```

To update secrets after deployment:

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# Update the secret
kubectl -n platform patch secret management-api-secrets \
  -p '{"data":{"ADMIN_PASSWORD":"'$(echo -n 'new-password' | base64)'"}}'

# Restart the API pod to pick up the change
kubectl -n platform rollout restart deployment/management-api
```

## Next Steps

Once k3s is running successfully:

1. **Add ingress** — set up NGINX Ingress controller to expose the API externally
2. **Add monitoring** — deploy Prometheus and Grafana to monitor the cluster
3. **Scale workers** — add worker nodes to expand beyond single-node (not required for Phase 1)
4. **Persistent storage** — migrate to Longhorn for production volumes
5. **Multi-replica deployments** — scale the API to 2-3 replicas once stable

## Troubleshooting

### k3s service fails to start

```bash
systemctl status k3s
journalctl -xeu k3s | tail -50
```

Check for port conflicts (6443 for API, 10250 for kubelet).

### Pods stuck in Pending

```bash
kubectl describe pod <pod-name> -n platform
# Look for "no available nodes" or other scheduling issues
```

Check node resources:

```bash
kubectl describe node admin1
# Check "Allocatable" and "Allocated resources"
```

### API pod crashes

```bash
kubectl -n platform logs management-api-<hash> --previous
# Check for database connection errors
```

Verify MariaDB is healthy:

```bash
kubectl -n platform exec statefulset/mariadb -- mysqladmin ping -u root -p"<password>"
```

### Database migration fails

Ensure MariaDB is running before applying manifests. If DB is already initialized, the init container is idempotent and safe to re-run.

### Image not found in containerd

```bash
/var/lib/rancher/k3s/data/current/bin/ctr -n k8s.io images ls | grep management-api
```

If missing, rebuild and re-import:

```bash
cd /opt/management-api/src
docker build -t management-api:latest .
docker save management-api:latest | gzip > /tmp/management-api-latest.tar.gz
gunzip < /tmp/management-api-latest.tar.gz | \
  /var/lib/rancher/k3s/data/current/bin/ctr -n k8s.io images import -
```

## Rollback / Cleanup

To remove k3s entirely:

```bash
/usr/local/bin/k3s-uninstall.sh

# Or keep k3s but remove the manifests:
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl delete namespace platform
```

To revert to Docker-only deployment:

```bash
# Re-run the original management_api role from site.yml
ansible-playbook -i inventory/hosts.yml site.yml -t management_api
```

## References

- k3s documentation: https://docs.k3s.io/
- Kubernetes Deployments: https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
- StatefulSets: https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/
- Secrets: https://kubernetes.io/docs/concepts/configuration/secret/
