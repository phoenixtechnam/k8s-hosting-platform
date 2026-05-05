# Stalwart BlobStore Backend Migration

This doc covers what happens when an operator switches the Stalwart 0.16
BlobStore singleton between backends via the **Email Management →
Stalwart Blob Storage** card in the admin panel.

**One-line takeaway:** existing blobs DO NOT migrate automatically. The
switch is online and applies to all NEW mail; the OLD mail stays in the
previous store and may become unreachable until you run an external
migrator.

---

## Backends

| Backend | Storage location | HA-compatible | Recommended for |
|---|---|---|---|
| `Default` | mail-pg PG (the configured DataStore) | yes | shipped default; small clusters (<5 GiB blob volume) |
| `S3` | external S3-compatible bucket | **yes (required for HA)** | production HA + any cluster expected to grow >5 GiB |
| `FileSystem` | per-Pod local emptyDir | **no** | single-replica only; useful for spike or air-gapped dev |

The platform UI deliberately exposes only these three. Stalwart's
schema also supports `Sharded`, `Azure`, `FoundationDb`, `PostgreSql`,
`MySql` — those can be configured directly via `stalwart-cli update
BlobStore --field @type=...` from a cluster shell, but the admin panel
hides them because we don't ship the supporting infra (separate Azure
account, FoundationDB cluster, etc.).

## What "switching" actually does

The admin panel `Apply backend switch` button:

1. (S3 only) Writes/patches Secret `stalwart-blob-credentials` in the
   `mail` namespace with `S3_ACCESS_KEY` / `S3_SECRET_KEY`.
2. Spawns a one-shot Job named `stalwart-blob-store-update-<id>` in the
   `mail` namespace. The Job:
   - Downloads sha256-pinned `stalwart-cli v1.0.4`.
   - Logs the BEFORE state (`stalwart-cli get BlobStore`).
   - Runs `stalwart-cli update BlobStore --field @type=...` (with field
     values for the chosen backend; for S3 the keys flow via env from
     the Secret, **never** argv).
   - Logs the AFTER state.
   - Self-verifies that `@type` actually changed; non-match exits
     non-zero so K8s marks the Job Failed.
3. The cli's UPDATE call is in-flight against the running Stalwart
   process — Stalwart applies the new BlobStore config to its in-memory
   store immediately. **No Stalwart restart**.

The admin panel polls the Job until terminal and surfaces the cli
BEFORE / AFTER output via the Pod log. Job retains for 86400 s
(1 day) for forensics; after that K8s GCs it.

## What does NOT happen

- **Existing blobs are not copied.** An IMAP fetch for an old message
  hits the new backend, the new backend has no record of the blob, and
  Stalwart returns a `BlobNotFound` error to the IMAP client. From the
  user's perspective the message body looks empty / missing.
- **Stalwart does not auto-migrate.** Stalwart 0.16 has no built-in
  blob-mover. The `stalwart-cli` does not ship a `move-blobs` command.
- **The Secret persists across switches.** Switching from S3 to
  Default leaves `stalwart-blob-credentials` in place. That's fine —
  the Secret is harmless when not referenced. To remove it:
  `kubectl delete secret stalwart-blob-credentials -n mail` after the
  switch.

## Recovery if you switched by accident

If you flipped the backend without running a migrator and now need
historical mail back:

1. **Don't panic** — the old blobs are still there in the previous
   backend. Stalwart just isn't looking at them.
2. Switch back via the same admin panel card. New mail since the
   accident lands in the original backend; mail received during the
   accident-window stays in the wrongly-flipped backend.
3. If you need both windows visible, you need a manual migration
   (next section).

## Manual migration tools

There is no platform-shipped migration tool. The community options:

- **For Default → S3 (or vice versa)**: `pgdump` mail-pg's blob table
  and bulk-PUT into S3 (or pipe S3 GETs into psql), preserving the
  blob hash IDs. Stalwart's blob hash is content-addressed
  (`sha256(uncompressed)`), so the same blob keeps the same key on
  either backend — a 1:1 copy.
- **For S3 → S3 (provider migration)**: any standard S3 sync tool
  works. `rclone sync src: dst:` is the most common.
- **For FileSystem migrations**: walk the directory tree, hash-rename
  the same content into the target store, point Stalwart at the new
  location. A FileSystem layout's directory depth (default 2 = `xx/yy/`)
  must match between source + target.

For platforms expecting heavy migration traffic, build a one-shot
Kubernetes Job that:
1. Reads from the source store directly (mount mail-pg PG, or use
   AWS SDK against S3, etc.)
2. Writes to the target store at the same content-addressed key
3. Verifies SHA256 of round-tripped blobs.

That Job is out of scope for the admin-panel surface. File a feature
request if it becomes a recurring need.

## When is the switch the right call?

- **Default → S3**: when blob volume crosses ~3-5 GiB and PG-side
  costs (CNPG instance disk pressure, snapshot bloat) outweigh
  external-bucket complexity. Required before turning on HA stateless
  Stalwart.
- **S3 → Default**: never reversibly. If you need to wind back, you're
  almost always migrating to a new cluster.
- **Default → FileSystem**: only for single-replica spikes or
  air-gapped dev. Will explicitly fail Apply HA.
- **FileSystem → anything**: as soon as you need multi-replica.

## Operator checklist before switching

- [ ] Read this doc (the confirm modal links here).
- [ ] Type `MIGRATE` in the confirm modal — explicit acknowledgement
      that you understand existing blobs will not move.
- [ ] (S3) Have bucket created + access keys ready. Cleartext keys are
      sent ONCE to the API; the admin panel zeroes the form fields on
      submit; Stalwart reads from the Secret thereafter.
- [ ] (FileSystem) Confirm you're on a single-replica Stalwart and
      will stay that way. Apply HA will fail otherwise.
- [ ] Capture the cli BEFORE/AFTER Pod log from the admin panel — it's
      the only auditable record of the switch's wire-level details.
