# Security / Firewall / Node Hardening — Operator Runbook

**Audience:** Platform operators with super_admin role.
**Related:** [SECURITY_HARDENING_ROADMAP.md](SECURITY_HARDENING_ROADMAP.md) (design + phase plan), [CLUSTER_NETWORK.md](CLUSTER_NETWORK.md), [SECRETS_LIFECYCLE.md](SECRETS_LIFECYCLE.md).

## Page tour

`/settings/security-hardening` is super_admin only. Six tabs:

| Tab | What you see | Action |
|---|---|---|
| **Overview** | SSH-public node count, critical CIS failures, stale probe reports, Phase 2 augmentation cards (Calico WG, TLS expiries, backup health, audit-log health, reserved-hostname collisions) | Read-only |
| **SSH Lockdown** | Per-node SSH posture, sshd_config flags, restriction mode badge | "Restrict to mesh" runbook modal per node |
| **Mesh Status** | Detected mesh provider per node (NetBird/Tailscale/WireGuard/none), peer count, last handshake | Copy install snippets for the three providers |
| **Firewall Posture** | nft mode, trusted ranges + cluster peers counts, public ports per node | Deep-link to `/settings/cluster-network` for CR CRUD |
| **Node Hardening** | Per-node CIS-style check matrix | "Hide info-only" toggle |
| **Security Events** | Last 50 audit-log rows filtered to security-relevant resource types | Read-only |

Top-right buttons:
- **Refresh probe** — bumps an annotation on the `security-probe` DaemonSet to trigger a rolling restart (forces an early collect within ~60s).
- **Reload** — re-fetches the snapshot from the backend without restarting probe pods.

## How the data gets there

```
┌──────────────────────────────┐
│  security-probe DaemonSet    │  one pod per node, every 60s:
│  (read-only host mounts)     │   - parse /etc/ssh/sshd_config
│                              │   - detect wt0/tailscale0/wg0
│                              │   - sample /proc/net/nf_conntrack
│                              │   - read /etc/hosting-platform/
│                              │     firewall.conf
│                              │   - write ConfigMap per node
└──────────┬───────────────────┘
           │ writes
           ▼
┌──────────────────────────────┐
│  ConfigMap                   │  security-probe-<node-name>
│  platform-system             │  data.snapshot = <json>
└──────────┬───────────────────┘
           │ reads
           ▼
┌──────────────────────────────┐
│  backend                     │  GET /admin/security-hardening
│  modules/security-hardening/ │  composes all per-node snapshots
└──────────┬───────────────────┘  + firewall posture + audit feed
           │ JSON envelope        + Phase 2 cards
           ▼
┌──────────────────────────────┐
│  admin panel                 │  /settings/security-hardening
└──────────────────────────────┘
```

The probe never mutates the host. It only reads:
- `/etc/ssh/sshd_config` + `/etc/ssh/sshd_config.d/*` (parse merged)
- `/proc/sys/kernel/osrelease`, `/etc/os-release`, `/proc/stat`
- `/sys/class/net/*` (interface enumeration), `/proc/net/wireguard` (peer counts)
- `/proc/net/nf_conntrack` (recent denies)
- `/etc/hosting-platform/firewall.conf` (operator-declared posture)
- `/usr/sbin/` + `/usr/bin/` (binary presence checks: fail2ban / sshguard / unattended-upgrades)

`securityContext` drops ALL capabilities, sets `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false`, `seccompProfile: RuntimeDefault`. No `hostNetwork`, no `hostPID`, no privileged. Runs as root inside the container only because `/etc/ssh/sshd_config` is root-readable on most distros.

## SSH-via-mesh: the lockdown runbook

> **WARNING.** Get this wrong and you lose SSH access on the affected node. ALWAYS verify console / KVM / cloud-rescue access first. The runbook modal in the admin panel enforces a typed-hostname confirmation + a "I have console access" acknowledgement BEFORE revealing the command.

### Phase 0 — Pre-flight (one-time per node)

