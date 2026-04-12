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

  # sftp-server needs /dev/null and /etc/passwd inside the chroot (root = /data)
  mkdir -p /data/dev /data/etc
  [ -e /data/dev/null ] || mknod /data/dev/null c 1 3 2>/dev/null || true
  chmod 666 /data/dev/null 2>/dev/null || true
  # Minimal passwd so sftp-server can resolve uid 0
  echo "root:x:0:0:root:/:/sbin/nologin" > /data/etc/passwd 2>/dev/null || true
  echo "root:x:0:" > /data/etc/group 2>/dev/null || true
fi

exec "$@"
