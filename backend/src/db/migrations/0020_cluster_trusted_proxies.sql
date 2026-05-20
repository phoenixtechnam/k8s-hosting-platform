-- 0020_cluster_trusted_proxies.sql
--
-- Operator-managed list of trusted upstream-proxy CIDRs. Materialised
-- by cluster-trusted-proxy-reconciler into:
--   1. ConfigMap `cluster-trusted-proxies` (nginx snippet + CSV)
--      mounted by admin-panel + tenant-panel as include glob
--   2. Traefik DS `--entryPoints.{web,websecure}.forwardedHeaders
--      .trustedIPs=` arg (JSON-patched in place)
--
-- Three sources:
--   - `system`    — hardcoded defaults baked into nginx.conf.template
--                   (RFC1918 + IPv6 ULA). Listed for visibility, not
--                   modifiable. Reconciler does NOT re-emit these
--                   into the ConfigMap (they're already in the static
--                   nginx template baseline).
--   - `bootstrap` — k3s pod/svc CIDRs detected at bootstrap and
--                   stored in `platform_settings`. Auto-seeded by
--                   reconciler on every tick (idempotent). Read-only
--                   in the UI (delete via bootstrap re-run).
--   - `operator`  — added via the admin UI (CDN, LB, floating IP).
--                   Full CRUD by super_admin.
--
-- CIDR uniqueness is enforced — preventing duplicate trust entries
-- across sources. The UNIQUE on lower(cidr) handles IPv6 case folding.

CREATE TABLE IF NOT EXISTS cluster_trusted_proxy_ranges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cidr TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('system', 'bootstrap', 'operator')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS cluster_trusted_proxy_ranges_cidr_idx
  ON cluster_trusted_proxy_ranges (lower(cidr));

CREATE INDEX IF NOT EXISTS cluster_trusted_proxy_ranges_source_idx
  ON cluster_trusted_proxy_ranges (source);