1. Install ONE of the three mesh providers on the target node. The platform doesn't bundle these; you choose:

   **NetBird** (recommended for managed deployments):
   ```bash
   curl -fsSL https://pkgs.netbird.io/install.sh | sh
   netbird up --management-url https://<your-mgmt-url> --setup-key <KEY>
   ```

   **Tailscale** (recommended for SaaS convenience):
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up --auth-key=<KEY>
   ```

   **WireGuard** (fully self-hosted, no external coordinator):
   ```bash
   apt-get install -y wireguard
   # Put your config at /etc/wireguard/wg0.conf:
   #   [Interface]
   #   PrivateKey = ...
   #   Address    = 10.0.0.2/24
   #   [Peer]
   #   PublicKey  = ...
   #   AllowedIPs = 10.0.0.0/24
   #   Endpoint   = <hub-ip>:51820
   systemctl enable --now wg-quick@wg0
   ```

2. Verify connectivity from your operator workstation to the node via the mesh interface:
   ```bash
   ssh root@<node-mesh-ip>
   ```
   You should see the same prompt as you do via the public IP.

3. Refresh the admin page — Mesh Status tab should now show your provider with `peerCount > 0` (where reported).

### Phase 1 — Add a trusted-range fallback (highly recommended)

If your mesh agent ever goes down, you can still SSH from any IP in `trusted_ranges_v4` / `v6`. Seed your operator workstation IP:

- Go to `/settings/cluster-network` → Trusted Ranges → "+ Add range"
- CIDR: your operator workstation IP (e.g. `203.0.113.5/32`)
- Description: e.g. `ops-laptop-fallback`

The `--ssh-via-mesh` rule emits BOTH a mesh-interface scope AND a `trusted_ranges_v{4,6}` saddr fallback, so a workstation in this list survives a mesh-agent outage.

### Phase 2 — Lock down SSH

On the target node:
```bash
bash bootstrap.sh \
  --rejoin \
  --ssh-via-mesh wt0      # or tailscale0, wg0 — whichever the probe detected
