//! rocksdb-secondary-checkpoint — verify Path B for no-downtime Stalwart archives.
//!
//! Opens a live Stalwart RocksDB primary as a SECONDARY instance (which
//! does NOT acquire the primary's LOCK), catches up the secondary's WAL/MANIFEST
//! view to the primary's latest committed state, then creates a hard-linked
//! checkpoint at a fresh directory the operator passes on argv.
//!
//! Why we bypass the high-level `rocksdb` crate:
//!   The crate's `Checkpoint::create_checkpoint(path)` hardcodes
//!   `log_size_for_flush=0` (see docs.rs/rocksdb/0.24.0/src/rocksdb/
//!   checkpoint.rs.html — `const LOG_SIZE_FOR_FLUSH: u64 = 0;`). A value of 0
//!   means "always Flush memtable to L0 before writing the checkpoint
//!   manifest" — a write operation a secondary cannot perform. Result on a
//!   secondary: `Status::NotSupported` from the underlying RocksDB call.
//!
//!   Setting `log_size_for_flush=u64::MAX` means "never trigger a Flush; just
//!   include WAL files in the checkpoint as-is." That's exactly what a
//!   secondary can do. So we call the C ABI directly to control this knob.
//!
//! Usage:
//!     rocksdb-secondary-checkpoint <primary_path> <secondary_path> <checkpoint_path>
//!
//! Why the explicit SST hard-link pass after `rocksdb_checkpoint_create`:
//!
//! On staging we observed `rocksdb_checkpoint_create` in secondary mode
//! producing a checkpoint dir containing ONLY `MANIFEST-*` + `CURRENT`,
//! with ZERO of the 17 SST files the MANIFEST references. Opening
//! that checkpoint as a primary in `stalwart -e` then fails with:
//!   "No such file or directory: .../000024.sst — MANIFEST may be
//!    corrupted."
//!
//! RocksDB documentation claims `CreateCheckpoint` in secondary mode
//! "would only hard-link the SST files mentioned in the secondary's
//! manifest" — but empirically with librocksdb-sys 0.17.3 the hard-
//! link pass is silently skipped (likely because the secondary's
//! dbname points at `/scratch/secondary/`, which has no SSTs of its
//! own; the SSTs live in the primary's data dir).
//!
//! Workaround: after `rocksdb_checkpoint_create` returns, manually
//! hard-link every `*.sst` file from the primary's data dir into the
//! checkpoint dir. Extra files (compacted-but-not-yet-deleted) are
//! harmless — RocksDB only opens files referenced by the MANIFEST.
//!
//! Exit codes:
//!     0  — checkpoint created (and chmod 0o777)
//!     1  — argv / preflight failure
//!     2  — open_as_secondary failed (primary may not exist, perms wrong, etc.)
//!     3  — try_catch_up_with_primary failed
//!     4  — checkpoint_object_create failed
//!     5  — checkpoint create failed (THIS is the load-bearing assertion —
//!          if this fails on staging, Path B is not viable on the current
//!          RocksDB version and we fall back to PR #29's scale-down approach)
//!     6  — chmod 0o777 on the checkpoint dir / files failed (checkpoint
//!          itself succeeded but the downstream non-root container won't
//!          be able to write the RocksDB LOG file)
//!     7  — explicit SST hard-link pass failed (see module docstring
//!          on why this pass is needed). Usually EXDEV — the operator
//!          configured the checkpoint dir on a different filesystem
//!          than the primary's data dir.
//!
//! The secondary directory MUST be writable by this process. RocksDB writes
//! the secondary instance's own MANIFEST + log files there — the primary's
//! data dir stays read-only.

use libc::{c_char, free};
use librocksdb_sys as ffi;
use std::ffi::{CStr, CString};
use std::os::unix::fs::PermissionsExt;
use std::process::ExitCode;
use std::ptr;
use std::time::Instant;

/// Wraps the rocksdb C-API errptr idiom: a `*mut c_char` is set on error,
/// must be `free`d by the caller, contains a null-terminated error string.
fn check_err(label: &str, err: *mut c_char) -> Result<(), String> {
    if err.is_null() {
        return Ok(());
    }
    // SAFETY: the rocksdb C API guarantees a null-terminated string here.
    let msg = unsafe { CStr::from_ptr(err).to_string_lossy().into_owned() };
    // SAFETY: rocksdb allocates with malloc; we must free with libc::free
    // (not Rust's allocator). See db/c.cc:SetError in the rocksdb source.
    unsafe { free(err as *mut _) };
    Err(format!("{label}: {msg}"))
}

