-- Mail placement policy: primary/secondary/tertiary nodes + DR state
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS mail_primary_node varchar(253),
  ADD COLUMN IF NOT EXISTS mail_secondary_node varchar(253),
  ADD COLUMN IF NOT EXISTS mail_tertiary_node varchar(253),
  ADD COLUMN IF NOT EXISTS mail_active_node varchar(253),
  ADD COLUMN IF NOT EXISTS mail_dr_state varchar(32) NOT NULL DEFAULT 'healthy',
  ADD COLUMN IF NOT EXISTS mail_auto_failover_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mail_failover_threshold_seconds integer NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS mail_last_failover_at timestamptz,
  ADD COLUMN IF NOT EXISTS mail_port_exposure_mode varchar(32) NOT NULL DEFAULT 'thisNodeOnly',
  ADD COLUMN IF NOT EXISTS mail_datastore_pvc_size_gi integer NOT NULL DEFAULT 20;
