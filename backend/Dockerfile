# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS builder

WORKDIR /app

# Build shared API contracts first
COPY packages/api-contracts/ ./packages/api-contracts/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    cd packages/api-contracts && npm install --ignore-scripts --prefer-offline --no-audit --no-fund && npx tsc --build

# Build backend
COPY backend/package.json backend/tsconfig.json ./
RUN sed -i 's|"@k8s-hosting/api-contracts": "\*"|"@k8s-hosting/api-contracts": "file:./packages/api-contracts"|' package.json
# Fix tsconfig reference path for Docker flat layout
RUN sed -i 's|\.\./packages/api-contracts|./packages/api-contracts|' tsconfig.json
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install --ignore-scripts --prefer-offline --no-audit --no-fund --legacy-peer-deps
COPY backend/src/ src/
RUN npx tsc

FROM node:22-alpine

# openssl is used by the mtls-providers module to generate self-signed
# CAs and sign user certs (cert-ops.ts). Alpine's node image doesn't
# include it by default. Pin nothing — track the alpine track so we
# get security fixes.
#
# age is used by modules/system-backup for the secrets-bundle export
# pipeline (tar + age -r <recipient>). Matches the on-host bundle
# format created by scripts/bootstrap.sh and decoded by `make
# secrets-restore`. age is a tiny static Go binary shipped in the
# alpine community repo.
# pg_dump must be >= the highest CNPG server version we dump FROM
# (newer clients can dump from older servers; older clients refuse
# newer servers with 'aborting because of server version mismatch').
# Platform/postgres runs cnpg postgresql:17.5 → pin pg_dump to v17.
#
# Caveat for mail-pg (currently cnpg 16.9): pg_dump 17 CAN export
# from a 16 server, but the archive format is v1.15 which mail-pg's
# pg_restore 16 cannot read directly. For in-place mail-pg recovery,
# operators should pg_restore from inside the mail-pg pod itself
# (which has its own version-matched pg_restore). The DR drill
# harness handles this via kubectl exec. Bumping mail-pg's CNPG
# image to 17 will eliminate this caveat.
RUN apk add --no-cache openssl age postgresql17-client

WORKDIR /app

COPY --from=builder /app/packages/api-contracts/ ./packages/api-contracts/
COPY backend/package.json ./
RUN sed -i 's|"@k8s-hosting/api-contracts": "\*"|"@k8s-hosting/api-contracts": "file:./packages/api-contracts"|' package.json
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install --omit=dev --ignore-scripts --prefer-offline --no-audit --no-fund --legacy-peer-deps

COPY --from=builder /app/dist/ dist/
COPY backend/src/db/migrations/ dist/db/migrations/
COPY backend/docker-entrypoint.sh ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://localhost:3000/api/v1/healthz || exit 1

ENTRYPOINT ["sh", "docker-entrypoint.sh"]
