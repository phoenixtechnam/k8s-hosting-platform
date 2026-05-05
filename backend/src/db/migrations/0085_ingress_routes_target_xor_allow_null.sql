-- 0085_ingress_routes_target_xor_allow_null.sql
--
-- Relax the `ingress_routes_target_xor` check constraint introduced in
-- migration 0076 (private-workers) so a route can exist in a "draft"
-- state with no target bound yet — the operator creates the route +
-- configures hostname / TLS / WAF / rate-limit etc. up front, then
-- assigns a deployment OR private worker via PATCH later.
--
-- Why this is safe:
--   * The Ingress reconciler (modules/domains/k8s-ingress.ts:306-311)
--     already short-circuits with `if (!backend) continue` when neither
--     target resolves — null-target routes simply don't generate an
--     Ingress rule yet. They're inert until bound.
--   * The previous "exactly one" rule was the source of the regression
--     where the admin-panel create-route form (hostname-only) produced
--     a 23514 constraint violation surfaced as "An unexpected error
--     occurred". The xor case ("both set") is still forbidden so we
--     never have ambiguous routing.
--
-- New permitted shapes:
--   1. (deployment_id IS NULL AND private_worker_id IS NULL) — draft
--   2. target_type='deployment' AND deployment_id IS NOT NULL
--                              AND private_worker_id IS NULL
--   3. target_type='private_worker' AND private_worker_id IS NOT NULL
--                                  AND deployment_id IS NULL

ALTER TABLE ingress_routes
  DROP CONSTRAINT ingress_routes_target_xor;

ALTER TABLE ingress_routes
  ADD CONSTRAINT ingress_routes_target_xor CHECK (
    -- 1. draft: no target bound yet
    (deployment_id IS NULL AND private_worker_id IS NULL)
    OR
    -- 2. bound to a deployment
    (target_type = 'deployment'
       AND deployment_id IS NOT NULL
       AND private_worker_id IS NULL)
    OR
    -- 3. bound to a private worker
    (target_type = 'private_worker'
       AND private_worker_id IS NOT NULL
       AND deployment_id IS NULL)
  );
