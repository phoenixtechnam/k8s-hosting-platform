FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts
COPY index.html tsconfig.json ./
COPY src/ src/
RUN npx vite build

FROM nginx:1.27-alpine
COPY --from=builder /app/dist/ /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://localhost/health || exit 1
