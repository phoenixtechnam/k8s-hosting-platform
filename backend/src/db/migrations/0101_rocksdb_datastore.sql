-- Phase 1: Track Stalwart DataStore type + pinned node
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS mail_datastore_type varchar(20) NOT NULL DEFAULT 'postgres',
  ADD COLUMN IF NOT EXISTS mail_rocksdb_node_name varchar(253);
