-- Post-M1 admin UI: add live-usage columns to cluster_nodes so the
-- Nodes page can render "2.3/4 cores · 12 pods" without a fresh k8s
-- query on every page load. The node-sync reconciler already owns k8s
-- access; extending its tick to list pods per node adds one
-- `listPodForAllNamespaces` call per tick (cheap at our scale).
--
-- All three columns are nullable — a node row can exist before the
-- reconciler has observed its pods (e.g. just-seeded 'staging' row
-- from migration 0046), and we render the bars with "—" instead of
-- "0 pods" in that case.

ALTER TABLE cluster_nodes
  ADD COLUMN scheduled_pods INTEGER,
  ADD COLUMN cpu_requests_millicores INTEGER,
  ADD COLUMN memory_requests_bytes BIGINT;
