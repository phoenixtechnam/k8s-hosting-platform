FROM node:22-alpine3.20
RUN apk add --no-cache git tar zip unzip
WORKDIR /app
COPY server.mjs .
EXPOSE 8111
USER node
CMD ["node", "server.mjs"]
