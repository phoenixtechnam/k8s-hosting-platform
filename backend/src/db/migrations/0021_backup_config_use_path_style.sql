-- R-X17 follow-up: per-target S3 path-style addressing toggle.
--
-- The backup-rclone-shim's versitygw S3 backend takes `--use-path-style`,
-- which forces path-style URLs (`https://endpoint/bucket/key`). This is
-- correct for Hetzner Object Storage, Backblaze B2, Cloudflare R2,
-- Wasabi, MinIO, Garage, SeaweedFS, Ceph RGW with default config.
--
-- AWS S3 increasingly requires virtual-hosted-style URLs
-- (`https://bucket.endpoint/key`) for new buckets. Set to false to
-- disable the --use-path-style flag for AWS-style endpoints.
--
-- Default true: preserves today's behaviour for every existing row,
-- which all point at S3-compatible providers (Hetzner Object Storage
-- on staging, MinIO on dev).
ALTER TABLE backup_configurations
  ADD COLUMN s3_use_path_style boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN backup_configurations.s3_use_path_style IS
  'When true, the shim passes --use-path-style to versitygw. False enables virtual-hosted-style URLs (AWS S3). Ignored for non-S3 storage_type.';
