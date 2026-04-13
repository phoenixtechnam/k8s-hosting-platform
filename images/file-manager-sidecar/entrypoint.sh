#!/bin/sh
set -e

# Prepare SFTP chroot jail — copies the patched sftp-server binary and its
# required shared libraries into /data/.platform/ so that the SFTP gateway
# can `chroot /data` and exec the binary with all paths confined to the PVC.
#
# The sftp-server binary was patched at build time (patchelf) to set its ELF
# interpreter and rpath to /.platform/sftp-jail/lib/, so after chroot the
# dynamic linker and libraries are found at the right paths without polluting
# the user's root with a /lib/ directory.

SFTP_PATCHED="/usr/local/share/sftp-server-chroot"
JAIL_LIB="/data/.platform/sftp-jail/lib"
JAIL_BIN="/data/.platform/sftp-server"

if [ -f "$SFTP_PATCHED" ]; then
  mkdir -p "$JAIL_LIB"

  # Copy the patched sftp-server binary (fatal if this fails — jail is unusable)
  cp -u "$SFTP_PATCHED" "$JAIL_BIN" || { echo "ERROR: failed to install sftp-server into jail"; exit 1; }
  chmod 555 "$JAIL_BIN" 2>/dev/null || true

  # Copy the musl dynamic linker and required shared libraries.
  # The patched binary expects them at /.platform/sftp-jail/lib/ (inside chroot).
  for lib in /lib/ld-musl-*.so.1; do
    [ -f "$lib" ] && cp -u "$lib" "$JAIL_LIB/" 2>/dev/null || true
  done
  # Use the ORIGINAL (unpatched) sftp-server for ldd — the patched binary's
  # custom interpreter path doesn't exist yet so ldd would fail on it.
  SFTP_ORIGINAL="/usr/lib/ssh/sftp-server"
  for lib in $(ldd "$SFTP_ORIGINAL" 2>/dev/null | grep "=>" | awk '{print $3}'); do
    [ -f "$lib" ] && cp -u "$lib" "$JAIL_LIB/" 2>/dev/null || true
  done

  chmod -R 555 "$JAIL_LIB" 2>/dev/null || true

  # sftp-server needs /dev/null and /etc/passwd inside the chroot.
  # Keep them inside .platform/ so they're invisible to SFTP clients.
  mkdir -p /data/.platform/jail-etc /data/.platform/jail-dev
  [ -e /data/.platform/jail-dev/null ] || mknod /data/.platform/jail-dev/null c 1 3 2>/dev/null || true
  chmod 666 /data/.platform/jail-dev/null 2>/dev/null || true
  echo "root:x:0:0:root:/:/sbin/nologin" > /data/.platform/jail-etc/passwd 2>/dev/null || true
  echo "root:x:0:" > /data/.platform/jail-etc/group 2>/dev/null || true

  # Copy busybox (statically linked on Alpine) into the jail so we have
  # a shell for the wrapper script inside the chroot.
  cp -u /bin/busybox /data/.platform/busybox 2>/dev/null || true
  chmod 555 /data/.platform/busybox 2>/dev/null || true

  # Wrapper script called by the SFTP gateway via chroot. Uses busybox sh
  # (static, no libs needed) to create temporary /dev and /etc symlinks,
  # run sftp-server, then clean up. The symlinks only exist for the
  # duration of each SFTP session — invisible to other clients browsing.
  cat > /data/.platform/sftp-wrapper <<'WRAPPER'
#!/.platform/busybox sh
# Create symlinks for sftp-server's hardcoded /dev/null and /etc/passwd.
# These are atomic and idempotent — safe for concurrent sessions.
ln -sfn /.platform/jail-dev /dev 2>/dev/null
ln -sfn /.platform/jail-etc /etc 2>/dev/null
# Run sftp-server (blocks until client disconnects)
/.platform/sftp-server "$@"
RC=$?
# Clean up symlinks (harmless race: concurrent sessions re-create them)
rm -f /dev /etc 2>/dev/null
exit $RC
WRAPPER
  chmod 555 /data/.platform/sftp-wrapper 2>/dev/null || true

  # Clean up legacy root-level dev/ and etc/ from older entrypoint versions
  [ -d /data/dev ] && [ ! -L /data/dev ] && rm -rf /data/dev 2>/dev/null || true
  [ -d /data/etc ] && [ ! -L /data/etc ] && rm -rf /data/etc 2>/dev/null || true
  [ -L /data/dev ] && rm -f /data/dev 2>/dev/null || true
  [ -L /data/etc ] && rm -f /data/etc 2>/dev/null || true
fi

exec "$@"
