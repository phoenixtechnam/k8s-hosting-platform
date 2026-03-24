# IPv4 & IPv6 Dual-Stack Support Requirements

> **Complete IPv4 and IPv6 dual-stack specification for all platform components**
>
> **Covers:** Infrastructure, networking, applications, DNS, monitoring, testing
>
> **Status:** Production-ready specification

---

## Table of Contents

1. [Overview & Goals](#overview)
2. [Kubernetes Dual-Stack Configuration](#kubernetes)
3. [Infrastructure Provider Setup](#infrastructure)
4. [Networking & Ingress](#networking)
5. [DNS Management](#dns)
6. [Application Requirements](#applications)
7. [Container & Workload Support](#containers)
8. [Admin Panel IPv6 Features](#admin-panel)
9. [Monitoring & Logging](#monitoring)
10. [Testing & Validation](#testing)
11. [Troubleshooting](#troubleshooting)

---

## Overview & Goals

### Why IPv6?

IPv4 address exhaustion is real and affects the platform in two concrete ways:

1. **Node IPs:** Cloud providers (Hetzner, OVH, Linode) charge an additional fee for extra IPv4 addresses — or may not be able to allocate them as the platform scales. IPv6 provides effectively unlimited addressing at no extra cost, meaning every node and service can have a unique public IPv6 address.

2. **Client site accessibility:** A growing proportion of end users — particularly on mobile networks in Asia, Africa, and parts of Europe — access the internet exclusively over IPv6 (carrier-grade NAT prevents IPv4). A client site that has no AAAA record is unreachable to those users. Dual-stack support ensures every hosted site is accessible to 100% of the internet.

Additional reasons specific to this platform:

- **Future-proofing:** RIPE NCC (Europe) and ARIN (North America) are already in final /22 or smaller IPv4 allocations. IPv6 is the long-term path.
- **No NAT hairpin issues:** IPv6 end-to-end connectivity eliminates NAT traversal complexity for applications like Jitsi, Matrix, and BigBlueButton (all in the application catalog).
- **Compliance:** Some enterprise clients and government contracts require dual-stack or IPv6-capable hosting as a procurement condition.
- **Multi-A DNS load balancing:** The platform already uses PowerDNS multi-A records for NGINX DaemonSet load balancing (ADR-010). Extending this to AAAA records adds IPv6 load balancing with zero architectural change.

IPv6 is deferred to Phase 1.5 (not Phase 1) because: k3s dual-stack requires CNI migration from Flannel to Calico, and the MVP development window prioritises delivering core functionality first.

### Success Criteria

| Requirement | Phase 1 | Phase 1.5 | Phase 2+ |
|---|---|---|---|
| **Kubernetes dual-stack** | No | Yes | Yes |
| **IPv4 support** | ✓ Required | ✓ Required | ✓ Required |
| **IPv6 support** | No | Yes | Yes |
| **DNS A + AAAA records** | A only | A + AAAA | A + AAAA |
| **Client IPv6 access** | No | Yes | Yes |
| **Admin panel IPv6** | N/A | Yes | Yes |
| **All apps IPv6-ready** | N/A | Yes | Yes |
| **IPv6 monitoring** | N/A | Yes | Yes |
| **IPv6 load testing** | N/A | Phase 1.5 | Phase 2+ |

### Implementation Timeline

| Phase | Milestone | Target week |
|-------|-----------|------------|
| **Phase 1 (MVP)** | IPv4 only — single-stack k3s with Flannel CNI | Weeks 1–12 |
| **Phase 1.5** | Migrate CNI from Flannel → Calico | Week 13 |
| **Phase 1.5** | Enable k3s dual-stack (`--cluster-cidr` + `--service-cidr` with IPv6 ranges) | Week 13 |
| **Phase 1.5** | Add AAAA records to PowerDNS for all platform services and client domains | Week 13 |
| **Phase 1.5** | Configure NGINX Ingress for dual-stack (bind to `::` as well as `0.0.0.0`) | Week 13 |
| **Phase 1.5** | Update all workload catalog images to bind on `::` | Week 13 |
| **Phase 1.5** | IPv6 firewall rules (UFW / Hetzner firewall) | Week 13 |
| **Phase 1.5** | Test + verify: `curl -6 https://platform.example.com` succeeds | Week 13 |
| **Phase 2** | IPv6 monitoring in Prometheus + Grafana dashboard | Week 14–16 |
| **Phase 2** | Per-client IPv6 traffic metrics in admin panel | Week 14–16 |
| **Phase 2** | IPv6 load testing (k6 with `-6` flag) | Week 14–16 |

**Prerequisite:** Phase 1.5 dual-stack requires a planned maintenance window (~2 hours) for CNI migration. The CNI change (Flannel → Calico) requires restarting all pods. Schedule during low-traffic hours and test in staging first.

---

## Kubernetes Dual-Stack Configuration

### K.1 Dual-Stack Cluster Initialization

**Requirement:** Configure k3s to use both IPv4 and IPv6.

**k3s Startup (Phase 1.5):**

```bash
# /etc/systemd/system/k3s.service.d/override.conf  (on control-plane node)
# Applied during Phase 1.5 maintenance window.
# Replace 10.42.0.0/16 and 2001:db8:42::/56 with your actual CIDRs.
# Replace 10.43.0.0/16 and 2001:db8:43::/112 with your service CIDRs.

[Service]
ExecStart=
ExecStart=/usr/local/bin/k3s server \
  --cluster-cidr=10.42.0.0/16,2001:db8:42::/56 \
  --service-cidr=10.43.0.0/16,2001:db8:43::/112 \
  --cluster-dns=10.43.0.10,2001:db8:43::a \
  --flannel-backend=none \
  --disable-network-policy \
  --node-ip=<IPv4_NODE_IP>,<IPv6_NODE_IP> \
  --kubelet-arg=node-ip=<IPv4_NODE_IP>,<IPv6_NODE_IP>
```

```bash
# On each worker agent node:
k3s agent \
  --server=https://<CONTROL_PLANE_IP>:6443 \
  --token=<K3S_TOKEN> \
  --node-ip=<WORKER_IPv4>,<WORKER_IPv6> \
  --kubelet-arg=node-ip=<WORKER_IPv4>,<WORKER_IPv6>
```

**Key Flags:**

| Flag | Value | Purpose |
|------|-------|---------|
| `--cluster-cidr` | `10.42.0.0/16,2001:db8:42::/56` | Dual-stack pod CIDR (IPv4 + IPv6) |
| `--service-cidr` | `10.43.0.0/16,2001:db8:43::/112` | Dual-stack service CIDR |
| `--cluster-dns` | `10.43.0.10,2001:db8:43::a` | CoreDNS gets both IPv4 and IPv6 addresses |
| `--flannel-backend=none` | — | Disable Flannel; Calico takes over |
| `--disable-network-policy` | — | Calico handles network policy |
| `--node-ip` | `<v4>,<v6>` | Advertise both addresses to the API server |

After applying, restart k3s: `systemctl daemon-reload && systemctl restart k3s`

### K.2 Kubernetes Networking Configuration

**Calico CNI for Dual-Stack (Alternative to Flannel):**

Calico is the recommended CNI for dual-stack because Flannel has limited IPv6 support. Calico handles pod-to-pod routing over both address families and enforces NetworkPolicy objects for both.

```yaml
# k8s/base/calico/installation.yaml
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    ipPools:
      - blockSize: 26
        cidr: 10.42.0.0/16
        encapsulation: VXLANCrossSubnet
        natOutgoing: Enabled
        nodeSelector: all()
      - blockSize: 122
        cidr: 2001:db8:42::/56
        encapsulation: None          # IPv6 routing — no overlay needed
        natOutgoing: Disabled        # No NAT for IPv6 (routable globally)
        nodeSelector: all()
    nodeAddressAutodetectionV4:
      interface: eth0
    nodeAddressAutodetectionV6:
      interface: eth0
```

**Helm Chart Installation:**

```bash
# Add Tigera operator (Calico)
helm repo add projectcalico https://docs.tigera.io/calico/charts
helm repo update

# Install Calico operator
helm install calico projectcalico/tigera-operator \
  --namespace tigera-operator \
  --create-namespace \
  --version v3.27.0

# Apply Installation CR (from above YAML)
kubectl apply -f k8s/base/calico/installation.yaml

# Verify pods come up
kubectl get pods -n calico-system
# calico-node-xxxxx         1/1     Running   (one per node)
# calico-kube-controllers   1/1     Running

# Verify IP pools
kubectl get ippool
# NAME                  CIDR               SELECTOR
# default-ipv4-ippool   10.42.0.0/16       all()
# default-ipv6-ippool   2001:db8:42::/56   all()
```

### K.3 CoreDNS Dual-Stack Configuration

**Requirement:** DNS resolves to both IPv4 and IPv6 addresses.

**CoreDNS ConfigMap (Phase 1.5):**

```yaml
# kubectl edit configmap coredns -n kube-system
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health {
           lameduck 5s
        }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {  # ip6.arpa for IPv6 PTR records
           pods insecure
           fallthrough in-addr.arpa ip6.arpa
           ttl 30
        }
        prometheus :9153
        forward . /etc/resolv.conf {
           max_concurrent 1000
        }
        cache 30
        loop
        reload
        loadbalance
    }
```

After updating the ConfigMap, CoreDNS pods restart automatically. Verify:

```bash
kubectl run dnstest --image=busybox --restart=Never --rm -it -- \
  nslookup kubernetes.default.svc.cluster.local
# Should return both an IPv4 and IPv6 address when cluster is dual-stack
```

### K.4 Service Configuration

**Dual-Stack Service Definition:**

By default, Kubernetes services in a dual-stack cluster remain single-stack unless explicitly configured. Use `ipFamilyPolicy: PreferDualStack` for all platform services and `RequireDualStack` where IPv6 is mandatory.

```yaml
# Example: management API service
apiVersion: v1
kind: Service
metadata:
  name: management-api
  namespace: platform
spec:
  selector:
    app: management-api
  ipFamilyPolicy: PreferDualStack   # Use dual-stack if available; fall back to single
  ipFamilies:
    - IPv4
    - IPv6
  ports:
    - name: http
      port: 3000
      targetPort: 3000
      protocol: TCP
  type: ClusterIP
```

```yaml
# Example: PowerDNS service (must be dual-stack — serves DNS to IPv6 clients)
apiVersion: v1
kind: Service
metadata:
  name: powerdns
  namespace: dns
spec:
  selector:
    app: powerdns
  ipFamilyPolicy: RequireDualStack  # Fail if IPv6 not available
  ipFamilies:
    - IPv4
    - IPv6
  ports:
    - name: dns-udp
      port: 53
      protocol: UDP
    - name: dns-tcp
      port: 53
      protocol: TCP
    - name: api
      port: 8081
      protocol: TCP
  type: ClusterIP
```

Apply `ipFamilyPolicy: PreferDualStack` to all services in `k8s/base/` during the Phase 1.5 maintenance window. Services that don't specify `ipFamilyPolicy` inherit the cluster default and remain IPv4-only until updated.

### K.5 Ingress Configuration

**NGINX Ingress with Dual-Stack:**

NGINX Ingress Controller must bind on `::` (IPv6 wildcard, which also covers IPv4 on Linux) so it accepts connections on both address families via the DaemonSet hostPort.

```yaml
# k8s/base/ingress-nginx/daemonset-patch.yaml  (Kustomize patch)
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
spec:
  template:
    spec:
      containers:
        - name: controller
          args:
            - /nginx-ingress-controller
            - --election-id=ingress-nginx-leader
            - --ingress-class=nginx
            - --configmap=$(POD_NAMESPACE)/ingress-nginx-controller
            - --enable-ssl-passthrough
          ports:
            - name: http
              containerPort: 80
              hostPort: 80
              protocol: TCP
            - name: https
              containerPort: 443
              hostPort: 443
              protocol: TCP
```

```yaml
# k8s/base/ingress-nginx/configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
data:
  # Bind NGINX on :: — accepts both IPv4 and IPv6 on Linux (dual-stack)
  bind-address: "::"
  use-ipv6: "true"
  # Log real client IP (works for both IPv4-mapped and native IPv6 addresses)
  use-forwarded-headers: "true"
  proxy-real-ip-cidr: "0.0.0.0/0,::/0"
```

After applying, verify NGINX listens on both families:

```bash
kubectl exec -n ingress-nginx ds/ingress-nginx-controller -- ss -tlnp | grep -E ':80|:443'
# Expected:
# LISTEN  0  511  :::80    *:*   (IPv6 wildcard — covers IPv4 too)
# LISTEN  0  511  :::443   *:*
```

---

## Infrastructure Provider Setup

### IP.1 Hetzner Cloud Dual-Stack

**Requirement:** Configure Hetzner servers with both IPv4 and IPv6.

Hetzner assigns one `/64` IPv6 prefix per server for free. The server's primary IPv6 address is the `::1` host within that prefix. No extra cost; simply enable IPv6 in Terraform.

**Server Configuration (Terraform):**

```hcl
# terraform/modules/hetzner-cluster/main.tf
resource "hcloud_server" "worker" {
  count       = var.worker_count
  name        = "worker-${var.location}-${count.index + 1}"
  server_type = var.server_type
  location    = var.location
  image       = "debian-12"
  ssh_keys    = [data.hcloud_ssh_key.admin.id]

  # Enable IPv6 — Hetzner assigns a /64 prefix automatically
  ipv4_enabled = true
  ipv6_enabled = true

  labels = var.labels
}

output "worker_ipv4" {
  value = hcloud_server.worker[*].ipv4_address
}

output "worker_ipv6" {
  value = hcloud_server.worker[*].ipv6_address  # Returns the ::1 host address in the /64
}
```

**Network Configuration (on server):**

```bash
# /etc/network/interfaces.d/60-ipv6.conf  (written by cloud-init or Ansible)
# Hetzner auto-configures the primary IPv6 address via SLAAC.
# Verify the interface has both addresses:
ip addr show eth0
# Should show:
#   inet  <IPv4>/32
#   inet6 <prefix>::1/64   (Hetzner-assigned, global scope)

# Enable IPv6 forwarding (required for k3s pod routing):
echo "net.ipv6.conf.all.forwarding=1" >> /etc/sysctl.d/99-ipv6.conf
sysctl --system

# Verify connectivity:
ping6 2606:4700:4700::1064   # Cloudflare IPv6 DNS
curl -6 https://ipv6.google.com
```

**Firewall (Hetzner Cloud Firewall):**

```hcl
# terraform/modules/hetzner-cluster/firewall.tf
resource "hcloud_firewall" "platform" {
  name = "platform-firewall"

  # Allow ICMP (IPv4 + IPv6 ping)
  rule { direction = "in"; protocol = "icmp"; source_ips = ["0.0.0.0/0", "::/0"] }

  # Allow HTTP + HTTPS from all (IPv4 + IPv6)
  rule { direction = "in"; protocol = "tcp"; port = "80";  source_ips = ["0.0.0.0/0", "::/0"] }
  rule { direction = "in"; protocol = "tcp"; port = "443"; source_ips = ["0.0.0.0/0", "::/0"] }

  # Allow DNS (TCP + UDP) from all (for nameserver nodes)
  rule { direction = "in"; protocol = "tcp"; port = "53"; source_ips = ["0.0.0.0/0", "::/0"] }
  rule { direction = "in"; protocol = "udp"; port = "53"; source_ips = ["0.0.0.0/0", "::/0"] }

  # Allow SSH + k3s API only from NetBird WireGuard mesh (admin-only)
  rule { direction = "in"; protocol = "tcp"; port = "22";   source_ips = ["100.64.0.0/10"] }
  rule { direction = "in"; protocol = "tcp"; port = "6443"; source_ips = ["100.64.0.0/10"] }
}
```

### IP.2 OVH Cloud Dual-Stack

**Requirement:** Configure OVH servers with both IPv4 and IPv6.

OVH assigns a `/128` IPv6 address per VPS by default; a `/56` or `/64` block can be requested for network-level routing. Configure the gateway as documented in the OVH control panel.

**Terraform Configuration:**

```hcl
# terraform/modules/ovh-cluster/main.tf
resource "openstack_compute_instance_v2" "worker" {
  count           = var.worker_count
  name            = "worker-ovh-${count.index + 1}"
  flavor_name     = var.flavor_name   # e.g. "b2-7"
  image_name      = "Debian 12"
  key_pair        = "platform-admin"

  # OVH OpenStack — attach to network that has IPv6 enabled
  network {
    name = "Ext-Net"   # OVH public network (dual-stack)
  }

  metadata = var.labels
}

output "worker_ipv4" {
  # OVH assigns IPv4 from Ext-Net
  value = [for i in openstack_compute_instance_v2.worker : i.access_ip_v4]
}

output "worker_ipv6" {
  value = [for i in openstack_compute_instance_v2.worker : i.access_ip_v6]
}
```

```bash
# Post-provision: configure IPv6 default gateway on OVH (gateway is provider-specific)
# OVH provides the gateway IP in the instance metadata:
GATEWAY6=$(curl -s http://169.254.169.254/openstack/latest/network_data.json \
  | jq -r '.links[] | select(.type=="ipv6") | .id' | head -1)

ip -6 route add default via $GATEWAY6 dev eth0

# Persist via /etc/network/interfaces or systemd-networkd:
echo "[Match]
Name=eth0

[Network]
DHCP=yes
IPv6AcceptRA=yes
" > /etc/systemd/network/10-eth0.network
systemctl restart systemd-networkd
```

### IP.3 AWS EC2 Dual-Stack

**Requirement:** Configure AWS instances with both IPv4 and IPv6.

AWS requires an IPv6-enabled VPC and subnet. IPv6 CIDRs are allocated from Amazon's address pool (no cost for the addresses; data transfer charges still apply).

**Terraform Configuration:**

```hcl
# terraform/modules/aws-cluster/vpc.tf
resource "aws_vpc" "platform" {
  cidr_block                       = "10.0.0.0/16"
  assign_generated_ipv6_cidr_block = true   # AWS assigns a /56 from its pool
  enable_dns_hostnames             = true
}

resource "aws_subnet" "workers" {
  count                           = 2
  vpc_id                          = aws_vpc.platform.id
  cidr_block                      = cidrsubnet(aws_vpc.platform.cidr_block, 8, count.index)
  ipv6_cidr_block                 = cidrsubnet(aws_vpc.platform.ipv6_cidr_block, 8, count.index)
  assign_ipv6_address_on_creation = true
  map_public_ip_on_launch         = true
  availability_zone               = data.aws_availability_zones.available.names[count.index]
}

resource "aws_instance" "worker" {
  count                       = var.worker_count
  ami                         = data.aws_ami.debian.id
  instance_type               = "t3.medium"
  subnet_id                   = aws_subnet.workers[count.index % 2].id
  ipv6_address_count          = 1    # Assign one IPv6 address from the subnet pool
  associate_public_ip_address = true
  key_name                    = "platform-admin"
  tags                        = var.labels
}

output "worker_ipv4" { value = aws_instance.worker[*].public_ip }
output "worker_ipv6" { value = [for i in aws_instance.worker : i.ipv6_addresses[0]] }
```

### IP.4 Azure Dual-Stack

**Requirement:** Configure Azure VMs with both IPv4 and IPv6.

Azure dual-stack requires a Basic or Standard Load Balancer with a separate IPv6 public IP. Standard VMs get IPv6 via the NIC configuration.

**Terraform Configuration:**

```hcl
# terraform/modules/azure-cluster/main.tf
resource "azurerm_virtual_network" "platform" {
  name                = "platform-vnet"
  address_space       = ["10.0.0.0/16", "2001:db8::/48"]   # IPv4 + IPv6
  location            = var.location
  resource_group_name = azurerm_resource_group.platform.name
}

resource "azurerm_subnet" "workers" {
  name                 = "workers"
  resource_group_name  = azurerm_resource_group.platform.name
  virtual_network_name = azurerm_virtual_network.platform.name
  address_prefixes     = ["10.0.1.0/24", "2001:db8::1:0/112"]
}

resource "azurerm_public_ip" "worker_ipv4" {
  count               = var.worker_count
  name                = "worker-pip4-${count.index}"
  resource_group_name = azurerm_resource_group.platform.name
  location            = var.location
  allocation_method   = "Static"
  sku                 = "Standard"
  ip_version          = "IPv4"
}

resource "azurerm_public_ip" "worker_ipv6" {
  count               = var.worker_count
  name                = "worker-pip6-${count.index}"
  resource_group_name = azurerm_resource_group.platform.name
  location            = var.location
  allocation_method   = "Static"
  sku                 = "Standard"
  ip_version          = "IPv6"
}

resource "azurerm_network_interface" "worker" {
  count               = var.worker_count
  name                = "worker-nic-${count.index}"
  location            = var.location
  resource_group_name = azurerm_resource_group.platform.name

  ip_configuration {
    name                          = "ipv4"
    subnet_id                     = azurerm_subnet.workers.id
    private_ip_address_allocation = "Dynamic"
    private_ip_address_version    = "IPv4"
    public_ip_address_id          = azurerm_public_ip.worker_ipv4[count.index].id
    primary                       = true
  }

  ip_configuration {
    name                          = "ipv6"
    subnet_id                     = azurerm_subnet.workers.id
    private_ip_address_allocation = "Dynamic"
    private_ip_address_version    = "IPv6"
    public_ip_address_id          = azurerm_public_ip.worker_ipv6[count.index].id
  }
}

output "worker_ipv4" { value = azurerm_public_ip.worker_ipv4[*].ip_address }
output "worker_ipv6" { value = azurerm_public_ip.worker_ipv6[*].ip_address }
```

---

## Networking & Ingress

### N.1 Load Balancer Configuration

**Dual-Stack Load Balancer (Hetzner):**

The platform uses NGINX Ingress as a DaemonSet with `hostPort` — there is no separate cloud load balancer in Phase 1/1.5. PowerDNS multi-A (and multi-AAAA) records distribute traffic across all worker node IPs (ADR-010). Each worker exposes port 80 and 443 on both its IPv4 and IPv6 addresses.

```yaml
# k8s/base/ingress-nginx/service.yaml
# NodePort service — used only for health checks; actual traffic arrives via hostPort
apiVersion: v1
kind: Service
metadata:
  name: ingress-nginx-controller
  namespace: ingress-nginx
spec:
  selector:
    app.kubernetes.io/name: ingress-nginx
  ipFamilyPolicy: PreferDualStack
  ipFamilies: [IPv4, IPv6]
  ports:
    - name: http
      port: 80
      targetPort: http
    - name: https
      port: 443
      targetPort: https
  type: ClusterIP
```

DNS records for load balancing across workers (PowerDNS, Phase 1.5+):

```
example-client.com  A     65.21.1.1    ; worker-1 IPv4
example-client.com  A     65.21.1.2    ; worker-2 IPv4
example-client.com  AAAA  2a01:4f8::1  ; worker-1 IPv6
example-client.com  AAAA  2a01:4f8::2  ; worker-2 IPv6
; TTL 60s — consistent with ADR-010 load balancing approach
```

In Phase 2+, a Hetzner Load Balancer resource (or equivalent) can be added in front of workers for Layer 4 HA; it also supports dual-stack natively.

### N.2 Firewall Rules

**UFW (Ubuntu Firewall) Dual-Stack:**

UFW must be configured to allow both IPv4 and IPv6 traffic. By default on Debian, UFW applies rules to both `iptables` and `ip6tables` when `IPV6=yes` is set in `/etc/default/ufw`.

```bash
# /etc/default/ufw — must have:
IPV6=yes

# Reload UFW to apply IPv6 support:
ufw reload

# Apply rules (these apply to both IPv4 and IPv6 automatically):
ufw default deny incoming
ufw default allow outgoing

# Public HTTP/HTTPS (for hosted client sites):
ufw allow 80/tcp
ufw allow 443/tcp

# Public DNS (for nameserver nodes only):
ufw allow 53/tcp
ufw allow 53/udp

# WireGuard (NetBird mesh — admin access):
ufw allow 51820/udp

# k3s API and SSH — restrict to WireGuard range only:
ufw allow in on wg0 to any port 6443 proto tcp comment 'k3s API (mesh only)'
ufw allow in on wg0 to any port 22   proto tcp comment 'SSH (mesh only)'

# Kubernetes CNI (Calico VXLAN — inter-node):
ufw allow 4789/udp comment 'Calico VXLAN'
ufw allow 179/tcp  comment 'BGP (Calico)'
ufw allow 5473/tcp comment 'Calico Typha'

# NGINX health check / Longhorn:
ufw allow in on lo  # allow all loopback

ufw enable
ufw status verbose
```

**Verify IPv6 rules are active:**

```bash
ip6tables -L INPUT -n -v
# Should show ACCEPT rules for ports 80, 443, 53 on all interfaces
```

### N.3 Reverse Proxy (NGINX)

**NGINX Configuration for Dual-Stack:**

NGINX Ingress Controller (running as DaemonSet) handles all TLS termination and reverse proxying. With `bind-address: "::"` set in the ConfigMap (see K.5), NGINX automatically accepts both IPv4 and IPv6 connections.

The `X-Forwarded-For` header will contain either an IPv4 address (`203.0.113.5`) or an IPv6 address (`2001:db8::1`) depending on the client. Backend applications must parse both formats correctly (see A.2).

```nginx
# Example: what the generated NGINX upstream config looks like for a client site
# (Generated by NGINX Ingress from Ingress resource — not edited manually)

server {
    listen [::]:80;         # IPv6 wildcard (covers IPv4 on Linux)
    server_name example-client.com www.example-client.com;

    location /.well-known/acme-challenge/ {
        proxy_pass http://cert-manager-acme-solver;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen [::]:443 ssl;
    server_name example-client.com www.example-client.com;

    ssl_certificate     /etc/ssl/certs/example-client.com.crt;
    ssl_certificate_key /etc/ssl/private/example-client.com.key;

    location / {
        proxy_pass         http://client-workload-service.client-namespace.svc.cluster.local;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

**IPv6-mapped IPv4 addresses:** On Linux, when NGINX binds on `::`, IPv4 clients arrive as IPv4-mapped IPv6 addresses (e.g. `::ffff:203.0.113.5`). NGINX normalises these back to plain IPv4 in `$remote_addr` automatically. No special handling required in backend code.

---

## DNS Management

### D.1 PowerDNS Dual-Stack

**Requirement:** PowerDNS resolves A (IPv4) and AAAA (IPv6) records.

PowerDNS itself listens on both IPv4 and IPv6 interfaces for DNS queries, and stores AAAA records in the same MariaDB backend as A records. No special plugin is needed — AAAA is a standard record type.

**PowerDNS Configuration:**

```ini
# /etc/powerdns/pdns.conf  (or mounted ConfigMap in k8s)

# Listen on both IPv4 and IPv6 wildcard addresses:
local-address=0.0.0.0,::

# Port 53 for queries, 8081 for the REST API:
local-port=53

# Enable the REST API (used by management API to create/update records):
api=yes
api-key=<PDNS_API_KEY>        # stored in Sealed Secret
webserver=yes
webserver-address=127.0.0.1
webserver-port=8081

# MariaDB backend:
launch=gmysql
gmysql-host=mariadb.platform.svc.cluster.local
gmysql-dbname=pdns
gmysql-user=pdns
gmysql-password=<PDNS_DB_PASS>

# AXFR to secondaries — list all secondary nameserver IPs (IPv4 + IPv6):
allow-axfr-ips=<OVH_NS_IPv4>,<OVH_NS_IPv6>,<LINODE_NS_IPv4>,<LINODE_NS_IPv6>
also-notify=<OVH_NS_IPv4>,<OVH_NS_IPv6>
```

**PowerDNS Zone File (A and AAAA records):**

```
; Zone: example-client.com  (managed by management API via PowerDNS REST API)
; Created/updated on provisioning by POST /api/v1/servers/localhost/zones

$ORIGIN example-client.com.
@   3600  IN  SOA   ns1.platform.example.com. hostmaster.platform.example.com. (
                    2026030801  ; serial
                    3600        ; refresh
                    900         ; retry
                    604800      ; expire
                    300 )       ; minimum TTL

; Nameservers
@   3600  IN  NS  ns1.platform.example.com.
@   3600  IN  NS  ns2.platform.example.com.

; Client site — dual-stack (Phase 1.5+)
@    60  IN  A     65.21.1.1       ; worker-1 IPv4
@    60  IN  A     65.21.1.2       ; worker-2 IPv4
@    60  IN  AAAA  2a01:4f8:0:1::1 ; worker-1 IPv6
@    60  IN  AAAA  2a01:4f8:0:1::2 ; worker-2 IPv6
www  60  IN  CNAME @
```

**Terraform PowerDNS Zone:**

```hcl
# terraform/modules/dns/client-zone.tf
# Uses the powerdns Terraform provider (community: pan-net/powerdns)

terraform {
  required_providers {
    powerdns = {
      source  = "pan-net/powerdns"
      version = "~> 1.5"
    }
  }
}

provider "powerdns" {
  server_url = "http://powerdns.platform.svc.cluster.local:8081"
  api_key    = var.pdns_api_key
}

resource "powerdns_zone" "client" {
  name    = "${var.domain}."
  kind    = "Native"
  nameservers = [
    "ns1.platform.example.com.",
    "ns2.platform.example.com.",
  ]
}

resource "powerdns_record" "a" {
  zone    = powerdns_zone.client.id
  name    = "${var.domain}."
  type    = "A"
  ttl     = 60
  records = var.worker_ipv4_addresses  # list of all worker IPv4 IPs
}

resource "powerdns_record" "aaaa" {
  count   = var.enable_ipv6 ? 1 : 0    # only in Phase 1.5+
  zone    = powerdns_zone.client.id
  name    = "${var.domain}."
  type    = "AAAA"
  ttl     = 60
  records = var.worker_ipv6_addresses
}

resource "powerdns_record" "www_cname" {
  zone    = powerdns_zone.client.id
  name    = "www.${var.domain}."
  type    = "CNAME"
  ttl     = 3600
  records = ["${var.domain}."]
}
```

### D.2 DNS Testing

**Test DNS Resolution (IPv4 and IPv6):**

```bash
# ── Verify A record (IPv4) ────────────────────────────────────────────
dig A example-client.com @ns1.platform.example.com
# Should return one or more worker IPv4 addresses

# ── Verify AAAA record (IPv6) ─────────────────────────────────────────
dig AAAA example-client.com @ns1.platform.example.com
# Should return one or more worker IPv6 addresses (Phase 1.5+)

# ── Test HTTP via IPv4 ────────────────────────────────────────────────
curl -4 -I https://example-client.com
# HTTP/2 200 (or redirect)

# ── Test HTTP via IPv6 ────────────────────────────────────────────────
curl -6 -I https://example-client.com
# HTTP/2 200  — confirms NGINX accepts IPv6 + TLS cert valid

# ── Verify SOA and NS records ─────────────────────────────────────────
dig SOA example-client.com @ns1.platform.example.com
dig NS  example-client.com @ns1.platform.example.com

# ── AXFR replication to secondary ─────────────────────────────────────
dig AXFR example-client.com @ns2.platform.example.com
# Should return full zone — same records as primary

# ── PTR reverse lookup (IPv4) ─────────────────────────────────────────
dig -x 65.21.1.1
# Returns the reverse PTR (requires rDNS delegation from Hetzner)

# ── PTR reverse lookup (IPv6) ─────────────────────────────────────────
dig -x 2a01:4f8:0:1::1
# Returns ip6.arpa PTR if configured

# ── Platform nameserver dual-stack check ──────────────────────────────
dig A    ns1.platform.example.com   # IPv4 of ns1
dig AAAA ns1.platform.example.com   # IPv6 of ns1 (Phase 1.5+)
```

---

## Application Requirements

### A.1 Application Dual-Stack Support

**Requirement:** All applications (backend, frontend, etc.) must support both IPv4 and IPv6.

The management API and admin/client panels run inside the cluster and are reached via NGINX Ingress, which handles all IPv4/IPv6 termination. The applications themselves only need to ensure they bind on `::` (not `127.0.0.1` or `0.0.0.0`) and correctly parse IPv6 addresses from `X-Forwarded-For`.

**Node.js Backend (Fastify):**

```typescript
// backend/src/server.ts
import Fastify from 'fastify'

const fastify = Fastify({
  logger: true,
  // Fastify defaults to '0.0.0.0' — use '::' to accept IPv4 and IPv6
  // (on Linux, '::' accepts IPv4-mapped connections too)
})

await fastify.listen({
  port: 3000,
  host: '::', // dual-stack: accepts both IPv4 and IPv6
})

// Trust the X-Forwarded-For header from NGINX Ingress:
// (Fastify uses 'x-forwarded-for' by default when behind a proxy)
// Register the fastify-ip plugin or read req.ip which returns the real client IP:
fastify.get('/health', async (req, reply) => {
  return {
    status: 'ok',
    client_ip: req.ip, // correctly handles both IPv4 and IPv6-mapped IPv4
  }
})
```

**React Frontend (Vite dev server — development only):**

```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '::',    // bind on both IPv4 and IPv6 in dev
    port: 5173,
  },
  preview: {
    host: '::',
    port: 4173,
  },
})
```

> Production frontend is served as static files from NGINX Ingress — Vite's dev server config is irrelevant in production.

**Docker Containers (Dual-Stack Ready):**

```dockerfile
# catalog-images/apache-php84/Dockerfile
# Apache must listen on :: not 127.0.0.1 or 0.0.0.0

FROM debian:12-slim
RUN apt-get update && apt-get install -y apache2 php8.4 libapache2-mod-php8.4

# Apache default: listens on 0.0.0.0:80 — change to :: for dual-stack
RUN sed -i 's/Listen 80/Listen [::]:80/' /etc/apache2/ports.conf && \
    sed -i 's/Listen 443/Listen [::]:443/' /etc/apache2/ports.conf

# Enable IPv6 in Apache config:
RUN echo "EnableSendfile Off" >> /etc/apache2/conf-available/ipv6.conf && \
    a2enconf ipv6

EXPOSE 80
CMD ["apache2ctl", "-D", "FOREGROUND"]
```

```yaml
# All catalog image Deployments / StatefulSets must NOT set:
#   hostNetwork: true   (breaks IPv6 routing via CNI)
# And must use 'protocol: TCP' (not 'UDP') for port 80/443 unless explicitly needed.
```

### A.2 Client Connection Handling

**Handle Clients from Both IPv4 and IPv6:**

Backend services receive client IPs via `X-Forwarded-For` from NGINX Ingress. In a dual-stack setup, this header may contain an IPv4 address (`203.0.113.5`), an IPv6 address (`2001:db8::1`), or an IPv4-mapped IPv6 address (`::ffff:203.0.113.5`). All three must be handled correctly.

```typescript
// backend/src/utils/clientIp.ts
// Normalise X-Forwarded-For to a canonical IP string

export function getClientIp(xForwardedFor: string | undefined, remoteAddress: string): string {
  // Take the left-most (original client) IP from X-Forwarded-For
  const raw = xForwardedFor?.split(',')[0]?.trim() ?? remoteAddress

  // Strip IPv4-mapped IPv6 prefix: ::ffff:203.0.113.5 → 203.0.113.5
  if (raw.startsWith('::ffff:') && raw.includes('.')) {
    return raw.slice(7)
  }

  // Strip surrounding brackets if present: [2001:db8::1] → 2001:db8::1
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1)
  }

  return raw
}

// Usage in route handler:
fastify.addHook('onRequest', async (req) => {
  req.clientIp = getClientIp(
    req.headers['x-forwarded-for'] as string,
    req.socket.remoteAddress ?? '',
  )
})
```

**Rate limiting and geo-IP:** The `ip-ranges` and `geoip-lite` packages handle both IPv4 and IPv6 addresses natively. Ensure any rate-limit store key uses the normalised IP from `getClientIp()` above, not the raw `req.socket.remoteAddress`.

**Audit logging:** All audit log entries include a `client_ip` field (see `EVENT_LOGGING_STRATEGY.md`). The logged value must be the normalised form (plain IPv4 or plain IPv6, never `::ffff:...`).

---

## Containers & Workload Support

### C.1 All Workload Images (Dual-Stack)

**Requirement:** All container images must support both IPv4 and IPv6.

**Update All Workload Images (Phase 1.5):**

All catalog images in `catalog-images/` must be audited and updated so that their embedded web servers, app servers, and database connectors bind on `::` rather than `0.0.0.0` or `127.0.0.1`. The following checklist covers each image type:

| Image | Bind address file | Required change |
|-------|------------------|----------------|
| `apache-php84` | `/etc/apache2/ports.conf` | `Listen [::]:80` and `Listen [::]:443` |
| `apache-php83` | `/etc/apache2/ports.conf` | Same as above |
| `nginx-php84` | `/etc/nginx/nginx.conf` | `listen [::]:80 default_server;` |
| `node-runtime` | Application `server.ts` | `host: '::'` passed to `fastify.listen()` |
| `mariadb` | `/etc/mysql/my.cnf` | `bind-address = ::` (MariaDB supports IPv6 natively) |
| `postgresql` | `postgresql.conf` | `listen_addresses = '*'` (covers IPv6 too) |
| `redis` | `redis.conf` | `bind :: 0.0.0.0` |

```bash
# Phase 1.5 migration script — run per catalog image:
# catalog-images/scripts/enable-ipv6.sh

#!/usr/bin/env bash
set -euo pipefail
IMAGE_DIR="${1:?usage: enable-ipv6.sh <image-dir>}"

# Apache
if [ -f "$IMAGE_DIR/Dockerfile" ] && grep -q apache2 "$IMAGE_DIR/Dockerfile"; then
  sed -i 's/Listen 80/Listen [::]:80/g'   "$IMAGE_DIR/conf/ports.conf"
  sed -i 's/Listen 443/Listen [::]:443/g' "$IMAGE_DIR/conf/ports.conf"
  echo "✓ Apache ports.conf updated: $IMAGE_DIR"
fi

# NGINX
if grep -q "listen 80" "$IMAGE_DIR/conf/nginx.conf" 2>/dev/null; then
  sed -i 's/listen 80;/listen [::]:80 default_server;/g' "$IMAGE_DIR/conf/nginx.conf"
  echo "✓ NGINX nginx.conf updated: $IMAGE_DIR"
fi

# MariaDB
if grep -q "bind-address" "$IMAGE_DIR/conf/my.cnf" 2>/dev/null; then
  sed -i 's/bind-address\s*=\s*.*/bind-address = ::/' "$IMAGE_DIR/conf/my.cnf"
  echo "✓ MariaDB my.cnf updated: $IMAGE_DIR"
fi

echo "Done. Rebuild and push image to Harbor."
```

After updating each image, bump the patch version tag (e.g. `apache-php84:1.2.0` → `1.2.1`), rebuild, push to Harbor, and update the default version in the application catalog. Rolling updates to existing client workloads are triggered automatically by Flux v2 image automation.

### C.2 Application Catalog (IPv6 Ready)

**All Apps Must Support IPv6:**

| App | IPv4 | IPv6 | Notes |
|-----|------|------|-------|
| Nextcloud | ✓ | ✓ | Update to latest version (supports IPv6) |
| WordPress | ✓ | ✓ | Native support |
| Gitea | ✓ | ✓ | Native support |
| Mattermost | ✓ | ✓ | Configure to listen on :: |
| Jitsi | ✓ | ✓ | Update prosody config |
| Ghost | ✓ | ✓ | Native support |
| MediaWiki | ✓ | ✓ | Native support |
| Matrix/Synapse | ✓ | ✓ | Configure listeners |

---

## Admin Panel IPv6 Features

### AP.1 IPv6 Monitoring

**Admin Panel Features (Phase 1.5+):**

The admin panel's infrastructure overview page (section I.3 in ADMIN_PANEL_REQUIREMENTS.md) includes an **IPv6 Status** panel showing:

| Widget | Data source | Description |
|--------|-------------|-------------|
| **Dual-stack node list** | `kubectl get nodes -o wide` | Node name, IPv4, IPv6, dual-stack status |
| **IPv6 traffic % (platform-wide)** | Prometheus `nginx_ingress_controller_requests` with `ip_family="ipv6"` label | Percentage of HTTP requests arriving over IPv6 |
| **AAAA record coverage** | PowerDNS REST API `/zones` scan | How many client zones have AAAA records vs A-only |
| **Clients with IPv6 access** | Aggregated from `access_logs` table | Number of unique clients whose sites received ≥1 IPv6 request today |

**API Endpoint:**

```http
GET /api/v1/admin/infrastructure/ipv6-status
Authorization: Bearer <admin-token>
```

Response:

```json
{
  "dual_stack_enabled": true,
  "nodes": [
    { "name": "worker-nbg1-1", "ipv4": "65.21.1.1", "ipv6": "2a01:4f8::1", "dual_stack": true },
    { "name": "worker-nbg1-2", "ipv4": "65.21.1.2", "ipv6": "2a01:4f8::2", "dual_stack": true }
  ],
  "ipv6_traffic_percent_24h": 18.4,
  "aaaa_record_coverage_percent": 100.0,
  "clients_with_ipv6_requests_today": 42
}
```

### AP.2 Per-Client IPv6 Access

**Track IPv6 Usage per Client:**

Each client's detail page (admin panel) shows an **IPv6 Access** section (Phase 1.5+):

| Field | Description |
|-------|-------------|
| **AAAA records** | List of AAAA records for all client domains — green tick if present, orange warning if missing |
| **IPv6 requests (last 7 days)** | Sparkline graph of daily IPv6 request count |
| **IPv6 traffic share** | % of client's total requests arriving over IPv6 |
| **First IPv6 request** | Timestamp of the earliest IPv6 request logged for this client |

**API Endpoint:**

```http
GET /api/v1/admin/customers/{id}/ipv6-stats?from=2026-03-01&to=2026-03-08
```

Response:

```json
{
  "customer_id": "cust_abc123",
  "domains": [
    {
      "domain": "example-client.com",
      "aaaa_records": ["2a01:4f8::1", "2a01:4f8::2"],
      "aaaa_present": true
    }
  ],
  "ipv6_requests_7d": [120, 145, 98, 201, 180, 220, 190],
  "ipv6_traffic_share_percent": 22.3,
  "first_ipv6_request": "2026-03-02T14:22:01Z"
}
```

### AP.3 DNS Management UI

**PowerDNS Zone Management (IPv6 Support):**

The DNS management section of the admin panel (section D in ADMIN_PANEL_REQUIREMENTS.md) allows admins to add, edit, and delete both A and AAAA records for client domains.

| UI Action | API call | Notes |
|-----------|----------|-------|
| **Add AAAA record** | `POST /api/v1/admin/customers/{id}/dns/{domain}/records` with `{ "type": "AAAA", "name": "@", "content": "2001:db8::1", "ttl": 60 }` | Validates IPv6 address format before submission |
| **List all records** | `GET /api/v1/admin/customers/{id}/dns/{domain}/records` | Returns A, AAAA, CNAME, MX, TXT records |
| **Delete AAAA record** | `DELETE /api/v1/admin/customers/{id}/dns/{domain}/records/{rrset_id}` | Requires confirmation modal |
| **Bulk add AAAA (new node)** | `POST /api/v1/admin/dns/bulk-add-aaaa` | Admin operation: add new worker IPv6 to all zones when a new node is added |
| **Verify DNS propagation** | `GET /api/v1/admin/customers/{id}/dns/{domain}/check` | Queries 3 external resolvers (1.1.1.1, 8.8.8.8, 2606:4700:4700::1111) and reports A + AAAA propagation status |

The DNS record editor in the UI validates IPv6 addresses using the browser's built-in `new URL()` validation and a regex (`/^[0-9a-fA-F:]+$/`) before sending to the API. The API performs a second validation via Node.js `net.isIPv6()` before passing to PowerDNS.

---

## Monitoring & Logging

### M.1 IPv6 Metrics (Prometheus)

**Collect Dual-Stack Metrics:**

NGINX Ingress Controller exposes a `remote_addr` label and an `ip_family` label (added in NGINX Ingress v1.9+) on the `nginx_ingress_controller_requests` metric. Use these to build dual-stack traffic dashboards.

```yaml
# k8s/base/monitoring/prometheus/rules/ipv6.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: ipv6-metrics
  namespace: monitoring
spec:
  groups:
    - name: ipv6
      interval: 60s
      rules:
        # Ratio of IPv6 to total requests (platform-wide)
        - record: platform:ipv6_request_ratio:rate5m
          expr: |
            sum(rate(nginx_ingress_controller_requests{ip_family="ipv6"}[5m]))
            /
            sum(rate(nginx_ingress_controller_requests[5m]))

        # Per-namespace IPv6 request rate
        - record: namespace:ipv6_requests:rate5m
          expr: |
            sum by (exported_namespace) (
              rate(nginx_ingress_controller_requests{ip_family="ipv6"}[5m])
            )

        # Alert if a worker node loses its IPv6 address
        - alert: NodeIPv6AddressMissing
          expr: kube_node_info{internal_ip!~".*:.*"} == 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "Node {{ $labels.node }} has no IPv6 address"
            description: "The node may have lost its IPv6 interface configuration."
```

Additional metrics from node-exporter:

```promql
# Network interface bytes received/sent over IPv6 (node-level)
rate(node_network_receive_bytes_total{device="eth0"}[5m])
# (filter by source IP family in access logs — Prometheus does not differentiate IPv4/IPv6 at NIC level)

# Number of IPv6 routes on each node
node_netstat_Ip6_InReceives
node_netstat_Ip6_OutRequests
```

### M.2 IPv6 Logging

**Log IPv6 Connections:**

NGINX Ingress logs client IP in the `$remote_addr` variable, which contains the actual client IP (IPv4 or IPv6) after the `X-Forwarded-For` header is processed. Loki collects these logs via Promtail.

```yaml
# k8s/base/monitoring/promtail/config.yaml  (relevant section)
# NGINX access log format includes $remote_addr which can be an IPv6 address.
# No special configuration needed — Loki stores the full string.

scrapeConfigs:
  - jobName: nginx-ingress
    pipelineStages:
      - regex:
          expression: '^(?P<remote_addr>[\d\.a-fA-F:]+) - (?P<remote_user>\S+) \[(?P<time_local>.+?)\] "(?P<request>.+?)" (?P<status>\d+) (?P<body_bytes_sent>\d+) "(?P<http_referer>.+?)" "(?P<http_user_agent>.+?)"'
      - labels:
          remote_addr:
          status:
      - template:
          source: remote_addr
          template: '{{ if contains ":" .Value }}ipv6{{ else }}ipv4{{ end }}'
          target: ip_family    # adds label 'ip_family=ipv4' or 'ipv6' to each log line
```

**Query IPv6 connections in Grafana/Loki:**

```logql
# Count IPv6 access log lines in the last hour:
count_over_time({job="nginx-ingress", ip_family="ipv6"}[1h])

# Show IPv6 client IPs connecting to a specific client domain:
{job="nginx-ingress"} |= "example-client.com" | ip_family="ipv6"
```

### M.3 Grafana Dashboards

**IPv6 Status Dashboard:**

A dedicated Grafana dashboard (`IPv4/IPv6 Dual-Stack Status`) is provisioned via ConfigMap in `k8s/base/monitoring/grafana/dashboards/ipv6.json`.

| Panel | Query | Visualization |
|-------|-------|--------------|
| **Platform IPv6 traffic %** | `platform:ipv6_request_ratio:rate5m * 100` | Stat (large number, green if > 10%) |
| **IPv6 req/sec by namespace** | `namespace:ipv6_requests:rate5m` | Time series, stacked by namespace |
| **IPv4 vs IPv6 request rate** | Two series: `ip_family="ipv4"` and `ip_family="ipv6"` | Time series |
| **Nodes with dual-stack** | `kube_node_info` joined with node IP metadata | Table: node name, IPv4, IPv6, status |
| **AAAA record coverage** | Custom metric from management API scrape endpoint | Gauge (0–100%) |
| **IPv6 error rate** | `nginx_ingress_controller_requests{ip_family="ipv6",status=~"5.."}` | Time series |
| **Top IPv6 client IPs** | Loki query aggregated by `remote_addr` with `ip_family="ipv6"` | Bar chart (top 10) |

The dashboard is tagged `ipv6`, `networking`, `dual-stack` and added to the `Platform Overview` folder in Grafana. Alert thresholds:
- IPv6 request ratio drops below 5% after Phase 1.5 rollout → warning (possible AAAA record issue)
- Any node loses IPv6 address → warning (see `NodeIPv6AddressMissing` alert in M.1)

---

## Testing & Validation

### T.1 IPv6 Test Suite

**Phase 1.5 Testing Requirements:**

The Phase 1.5 dual-stack rollout must pass all of the following tests before production traffic is switched:

| Test | Command | Pass Condition |
|------|---------|---------------|
| Node has IPv6 address | `kubectl get nodes -o wide` | All nodes show IPv6 in `INTERNAL-IP` column |
| Pod gets dual-stack IPs | `kubectl get pods -o wide -A` | Each pod has two IPs (one IPv4, one IPv6) |
| Service has dual-stack ClusterIPs | `kubectl get svc management-api -n platform` | Two ClusterIPs listed |
| NGINX binds on IPv6 | `kubectl exec -n ingress-nginx ds/ingress-nginx-controller -- ss -tlnp` | Shows `:::80` and `:::443` |
| DNS returns AAAA | `dig AAAA test-client.platform.example.com @ns1` | One or more AAAA records returned |
| HTTPS via IPv6 | `curl -6 -I https://test-client.platform.example.com` | `HTTP/2 200` |
| TLS cert valid over IPv6 | `openssl s_client -connect [2a01:4f8::1]:443 -servername test-client.platform.example.com` | Certificate CN matches, no error |
| Management API reachable over IPv6 | `curl -6 https://admin.platform.example.com/api/v1/health` | `{"status":"ok"}` |
| Calico IPv6 IP pool active | `kubectl get ippool` | Shows IPv6 pool with allocated blocks |
| No regressions over IPv4 | Full existing test suite | All existing tests pass |

**k6 Load Test Script:**

```javascript
// tests/load/ipv6-dual-stack.k6.js
// Run with: k6 run --out prometheus=remote_write_url tests/load/ipv6-dual-stack.k6.js
// Requires a test runner with IPv6 connectivity to the platform.

import http from 'k6/http'
import { check, sleep } from 'k6'

export const options = {
  vus: 50,
  duration: '2m',
  thresholds: {
    http_req_failed:   ['rate<0.01'],    // < 1% errors
    http_req_duration: ['p(95)<500'],    // 95th percentile < 500ms
  },
}

const BASE_URL = 'https://test-client.platform.example.com'

export default function () {
  // Test IPv6 request (k6 will use AAAA record if available and runner has IPv6)
  const resIPv6 = http.get(BASE_URL, {
    headers: { 'X-Test-IP-Family': 'ipv6' },
    tags: { ip_family: 'ipv6' },
  })
  check(resIPv6, {
    'IPv6 status 200': (r) => r.status === 200,
    'IPv6 response time < 500ms': (r) => r.timings.duration < 500,
  })

  // Test IPv4 request (force with 'ipv4only' DNS resolver hint if supported)
  const resIPv4 = http.get(BASE_URL, {
    headers: { 'X-Test-IP-Family': 'ipv4' },
    tags: { ip_family: 'ipv4' },
  })
  check(resIPv4, {
    'IPv4 status 200': (r) => r.status === 200,
    'IPv4 response time < 500ms': (r) => r.timings.duration < 500,
  })

  sleep(1)
}
```

### T.2 IPv6 Adoption Tracking

**Monitor IPv6 Adoption Over Time:**

Track the platform's IPv6 adoption rate using Prometheus metrics and a weekly report:

```promql
# Weekly IPv6 adoption rate (% of requests over IPv6):
100 * sum(increase(nginx_ingress_controller_requests{ip_family="ipv6"}[7d]))
    / sum(increase(nginx_ingress_controller_requests[7d]))
```

| Milestone | Target date | Target IPv6 % |
|-----------|-------------|--------------|
| Phase 1.5 rollout | Week 13 | AAAA records exist; IPv6 % depends on client base |
| Month 3 post-rollout | Week 25 | ≥ 10% of requests over IPv6 |
| Month 6 | Week 38 | ≥ 20% of requests over IPv6 |
| Year 2 | — | ≥ 50% (matching global internet IPv6 adoption trends) |

A Grafana annotation is added at the Phase 1.5 go-live timestamp to mark the baseline. The weekly IPv6 adoption % is logged to the `platform_metrics` table for trend reporting in the admin panel's infrastructure overview.

---

## Troubleshooting

### T.1 Common IPv6 Issues

| Issue | Symptom | Resolution |
|-------|---------|-----------|
| **AAAA record missing** | `dig api.platform.com AAAA` returns nothing | Add AAAA record to PowerDNS |
| **IPv6 client can't connect** | `curl -6 http://api.platform.com` times out | Check firewall UFW rules, ingress config |
| **Pod IPv6 unreachable** | `ping -6 <ipv6-pod-ip>` fails | Check Calico/CNI IPv6 config, network policies |
| **Service has no IPv6 ClusterIP** | `kubectl get svc` shows only IPv4 | Enable dual-stack: `ipFamilyPolicy: PreferDualStack` |
| **Load balancer missing IPv6** | Only IPv4 public address | Check cloud provider config (Hetzner, AWS, Azure) |
| **DNS resolves IPv6 to IPv4** | `curl -6` still uses IPv4 | Check DNS resolver, IPv6-only test: `curl -6 --ipv6 ...` |
| **IPv6 performance slow** | IPv6 traffic 10x slower | Check ISP IPv6 path, MTU (should be 1280+) |
| **App won't bind to IPv6** | Service starts but IPv6 connections fail | Change bind address from `127.0.0.1` to `::` |

### T.2 Debugging Commands

```bash
# ── Verify node dual-stack addresses ──────────────────────────────────
kubectl get nodes -o wide
# Look for both IPv4 and IPv6 in the INTERNAL-IP column

# ── Check pod dual-stack IPs ──────────────────────────────────────────
kubectl get pods -o wide -A
# Each pod should show both an IPv4 and IPv6 podIP

# ── Check service dual-stack ClusterIPs ───────────────────────────────
kubectl get svc -A
# Services with ipFamilyPolicy: PreferDualStack show two ClusterIPs

# ── DNS — verify AAAA records exist ───────────────────────────────────
dig AAAA api.platform.internal
dig AAAA example.com @ns1.platform.internal

# ── Test IPv6 connectivity from outside ───────────────────────────────
curl -6 -I https://api.platform.internal          # HTTPS via IPv6
curl -6 -v http://example.com                     # HTTP via IPv6
ping6 api.platform.internal                       # ICMP ping over IPv6

# ── Test IPv6 from inside the cluster ─────────────────────────────────
kubectl run debug --image=nicolaka/netshoot -it --rm -- bash
# Inside pod:
ping6 2001:db8::1                                 # Ping a known IPv6 address
curl -6 http://[::1]:3000/health                  # Test backend on loopback
nmap -6 --open -p 80,443 example.com              # Port scan over IPv6

# ── Check Calico IPv6 configuration ───────────────────────────────────
kubectl get ippool -o yaml                         # Should show IPv6 pool
calicoctl get ippool -o yaml

# ── Verify NGINX Ingress binds on IPv6 ────────────────────────────────
kubectl exec -n ingress-nginx deploy/ingress-nginx-controller -- \
  ss -tlnp | grep -E ':80|:443'
# Should show:   :::80   and   :::443   (IPv6 wildcard = all interfaces incl. IPv4)

# ── Check k3s dual-stack cluster CIDR ────────────────────────────────
kubectl get node <node-name> -o jsonpath='{.spec.podCIDRs}'
# Should return both an IPv4 CIDR (e.g. 10.42.0.0/24) and IPv6 CIDR

# ── Firewall — check IPv6 rules on node ───────────────────────────────
sudo ip6tables -L -n -v                           # View IPv6 iptables rules
sudo ufw status verbose | grep v6                 # UFW IPv6 rules

# ── MTU check (IPv6 minimum is 1280 bytes) ────────────────────────────
ip link show eth0 | grep mtu
# Should be >= 1280; recommended 1500 (standard Ethernet)

# ── PowerDNS — check AAAA record management ───────────────────────────
pdnsutil list-all-zones
pdnsutil show-zone example.com | grep AAAA
curl -s -H "X-API-Key: $PDNS_API_KEY" \
  http://localhost:8081/api/v1/servers/localhost/zones/example.com. \
  | jq '[.rrsets[] | select(.type == "AAAA")]'
```

---

## Summary: IPv4 & IPv6 Dual-Stack Roadmap

### Timeline

| Week | Activity | Owner |
|------|----------|-------|
| **1–12** | Phase 1 MVP: IPv4-only, single-stack k3s with Flannel CNI | Platform team |
| **13** | Phase 1.5 maintenance window (~2h): CNI migration Flannel → Calico | Platform team |
| **13** | Enable k3s dual-stack (`--cluster-cidr`, `--service-cidr` with IPv6 ranges) | Platform team |
| **13** | Update all catalog images to bind on `::` (see C.1 migration script) | Platform team |
| **13** | Add AAAA records to PowerDNS for all existing client domains | Platform team |
| **13** | Configure NGINX Ingress `bind-address: "::"` ConfigMap patch | Platform team |
| **13** | IPv6 firewall rules (UFW + Hetzner Cloud Firewall) | Platform team |
| **13** | T.1 test suite — all checks must pass before go-live | Platform team |
| **14–16** | Phase 2: IPv6 Prometheus metrics + Grafana dashboard (M.1–M.3) | Platform team |
| **14–16** | Per-client IPv6 stats in admin panel (AP.1–AP.2) | Backend dev |
| **14–16** | IPv6 load test in CI pipeline (T.1 k6 script added to GitHub Actions) | Backend dev |

### Implementation Checklist

**Phase 1.5 (Week 13):**
- ☐ Enable dual-stack in k3s cluster
- ☐ Configure Calico/CNI for IPv6
- ☐ Update all container images for IPv6
- ☐ Add AAAA records to PowerDNS
- ☐ Configure load balancer for IPv6
- ☐ Update NGINX ingress config
- ☐ Test DNS resolution (A + AAAA)
- ☐ Test client connectivity (IPv4 + IPv6)

**Phase 2+:**
- ☐ Monitor IPv6 adoption in Grafana
- ☐ Track IPv6 traffic metrics
- ☐ Optimize IPv6 performance
- ☐ Plan IPv6-only clients (future)
- ☐ Enable IPv6-only DNS records (future)

### Key Metrics

| Metric | Phase 1.5 | Month 6 | Year 2 |
|--------|-----------|---------|--------|
| IPv6 Support | 100% platform | 100% platform | 100% platform |
| IPv6 Client Access | Enabled | ~20% adoption | ~50% adoption |
| Dual-Stack Kubernetes | Enabled | Stable | Mature |
| DNS AAAA Records | All domains | All domains | All domains |
| Load Balancer IPv6 | Enabled | Optimized | Mature |

---

**Status:** ✅ Complete IPv4 & IPv6 dual-stack specification ready for Phase 1.5 implementation

