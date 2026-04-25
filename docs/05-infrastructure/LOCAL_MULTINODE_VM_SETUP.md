# Local Multi-Node VM Setup (Unraid)

> **Status:** PLANNED — not yet implemented.
> **Owner:** (unassigned)
> **Last updated:** 2026-04-21
> **Related:**
> - [`STAGING_DEPLOYMENT.md`](../04-deployment/STAGING_DEPLOYMENT.md) — the remote-first setup to use until this is built
> - [`MULTI_NODE_ROADMAP.md`](./MULTI_NODE_ROADMAP.md) — Phase 3 distributed storage
> - `scripts/bootstrap.sh` — will be reused verbatim inside each VM

---

## Why defer

The current local dev stack (DinD + `local-path` StorageClass) is fast and good enough for frontend/API work. The remote Hetzner staging server is good enough for real Longhorn/multi-node work. **We don't yet know how much friction the 150ms latency really adds.** Build this only once staging-first trial-and-error actually hurts.

### Concrete triggers to implement

Pull this doc off the shelf when **any** of these occur:

- ≥8 hours lost in one week to the 150ms latency on `kubectl` / `longhornctl` / `helm` iteration
- Need to reproduce a Longhorn replica-rebuild or node-failure bug that's too expensive to trigger on staging
- Need to test multi-node workload mobility (Phase 2 of the multi-node roadmap) with fast iteration
- Staging becomes shared (multiple developers) and trial-and-error starts blocking others
- Upgrade rehearsals (k3s, Longhorn, Calico major bumps) need a destructible multi-node target

Until then, iterate on staging directly.

---

## Three-tier architecture

Once implemented:

| Tier | Stack | Purpose | Typical rebuild |
|---|---|---|---|
| **1. DinD** (exists) | `rancher/k3s` single-container, `local-path` SC, no mail TCP | Frontend / API / unit smoke | ~20s |
| **2. Local VMs** (this doc) | 3-5 Ubuntu VMs on Unraid via `virsh`+cloud-init, real k3s + Longhorn | Trial-and-error: storage lifecycle, multi-node, GitOps reconcile, upgrade rehearsals | ~30-60s reconcile |
| **3. Remote staging** (exists) | Single Hetzner VPS, real DNS/TLS/NetBird | Pre-production sanity, external integrations, final validation before `main→stable` | push + wait |

### Which tier for which task

| Task | Tier |
|---|---|
| React component change | 1 |
| Zod contract change + API | 1 (typecheck) then 3 (E2E) |
| New Longhorn snapshot flow | **2** |
| Multi-node replica rebuild debug | **2** |
| Upgrade k3s/Longhorn/Calico | **2** then 3 |
| Cert-manager issuer flip | 3 (needs real ACME) |
| NetBird mesh integration | 3 (needs real network) |
| Disaster-recovery drill | 2 (destructible) then 3 (real-world parity) |

---

## VM topology

**Budget**: 7 VMs out of 10 VM headroom on Unraid. Total ~18 GB RAM, ~140 GB disk. Leaves slack for one-off experiments.

| Role | Count | vCPU | RAM | Disk | Notes |
|---|---|---|---|---|---|
| control-plane | 1 | 2 | 4 GB | 20 GB | k3s server, no workloads scheduled |
| worker | 3 | 2 | 4 GB | 40 GB | Longhorn needs ≥3 nodes for proper replica placement |
| dev-tools (optional) | 1 | 1 | 1 GB | 10 GB | kubeconfig host, Flux CLI, helm — skip if your workstation fills this role |
| spare | 2 | 2 | 4 GB | 40 GB | Reserve for testing node-fault recovery, rolling upgrades, storage migration |

**Networking**: libvirt bridge (`br0` — already configured on Unraid for VM manager). DHCP from Unraid or static IPs in a dedicated subnet (e.g. `10.99.0.0/24`). DNS for `*.local-staging.test` pointed at the control-plane IP.

---

## Parity with real staging

Every VM is bootstrapped with the **exact version pins** from [`scripts/bootstrap.sh`](../../scripts/bootstrap.sh) so drift between local and remote staging is zero:

```
K3S_VERSION="v1.33.10+k3s1"
CALICO_VERSION="v3.31.5"
LONGHORN_VERSION="v1.11.1"
INGRESS_NGINX_CHART_VERSION="4.15.1"
CERT_MANAGER_CHART_VERSION="v1.20.2"
SEALED_SECRETS_CHART_VERSION="2.17.4"
```

Same Ubuntu LTS version as the staging server. Same cloud-init. Same `bootstrap.sh` invocation — just with different arguments for role (cp/worker) and join token.

---

## Proposed commands

Create `scripts/local-vm.sh`, symmetric with `scripts/local.sh`:

