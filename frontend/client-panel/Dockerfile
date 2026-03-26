FROM node:22-alpine AS builder

WORKDIR /app

# Copy shared API contracts package first
COPY packages/api-contracts/ ./packages/api-contracts/

# Copy client panel
COPY frontend/client-panel/package.json ./package.json
# Replace workspace dependency with file reference for Docker build
RUN sed -i 's|"@k8s-hosting/api-contracts": "\*"|"@k8s-hosting/api-contracts": "file:./packages/api-contracts"|' package.json
RUN npm install --ignore-scripts
COPY frontend/client-panel/index.html frontend/client-panel/tsconfig.json frontend/client-panel/vite.config.ts frontend/client-panel/tailwind.config.js frontend/client-panel/postcss.config.js ./
COPY frontend/client-panel/src/ src/
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL
RUN npx vite build

FROM nginx:1.27-alpine
COPY --from=builder /app/dist/ /usr/share/nginx/html/
COPY frontend/client-panel/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://localhost/health || exit 1
