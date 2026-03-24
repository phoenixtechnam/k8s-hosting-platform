FROM node:22-alpine

RUN adduser -D -u 1000 appuser

RUN mkdir -p /app && chown appuser:appuser /app
WORKDIR /app

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
