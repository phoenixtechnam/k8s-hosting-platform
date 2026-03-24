FROM node:22-alpine

RUN mkdir -p /app && chown node:node /app
WORKDIR /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
