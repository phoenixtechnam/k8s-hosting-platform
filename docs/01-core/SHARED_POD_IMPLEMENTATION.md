# Shared Pod Implementation Guide

> **SUPERSEDED by ADR-024 (2026-03-27)**

This document previously described the shared pod architecture where multiple Starter
clients were co-located in a single NGINX + PHP-FPM pod with per-client PHP-FPM pools,
`open_basedir` isolation, and server block routing.

**That model has been removed.** All clients now receive a dedicated pod in their own
`client-{id}` namespace, regardless of plan tier. Plan differentiation is achieved
through ResourceQuota limits and feature gating, not isolation model differences.

## See Instead

- **[HOSTING_PLANS.md](../06-features/HOSTING_PLANS.md)** — Plan tiers, resource limits, and feature matrix
- **[WORKLOAD_DEPLOYMENT.md](./WORKLOAD_DEPLOYMENT.md)** — Dedicated pod provisioning workflow
- **[ARCHITECTURE_DECISION_RECORDS.md](../07-reference/ARCHITECTURE_DECISION_RECORDS.md)** — ADR-024: Dedicated pods for all clients