fn run() -> Result<(), (i32, String)> {
    let mut args = std::env::args().skip(1);
    let primary = args
        .next()
        .ok_or((1, "missing argv[1]: primary_path".into()))?;
    let secondary = args
        .next()
        .ok_or((1, "missing argv[2]: secondary_path".into()))?;
    let checkpoint = args
        .next()
        .ok_or((1, "missing argv[3]: checkpoint_path".into()))?;

    eprintln!("primary    = {primary}");
    eprintln!("secondary  = {secondary}");
    eprintln!("checkpoint = {checkpoint}");

    // Preflight: secondary dir must exist + be writable. Don't auto-create
    // (an operator-readable error beats a 100ms-later malloc-failed line).
    let sec_metadata = std::fs::metadata(&secondary)
        .map_err(|e| (1, format!("stat({secondary}): {e}")))?;
    if !sec_metadata.is_dir() {
        return Err((1, format!("{secondary} is not a directory")));
    }

    // Primary path must exist + readable.
    std::fs::metadata(&primary).map_err(|e| (1, format!("stat({primary}): {e}")))?;

    // Checkpoint dir MUST NOT exist — RocksDB Checkpoint::Create creates it.
    if std::fs::metadata(&checkpoint).is_ok() {
        return Err((
            1,
            format!("{checkpoint} already exists — RocksDB Checkpoint refuses to overwrite"),
        ));
    }

    let primary_c = CString::new(primary.as_str()).map_err(|e| (1, e.to_string()))?;
    let secondary_c = CString::new(secondary.as_str()).map_err(|e| (1, e.to_string()))?;
    let checkpoint_c = CString::new(checkpoint.as_str()).map_err(|e| (1, e.to_string()))?;

    let t0 = Instant::now();

    // SAFETY: All raw-pointer dereferences below are paired with a
    // successful prior allocation + explicit Drop via the C destroy
    // functions in the cleanup block. We never observe a freed pointer
    // because we explicitly null `err` between calls.
    let result = unsafe {
        // ── Options: secondary mode requires max_open_files = -1
        // (must keep all FDs open so primary unlink doesn't break us).
        let opts = ffi::rocksdb_options_create();
        ffi::rocksdb_options_set_max_open_files(opts, -1);

        // ── DB::OpenAsSecondary
        let mut err: *mut c_char = ptr::null_mut();
        let db = ffi::rocksdb_open_as_secondary(
            opts,
            primary_c.as_ptr(),
            secondary_c.as_ptr(),
            &mut err,
        );
        if let Err(e) = check_err("open_as_secondary", err) {
            ffi::rocksdb_options_destroy(opts);
            return Err((2, e));
        }
        if db.is_null() {
            ffi::rocksdb_options_destroy(opts);
            return Err((2, "open_as_secondary returned null DB with no errptr".into()));
        }
        eprintln!("opened as secondary in {:?}", t0.elapsed());

        let t_catchup = Instant::now();
        // ── try_catch_up_with_primary — replays primary's MANIFEST + WAL tail.
        // Without this, secondary's view is frozen at the moment of Open.
        let mut err: *mut c_char = ptr::null_mut();
        ffi::rocksdb_try_catch_up_with_primary(db, &mut err);
        if let Err(e) = check_err("try_catch_up_with_primary", err) {
            ffi::rocksdb_close(db);
            ffi::rocksdb_options_destroy(opts);
            return Err((3, e));
        }
        eprintln!("try_catch_up_with_primary in {:?}", t_catchup.elapsed());

        // ── Checkpoint::Create with log_size_for_flush=u64::MAX
        // The default value 0 means "always Flush memtable first" → fails on
        // secondary because Flush is a write. u64::MAX means "always copy
        // WAL files, never Flush" → the operation a secondary can perform.
        let t_cp = Instant::now();
        let mut err: *mut c_char = ptr::null_mut();
        let cp = ffi::rocksdb_checkpoint_object_create(db, &mut err);
        if let Err(e) = check_err("checkpoint_object_create", err) {
            ffi::rocksdb_close(db);
            ffi::rocksdb_options_destroy(opts);
            return Err((4, e));
        }
        if cp.is_null() {
            ffi::rocksdb_close(db);
            ffi::rocksdb_options_destroy(opts);
            return Err((4, "checkpoint_object_create returned null".into()));
        }

        let mut err: *mut c_char = ptr::null_mut();
        ffi::rocksdb_checkpoint_create(cp, checkpoint_c.as_ptr(), u64::MAX, &mut err);
        let cp_err = check_err("checkpoint_create", err);

        // Always destroy the checkpoint handle + db, regardless of cp result.
        ffi::rocksdb_checkpoint_object_destroy(cp);
        ffi::rocksdb_close(db);
        ffi::rocksdb_options_destroy(opts);

        if let Err(e) = cp_err {
            return Err((5, e));
        }
        eprintln!("checkpoint_create in {:?}", t_cp.elapsed());
        Ok::<(), (i32, String)>(())
    };

    result?;

    // Workaround for librocksdb-sys 0.17.3 secondary-mode checkpoint
    // dropping data-file hard-links — see module-level docstring.
    // Hard-link every regular file from the primary dir into the
    // checkpoint dir, EXCEPT the LOCK file (which would make RocksDB
    // think the primary is locked when it opens the checkpoint).
    //
    // The set of relevant file kinds is broader than just SSTs:
    //   - *.sst    — RocksDB sorted-string tables
    //   - *.blob   — Stalwart's inline blob storage (BlobStore=RocksDB)
    //   - *.log    — RocksDB WAL files
    //   - OPTIONS-*— Per-CF RocksDB config snapshots
    //   - LOG[.old]— RocksDB's own info-log files (not strictly needed
    //                but Stalwart's open may stat them)
    // Easier than maintaining a whitelist: hard-link everything except
    // LOCK. EEXIST is a silent skip (Checkpoint may have linked some).
    let t_link = Instant::now();
    let n_linked = hardlink_data_files(&primary, &checkpoint).map_err(|e| (7, e))?;
    eprintln!("hard-linked {n_linked} files from {primary} → {checkpoint} in {:?}", t_link.elapsed());

    // Tier-2 robustness: chmod 777 the checkpoint dir + its contents.
    //
    // RocksDB Checkpoint creates the dir + hard-link entries owned by
    // whatever uid this binary runs as (root in distroless/cc). The
    // downstream `stalwart -e` runs as the non-root stalwart user from
    // the upstream image and would otherwise hit "Permission denied"
    // opening the RocksDB LOG file for append on its primary-mode
    // open of the checkpoint.
    //
    // Doing it here, in the binary that created the dir, avoids
    // hand-coupling the alt-config sh container — and means the
    // checkpoint dir is portable to ANY downstream consumer regardless
    // of its uid.
    //
    // Errors are surfaced via exit code 6 (separate from the rocksdb
    // error space) so operators can distinguish "checkpoint worked,
    // chmod failed" from "checkpoint itself failed".
    let t_chmod = Instant::now();
    chmod_world_writable(&checkpoint).map_err(|e| (6, e))?;
    eprintln!("chmod world-writable in {:?}", t_chmod.elapsed());

    eprintln!("total wall time: {:?}", t0.elapsed());
    Ok(())
}

