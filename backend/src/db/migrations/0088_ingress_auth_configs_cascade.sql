-- Switch ingress_auth_configs.provider_id FK from ON DELETE RESTRICT to
-- ON DELETE CASCADE.
--
-- The original migration (0057_split_oidc_providers.sql) chose RESTRICT
-- with the intent that operators must clear ingress auth before
-- removing a per-client OIDC provider. In practice this collides with
-- the deleted-client lifecycle cascade: clients → client_oidc_providers
-- (ON DELETE CASCADE) is fine, but those rows can't actually be
-- deleted because their child ingress_auth_configs hold them via
-- RESTRICT. The result is that DELETE /api/v1/clients/:id returns
-- HTTP 400 FOREIGN_KEY_VIOLATION whenever any of the client's routes
-- has OIDC auth enabled — surfaced by integration-oidc-dex.sh
-- scenario 10.
--
-- Cascading the deletion is correct: an ingress_auth_configs row
-- without a provider_id is meaningless, so dropping the provider
-- should drop the dependent auth config automatically. UI flows
-- already require an explicit DELETE on `/clients/:cid/ingress-routes/
-- :rid/auth` before the operator can remove a provider via the
-- panel; the FK only matters for cascade-from-client-delete.

DO $$
DECLARE
  fk_name text;
BEGIN
  -- Postgres autogenerates the constraint name from
  -- "<table>_<column>_fkey" but older migrations may have a different
  -- name. Look it up by table+column.
  SELECT conname INTO fk_name
  FROM pg_constraint
  WHERE conrelid = 'ingress_auth_configs'::regclass
    AND contype = 'f'
    AND conkey @> ARRAY[(
      SELECT attnum FROM pg_attribute
      WHERE attrelid = 'ingress_auth_configs'::regclass
        AND attname = 'provider_id'
    )]
  LIMIT 1;

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE ingress_auth_configs DROP CONSTRAINT %I', fk_name);
  END IF;
END$$;

ALTER TABLE ingress_auth_configs
  ADD CONSTRAINT ingress_auth_configs_provider_id_fkey
    FOREIGN KEY (provider_id)
    REFERENCES client_oidc_providers(id)
    ON DELETE CASCADE;
