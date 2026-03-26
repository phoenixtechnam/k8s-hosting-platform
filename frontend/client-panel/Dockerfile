FROM node:22-alpine AS builder

WORKDIR /app

# Build shared API contracts first
COPY packages/api-contracts/ ./packages/api-contracts/
RUN cd packages/api-contracts && npm install --ignore-scripts && npx tsc --build

# Build client panel
COPY frontend/client-panel/package.json ./package.json
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
