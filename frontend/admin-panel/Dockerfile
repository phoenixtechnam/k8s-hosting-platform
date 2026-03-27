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
ARG VITE_API_URL=http://localhost:3000
ARG VITE_CLIENT_PANEL_URL=http://localhost:5174
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_CLIENT_PANEL_URL=$VITE_CLIENT_PANEL_URL
RUN npx vite build

FROM nginx:1.27-alpine
COPY --from=builder /app/dist/ /usr/share/nginx/html/
COPY frontend/admin-panel/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://localhost/health || exit 1
