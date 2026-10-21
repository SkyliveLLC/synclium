# Synclium Cloud. Coolify builds this with base directory /cloud, so the context is cloud/ only. No npm install:
# there are no runtime dependencies, and Node 24 runs the TypeScript directly.
FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

# A named volume mounted on an empty /data takes this directory's owner, so the node user can write it.
# No VOLUME line: an anonymous volume would let the server start without the persistent one (main.ts refuses).
RUN mkdir -p /data && chown node:node /data
USER node

ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
EXPOSE 8080

# busybox wget ships in alpine. /v1/health runs SELECT 1; a failing check keeps Coolify on the old container.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/v1/health || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
