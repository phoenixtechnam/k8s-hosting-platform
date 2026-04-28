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
RUN apk add --no-cache openssl

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
