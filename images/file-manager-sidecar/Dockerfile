# Stage 1: Patch sftp-server binary for chroot confinement
# Sets the ELF interpreter and rpath to /.platform/lib/ so the binary
# runs inside a jail chroot without needing /lib/ at the chroot root.
FROM alpine:3.20 AS sftp-patcher
RUN apk add --no-cache openssh-sftp-server patchelf
RUN INTERP=$(patchelf --print-interpreter /usr/lib/ssh/sftp-server) && \
    INTERP_NAME=$(basename "$INTERP") && \
    cp /usr/lib/ssh/sftp-server /tmp/sftp-server-chroot && \
    patchelf --set-interpreter "/.platform/lib/$INTERP_NAME" \
             --set-rpath "/.platform/lib" \
             /tmp/sftp-server-chroot

# Stage 2: Build sftp-chroot helper (static Go binary: chroot + setuid + exec)
FROM golang:1.23-alpine AS chroot-builder
WORKDIR /build
COPY sftp-chroot.go .
RUN CGO_ENABLED=0 go build -ldflags='-s -w' -o sftp-chroot sftp-chroot.go

# Stage 3: Runtime
FROM node:22-alpine3.20
RUN apk add --no-cache git tar zip unzip sqlite openssh-sftp-server openssh-client rsync
COPY --from=sftp-patcher /tmp/sftp-server-chroot /usr/local/share/sftp-server-chroot
COPY --from=chroot-builder /build/sftp-chroot /usr/local/bin/sftp-chroot
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/sftp-chroot
WORKDIR /app
COPY server.mjs .
EXPOSE 8111
# Run as root to read all PVC data (database dirs owned by mysql/postgres)
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.mjs"]
