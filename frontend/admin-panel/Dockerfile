FROM node:22-alpine AS builder

WORKDIR /app

# Build shared API contracts first
COPY packages/api-contracts/ ./packages/api-contracts/
RUN cd packages/api-contracts && npm install --ignore-scripts && npx tsc --build

# Build admin panel
COPY frontend/admin-panel/package.json ./package.json
RUN sed -i 's|"@k8s-hosting/api-contracts": "\*"|"@k8s-hosting/api-contracts": "file:./packages/api-contracts"|' package.json
RUN npm install --ignore-scripts
COPY frontend/admin-panel/index.html frontend/admin-panel/tsconfig.json frontend/admin-panel/vite.config.ts frontend/admin-panel/tailwind.config.js frontend/admin-panel/postcss.config.js ./
COPY frontend/admin-panel/src/ src/
COPY frontend/admin-panel/public/ public/
RUN npx vite build

FROM nginx:1.27-alpine
COPY --from=builder /app/dist/ /usr/share/nginx/html/
# Nginx config template — BACKEND_HOST/BACKEND_PORT substituted at startup
COPY frontend/admin-panel/nginx.conf.template /etc/nginx/conf.d/default.conf.template
COPY frontend/admin-panel/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/admin-panel/config.template.js /usr/share/nginx/html/config.template.js
COPY frontend/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Runtime config defaults (same-origin API, k8s service DNS for proxy backend)
ENV API_URL=""
ENV CLIENT_PANEL_URL=""
ENV BACKEND_HOST="platform-api.platform.svc.cluster.local"
ENV BACKEND_PORT="3000"

EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://localhost/health || exit 1
