# Stage 1: Patch sftp-server binary for chroot confinement
# Sets the ELF interpreter and rpath to /.platform/sftp-jail/lib/ so the binary
# runs inside a chroot at /data without needing /lib/ at the chroot root.
FROM alpine:3.20 AS sftp-patcher
RUN apk add --no-cache openssh-sftp-server patchelf
RUN INTERP=$(ls /lib/ld-musl-*.so.1 | head -1) && \
    INTERP_NAME=$(basename "$INTERP") && \
    cp /usr/lib/ssh/sftp-server /tmp/sftp-server-chroot && \
    patchelf --set-interpreter "/.platform/sftp-jail/lib/$INTERP_NAME" \
             --set-rpath "/.platform/sftp-jail/lib" \
             /tmp/sftp-server-chroot

# Stage 2: Runtime
FROM node:22-alpine3.20
RUN apk add --no-cache git tar zip unzip sqlite openssh-sftp-server openssh-client rsync
COPY --from=sftp-patcher /tmp/sftp-server-chroot /usr/local/share/sftp-server-chroot
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
WORKDIR /app
COPY server.mjs .
EXPOSE 8111
# Run as root to read all PVC data (database dirs owned by mysql/postgres)
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.mjs"]