```bash
./scripts/local-vm.sh up             # Provision + bootstrap full cluster (~3-5 min cold)
./scripts/local-vm.sh rebuild        # Apply latest manifests via Flux-style push  (~30s)
./scripts/local-vm.sh reset          # Nuke disks, fresh cluster, preserve VM shells
./scripts/local-vm.sh destroy        # Remove VMs entirely
./scripts/local-vm.sh down           # Shut down VMs (preserve state)
./scripts/local-vm.sh status         # Show cluster + VM health
./scripts/local-vm.sh kubectl …      # Proxy kubectl through the bastion/dev-tools host
./scripts/local-vm.sh logs <pod>     # Tail logs on a specific node

# Longhorn / multi-node specific
./scripts/local-vm.sh simulate-node-failure worker-2
./scripts/local-vm.sh force-replica-rebuild <volume>
./scripts/local-vm.sh drain <node>
./scripts/local-vm.sh upgrade-rehearsal --k3s v1.34.0+k3s1
```

Under the hood: `virsh` + cloud-init + libvirt (Unraid already has these installed via the VM manager). No Multipass needed — adding a second VM manager alongside Unraid's native one causes libvirt socket conflicts.

### Directory layout

```
scripts/
  local-vm.sh                      # Entry point
  local-vm/
    cloud-init/
      control-plane.yaml           # Runs bootstrap.sh as --join-as server
      worker.yaml                  # Runs bootstrap.sh as --join-as worker with join token
    libvirt/
      control-plane.xml.tmpl       # VM definition templates
      worker.xml.tmpl
    lib/
      provision.sh                 # virt-install wrapper
      waitfor.sh                   # Wait-for-IP, wait-for-k3s-ready helpers
```

---

## Optional: local GitOps mirror

Point a **local Flux** at a `local-staging` branch in the same repo. Iteration becomes:

1. Branch off `main` → `local-staging`
2. Commit changes to `local-staging`
3. Local Flux reconciles the local cluster (~30s)
4. Debug, iterate, commit
5. When happy, cherry-pick or fast-forward `staging` → `origin/staging`
6. Remote Flux reconciles actual staging

This tests the **exact GitOps pathway** production uses — zero `kubectl apply` bypasses. Without this, you risk local-only fixes that work imperatively but break under Flux.

To enable: one `k8s/base/flux/gitrepository-local.yaml` + `kustomization-local.yaml` in the local cluster, pointing at `branch: local-staging`.

---

## Backup target

Longhorn needs a backup target to test the backup side of snapshot → backup flows. On Unraid, the cleanest option is a **single MinIO VM or container** serving S3-compatible storage:

- 1 additional VM (or docker container on Unraid host) running `minio/minio:latest`
- Creates an `s3://longhorn-local/` bucket
- Longhorn `BackupTarget` configured to this endpoint
- Mirrors what staging does with its real S3 provider

Alternative: NFS-backed target from an Unraid share (simpler, faster, no MinIO process). Choose based on whether you want S3 API parity (MinIO) or speed (NFS).

---

## Effort estimate

| Item | Hours |
|---|---|
| `local-vm.sh` skeleton (up/down/rebuild/reset + virsh wrappers) | 3-4 |
| cloud-init templates that invoke `bootstrap.sh` unchanged | 2-3 |
| Networking: libvirt bridge integration, DNS for `*.local-staging.test` | 1-2 |
| Kubeconfig export + kubectl passthrough | 1 |
| Backup target (MinIO VM or NFS share) | 1-2 |
| Optional local-Flux install + `gitrepository-local.yaml` | 1 |
| Docs — update this file from PLANNED to LIVE, add operator runbook | 1 |
| **Total** | **10-14 hours** |

---

## Trade-offs vs keeping staging-first

### Pros
- Longhorn finally works properly — snapshot/backup/replica flows you actually trust
- Multi-node testing: node failure, drain, upgrade, replica rebuild — all the things that bite in production
- Trial-and-error is local → fast, no 150ms penalty, no fear of breaking staging
- Exact production parity → few "works on staging, breaks in prod" surprises
- Staging stays clean for genuine pre-prod validation

### Cons
- 10-14h one-time cost
- ~18 GB RAM + ~140 GB disk committed on Unraid
- Cold-boot takes 3-5 min vs 20s for DinD (tolerable because you mostly `rebuild`, not cold-boot)
- Two separate local stacks (DinD + VMs) → command discipline matters (`local.sh` vs `local-vm.sh`)

---

## Migration plan when triggered

1. Re-read this doc, update any stale version pins from current `bootstrap.sh`
2. Scaffold `scripts/local-vm.sh` + cloud-init + libvirt templates
3. Bring up one VM first, verify `bootstrap.sh` runs unchanged inside it
4. Expand to 3-node cluster, verify Longhorn replicas land on different nodes
5. Add local Flux if desired
6. Add backup target
7. Document divergences from staging (if any emerge)
8. Flip this doc from PLANNED to LIVE, add operator runbook

**Out of scope** for the initial implementation: Windows/Mac support (Unraid-only), multi-cluster federation, anything production-facing.

---

## Non-goals

- Not replacing the DinD stack — keep both
- Not replacing the staging server — keep both
- Not a general-purpose kind/k3d replacement — specifically for this platform's Longhorn + multi-node needs
- Not cross-platform — Unraid/libvirt only
