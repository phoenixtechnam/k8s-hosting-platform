#!/bin/sh
set -e

# Prepare SFTP chroot jail at /jail (emptyDir volume, NOT on the customer PVC).
# The SFTP gateway bind-mounts the customer PVC at /jail/home/ and chroots
# here, so the user's SFTP root (/home/) contains only their files — zero
# platform artifacts are visible.
#
# The sftp-server binary was patched at build time (patchelf) to set its ELF
# interpreter and rpath to /.platform/lib/, so after chroot the dynamic
# linker and libraries are found without needing /lib/ at the chroot root.

SFTP_PATCHED="/usr/local/share/sftp-server-chroot"
JAIL="/jail"

if [ -f "$SFTP_PATCHED" ] && [ -d "$JAIL" ]; then
  # Binary and libraries
  mkdir -p "$JAIL/.platform/lib"
  cp -u "$SFTP_PATCHED" "$JAIL/.platform/sftp-server" || { echo "ERROR: failed to install sftp-server into jail"; exit 1; }
  chmod 555 "$JAIL/.platform/sftp-server" 2>/dev/null || true

  for lib in /lib/ld-musl-*.so.1; do
    [ -f "$lib" ] && cp -u "$lib" "$JAIL/.platform/lib/" 2>/dev/null || true
  done
  SFTP_ORIGINAL="/usr/lib/ssh/sftp-server"
  for lib in $(ldd "$SFTP_ORIGINAL" 2>/dev/null | grep "=>" | awk '{print $3}'); do
    [ -f "$lib" ] && cp -u "$lib" "$JAIL/.platform/lib/" 2>/dev/null || true
  done
  chmod -R 555 "$JAIL/.platform" 2>/dev/null || true

  # /dev/null — sftp-server opens this at startup
  mkdir -p "$JAIL/dev"
  [ -e "$JAIL/dev/null" ] || mknod "$JAIL/dev/null" c 1 3 2>/dev/null || true
  chmod 666 "$JAIL/dev/null" 2>/dev/null || true

  # /etc/passwd — sftp-server resolves uid via getpwuid()
  mkdir -p "$JAIL/etc"
  echo "root:x:0:0:root:/:/sbin/nologin" > "$JAIL/etc/passwd"
  echo "nobody:x:65534:65534:nobody:/:/sbin/nologin" >> "$JAIL/etc/passwd"
  echo "root:x:0:" > "$JAIL/etc/group"
  echo "nobody:x:65534:" >> "$JAIL/etc/group"

  # /home — bind mount target (populated at session start by the gateway)
  mkdir -p "$JAIL/home"

  # Set permissions so non-root sftp-server can't list jail internals.
  # The gateway drops to uid 65534 (nobody) after chroot — these dirs
  # become invisible because nobody can't readdir on mode-711 dirs.
  chmod 711 "$JAIL"              # traverse but not list root
  chmod 711 "$JAIL/.platform"    # traverse+exec but not list (nobody can run binaries by name)
  chmod 711 "$JAIL/.platform/lib" 2>/dev/null || true  # same for lib dir
  chmod 711 "$JAIL/dev"          # traverse to /dev/null but can't list
  chmod 711 "$JAIL/etc"          # traverse to /etc/passwd but can't list
  chmod 777 "$JAIL/home"         # full access for all users

  # Clean up any legacy platform artifacts from the PVC root
  rm -rf /data/.platform /data/dev /data/etc 2>/dev/null || true
  # Remove stale symlinks too
  [ -L /data/dev ] && rm -f /data/dev 2>/dev/null || true
  [ -L /data/etc ] && rm -f /data/etc 2>/dev/null || true
fi

exec "$@"
