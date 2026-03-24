# Archived Documentation

> These files document infrastructure that has been **outsourced to a separate infrastructure project** per [ADR-022](../07-reference/ARCHITECTURE_DECISION_RECORDS.md#adr-022-architectural-separation--external-dns-netbird--iam).

The K8s hosting platform now **consumes** these services via external APIs rather than deploying them directly.

## Archived Files

| File | Original Location | Content |
|------|-------------------|---------|
| `DISPERSED_DNS_ARCHITECTURE.md` | `01-core/` | Multi-region DNS deployment architecture (ns1/ns2) |
| `POWERDNS_INTEGRATION.md` | `01-core/` | PowerDNS deployment, Docker Compose, zone provisioning |
| `NS_SERVERS_OPERATIONS.md` | `02-operations/` | NS server operations, Ansible playbooks, troubleshooting |
| `NETBIRD_CERTIFICATE_BOOTSTRAP.md` | `04-deployment/` | NetBird certificate bootstrap procedure |
| `NETBIRD_SIGNAL_CORRECTION.md` | `04-deployment/` | NetBird signal server configuration |

## Where This Content Lives Now

These files should be migrated to the **infrastructure project repository** which manages:
- PowerDNS deployment (ns1/ns2)
- NetBird WireGuard mesh
- Dex/OIDC provider
- Ansible automation for VPS provisioning