/// Hard-link every regular file from `src_dir` into `dest_dir`, except
/// the RocksDB `LOCK` file (linking that would make RocksDB think the
/// primary is held when it opens the checkpoint). Subdirectories are
/// skipped — RocksDB checkpoints are flat at this level.
///
/// Returns the count of files hard-linked. EEXIST is a silent skip
/// (Checkpoint may have linked some — we don't depend on whether it
/// did or didn't). Other errors are surfaced.
///
/// `src_dir` and `dest_dir` MUST be on the same filesystem (hard-link
/// is the load-bearing assertion; an EXDEV here would mean the
/// caller picked a checkpoint location outside the data PVC, which
/// is a bug). The error message surfaces EXDEV explicitly so the
/// operator can diagnose.
fn hardlink_data_files(src_dir: &str, dest_dir: &str) -> Result<usize, String> {
    let mut n = 0usize;
    for entry in std::fs::read_dir(src_dir)
        .map_err(|e| format!("read_dir({src_dir}): {e}"))?
    {
        let entry = entry.map_err(|e| format!("read_dir entry: {e}"))?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        // Skip LOCK — linking it would falsely advertise the primary
        // as held when the checkpoint is opened.
        if name_str == "LOCK" {
            continue;
        }
        // Skip subdirectories (e.g. archive dir if RocksDB ever places
        // one inside the data dir).
        let ftype = entry
            .file_type()
            .map_err(|e| format!("file_type({}): {e}", entry.path().display()))?;
        if !ftype.is_file() {
            continue;
        }
        let src = entry.path();
        let dest = std::path::Path::new(dest_dir).join(&name);
        match std::fs::hard_link(&src, &dest) {
            Ok(()) => {
                n += 1;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // rocksdb Checkpoint already hard-linked this one.
                continue;
            }
            Err(e) => {
                return Err(format!(
                    "hard_link({} → {}): {e}",
                    src.display(),
                    dest.display()
                ));
            }
        }
    }
    Ok(n)
}

/// chmod 0o777 on `path` and every immediate entry inside it.
///
/// A RocksDB checkpoint dir is flat — MANIFEST, CURRENT, OPTIONS-*,
/// hard-linked SST files. No subdirs. A non-recursive single-level
/// pass is sufficient. We use 0o777 (not 0o755) because the downstream
/// container will need to write LOG files into the same dir on its
/// primary-mode open.
fn chmod_world_writable(path: &str) -> Result<(), String> {
    let perm = std::fs::Permissions::from_mode(0o777);
    std::fs::set_permissions(path, perm.clone())
        .map_err(|e| format!("set_permissions({path}): {e}"))?;
    for entry in std::fs::read_dir(path)
        .map_err(|e| format!("read_dir({path}): {e}"))?
    {
        let entry = entry.map_err(|e| format!("read_dir entry: {e}"))?;
        let p = entry.path();
        std::fs::set_permissions(&p, perm.clone())
            .map_err(|e| format!("set_permissions({}): {e}", p.display()))?;
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => {
            println!("OK: checkpoint created");
            ExitCode::SUCCESS
        }
        Err((code, msg)) => {
            eprintln!("ERROR ({code}): {msg}");
            ExitCode::from(code as u8)
        }
    }
}
