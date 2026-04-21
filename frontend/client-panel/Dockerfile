# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS builder

WORKDIR /app

# Build shared API contracts first
COPY packages/api-contracts/ ./packages/api-contracts/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    cd packages/api-contracts && npm install --ignore-scripts --prefer-offline --no-audit --no-fund && npx tsc --build

# Build client panel
COPY frontend/client-panel/package.json ./package.json
RUN sed -i 's|"@k8s-hosting/api-contracts": "\*"|"@k8s-hosting/api-contracts": "file:./packages/api-contracts"|' package.json
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install --ignore-scripts --prefer-offline --no-audit --no-fund --legacy-peer-deps
COPY frontend/client-panel/index.html frontend/client-panel/tsconfig.json frontend/client-panel/vite.config.ts frontend/client-panel/postcss.config.js ./
COPY frontend/client-panel/src/ src/
COPY frontend/client-panel/public/ public/
RUN npx vite build

FROM nginx:1.27-alpine
COPY --from=builder /app/dist/ /usr/share/nginx/html/
# Nginx config template — BACKEND_HOST/BACKEND_PORT substituted at startup
COPY frontend/client-panel/nginx.conf.template /etc/nginx/conf.d/default.conf.template
COPY frontend/client-panel/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/client-panel/config.template.js /usr/share/nginx/html/config.template.js
COPY frontend/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Runtime config defaults (same-origin API, k8s service DNS for proxy backend)
ENV API_URL=""
ENV BACKEND_HOST="platform-api.platform.svc.cluster.local"
ENV BACKEND_PORT="3000"

EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://localhost/health || exit 1
