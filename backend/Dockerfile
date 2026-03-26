FROM node:22-alpine AS builder

WORKDIR /app
COPY backend/package.json backend/tsconfig.json ./
RUN npm install --ignore-scripts
COPY backend/src/ src/
RUN npx tsc

FROM node:22-alpine

WORKDIR /app

COPY backend/package.json ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist/ dist/
COPY backend/src/db/migrations/ dist/db/migrations/
COPY backend/docker-entrypoint.sh ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://localhost:3000/api/v1/admin/status || exit 1

ENTRYPOINT ["sh", "docker-entrypoint.sh"]
