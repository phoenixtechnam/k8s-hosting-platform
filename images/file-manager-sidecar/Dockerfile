FROM node:22-alpine3.20
RUN apk add --no-cache git tar zip unzip sqlite openssh-sftp-server openssh-client rsync
WORKDIR /app
COPY server.mjs .
EXPOSE 8111
# Run as root to read all PVC data (database dirs owned by mysql/postgres)
CMD ["node", "server.mjs"]