```

`bootstrap.sh` will:
1. Detect the interface exists (warns + sleeps 10s if not — Ctrl-C to abort).
2. Rewrite `/etc/nftables.conf` replacing `tcp dport 22 accept` with:
   ```nft
   iif "wt0"                          tcp dport 22 accept
   ip  saddr @trusted_ranges_v4       tcp dport 22 accept
   ip6 saddr @trusted_ranges_v6       tcp dport 22 accept
   ```
3. Persist `/etc/hosting-platform/firewall.conf` with `SSH_VIA_MESH=true` so the probe reports the new state.
4. `systemctl enable nftables` + `nft -f` the new ruleset.
5. SSH service is NOT restarted — only the firewall rule is rewritten. Existing SSH sessions stay up.

### Phase 3 — Verify

- Wait ~60s. The probe re-publishes. Refresh the admin page.
- Overview tab's "SSH publicly exposed" count should decrement.
- SSH Lockdown tab — the node's badge flips from `public` → `mesh + trusted`.
- New connection from the public IP — refused.
- New connection from the mesh IP OR from any trusted-range IP — accepted.

## Break-glass recovery

If you lose mesh access AND your trusted-range fallback isn't seeded:

1. **Hetzner Cloud / Rescue mode**: boot into rescue, mount the root volume, edit `/etc/nftables.conf` to restore `tcp dport 22 accept`, `nft -f /etc/nftables.conf`, reboot.
2. **Cloud-init userdata** (AWS/GCP/DO): re-provision with a `runcmd` that overwrites `/etc/nftables.conf`.
3. **Direct console / KVM**: `nft add rule inet filter input tcp dport 22 accept` for an immediate temp opening, then edit `/etc/nftables.conf` and `bootstrap.sh --rejoin` (without `--ssh-via-mesh`) to persist.

## CIS-style checks (Phase 1)

The probe emits a fixed set of 10 findings per node. All are encoded in `images/security-probe/hardening.go:buildCISFindings`.

| ID | Severity | Rule |
|---|---|---|
| SSH-001 | high | `PermitRootLogin no` |
| SSH-002 | high | `PasswordAuthentication no` |
| SSH-003 | medium | `AllowUsers` whitelist non-empty |
| SSH-004 | info | `Port ≠ 22` (security through obscurity, informational only) |
| SSH-005 | medium | `KbdInteractiveAuthentication no` |
| KERNEL-001 | medium | Boot age `< 90 days` |
| KERNEL-002 | medium | No pending kernel update |
| HARDEN-001 | medium | `fail2ban` OR `sshguard` present |
| HARDEN-002 | medium | `unattended-upgrades` or `dnf-automatic` installed |
| NET-001 | **critical** | SSH not exposed to `0.0.0.0/0` |

When `sshd_config` parsing fails (file unreadable, drop-in conflict, etc.), SSH-001..005 all show `(sshd_config parse failed)` in the observed column and are marked non-passing. We never report a parse failure as "secure."

## Phase 2 cards on the Overview tab

- **Calico WireGuard (UDP/51821)**: cross-references probe-reported public UDP ports per node. Calico's pod-to-pod WG is independent of operator SSH-via-mesh; this card reassures operators that locking down SSH does NOT affect pod encryption.
- **Audit log health**: rolling 7d insert rate + seconds-since-last-insert. Flags `gapSuspected` if the gap exceeds 4× the expected gap (a basic anomaly detector against audit-logger compromise).
- **TLS certs expiring < 30d**: pulls from `certificates.cert-manager.io` cluster-wide. Sorted by `daysRemaining` ascending.
- **Backup targets**: per-target `encryption_at_rest`, last connection test, last successful snapshot. Surfaces unencrypted off-site backups and stale targets as security risks.
- **Reserved-hostname collisions**: feed of `RESERVED_PLATFORM_HOSTNAME` 409s from ADR-040 — tenant probing or accidental misconfig.

## CI guards

- `scripts/ci-firewall-check.sh` — validates bootstrap.sh has the right SSH rendering paths AND dual-stack symmetry on saddr scopes.
- `scripts/test-ssh-via-mesh.sh` — re-runs ci-firewall-check + asserts firewall.conf persistence format (3 cases: mesh-off, wt0, tailscale0).

Both should pass on every PR; both will be wired into CI under `Infrastructure CI`.

## Operator FAQ

**Q: Can I undo `--ssh-via-mesh` without locking myself out?**
A: Yes — re-run `bootstrap.sh --rejoin` (no `--ssh-via-mesh` flag). The conditional rendering in bootstrap.sh restores `tcp dport 22 accept`.

**Q: What if I lose access to my mesh provider's control plane (NetBird outage, Tailscale offline)?**
A: Your `trusted_ranges_v{4,6}` saddr fallback still works — the SSH-via-mesh ruleset emits both paths. This is exactly why we recommend seeding your operator workstation IP in trusted ranges BEFORE locking down.

**Q: Does this affect Calico WG (UDP/51821) or pod-to-pod traffic?**
A: No. Calico WG is a separate concern (pod-to-pod encryption with public-key auth, always exposed on UDP/51821). The Phase 2.5.1 "Calico WG verification" card on the Overview tab confirms it remains operational.

**Q: My probe ConfigMap is stale — what's wrong?**
A: Check `kubectl -n platform-system logs daemonset/security-probe`. Common causes: kube-API outage (probe can't write), node out of disk, image pull stuck. The Refresh button bumps an annotation that triggers a rolling restart of probe pods.

**Q: The probe didn't detect my mesh interface.**
A: The probe enumerates `/sys/class/net/` for the well-known names `wt0` (NetBird), `tailscale0` (Tailscale), `wg0` (WireGuard). If you've renamed your interface, the probe will report `provider: none`. Either rename the interface back to a convention name or run with the convention defaults.
