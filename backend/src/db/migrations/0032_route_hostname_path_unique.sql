-- Allow same hostname with different paths by replacing the hostname-only
-- unique index with a composite (hostname, path, domain_id) unique index.

DROP INDEX IF EXISTS ingress_routes_hostname_unique;

CREATE UNIQUE INDEX ingress_routes_hostname_path_domain_unique
  ON ingress_routes (hostname, path, domain_id);
