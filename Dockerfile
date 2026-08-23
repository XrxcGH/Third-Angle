# syntax=docker/dockerfile:1

# Third Angle, for Cloudflare Containers.
#
# Two stages so the runtime image carries no compiler and no build cache. The
# app itself needs nothing built — there is no bundler, no transpiler and no
# client-side JavaScript — so the build stage exists only to resolve npm
# dependencies, one of which (sharp) ships platform-specific binaries.

# ---------------------------------------------------------------- build
FROM node:24-bookworm-slim AS deps

WORKDIR /app

# Only the manifests, so this layer is cached until a dependency actually
# changes rather than on every edit to the site.
COPY package.json package-lock.json ./

# --omit=dev: the test runner is node's own and the dev dependencies are not
# needed to serve. --ignore-scripts is deliberately NOT set: sharp's install
# script is what selects its prebuilt binary for this platform.
RUN npm ci --omit=dev

# ---------------------------------------------------------------- runtime
FROM node:24-bookworm-slim AS runtime

# dumb-init, because Node is a poor PID 1: without it SIGTERM is not delivered
# to the process group and the container is killed rather than draining, which
# here means losing everything written since the last snapshot.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server.js ./
COPY bin ./bin
COPY src ./src
COPY views ./views
COPY public ./public
COPY scripts ./scripts

# The mount point for the SQLite file and the uploads. The container's disk is
# ephemeral; src/backup.js mirrors this directory to R2 on the way in and out.
RUN mkdir -p /data/uploads && chown -R node:node /data /app

# Not root. The app never needs to write outside /data, and an upload pipeline
# that shells out to a native image library is exactly the place where that
# matters.
USER node

EXPOSE 8080

# The Container class polls this before it considers the instance healthy.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "bin/start.js"]
