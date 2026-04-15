FROM node:22-alpine AS builder

WORKDIR /app

# Build shared API contracts first
COPY packages/api-contracts/ ./packages/api-contracts/
RUN cd packages/api-contracts && npm install --ignore-scripts && npx tsc --build

# Build client panel
COPY frontend/client-panel/package.json ./package.json
RUN sed -i 's|"@k8s-hosting/api-contracts": "\*"|"@k8s-hosting/api-contracts": "file:./packages/api-contracts"|' package.json
RUN npm install --ignore-scripts
COPY frontend/client-panel/index.html frontend/client-panel/tsconfig.json frontend/client-panel/vite.config.ts frontend/client-panel/tailwind.config.js frontend/client-panel/postcss.config.js ./
COPY frontend/client-panel/src/ src/
COPY frontend/client-panel/public/ public/
RUN npx vite build

FROM nginx:1.27-alpine
COPY --from=builder /app/dist/ /usr/share/nginx/html/
COPY frontend/client-panel/nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/client-panel/config.template.js /usr/share/nginx/html/config.template.js
COPY frontend/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Runtime config — set these at deploy time (k8s env, docker-compose env, etc.)
ENV API_URL=""

EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://localhost/health || exit 1
