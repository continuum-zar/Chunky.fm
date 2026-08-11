# The whole station as one image: Fastify serving the API, the websocket, the
# uploaded library *and* the built client.
#
# This is the deployment shape for a platform that runs one container and puts
# its own edge in front: Railway, which PLAN.md picks. It is deliberately not
# what `docker compose` builds: that stack is two containers, nginx and this
# server, because on your own machine there is nothing in front and nginx is the
# thing that serves static well. Both are supported and both are tested; see the
# `stack` job in .github/workflows/ci.yml for the compose one.
#
# What makes one container work is CLIENT_DIR. Unset, the server is only an API
# and leaves `/` alone for whatever is in front of it. Set, it also owns the
# front door. See server/src/lib/doorway.ts, which is nginx.conf's rules in
# TypeScript, and says why there are three copies of them.

# ---- the client bundle -------------------------------------------------------
FROM node:22-bookworm-slim AS client
WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN npm ci
# `npm run build` typechecks before it bundles, and client/tsconfig.json takes in
# test/ and scripts/ as well as src/, so they all have to be here or tsc fails
# on files it was told to include but cannot find.
COPY client/tsconfig.json client/vite.config.ts ./
COPY client/index.html client/landing.html client/how-it-works.html ./
COPY client/src ./src
COPY client/test ./test
COPY client/scripts ./scripts
# The unhashed files that answer on their own name: the favicon, the touch icon,
# the card an unfurler fetches, and the 404 page. Vite copies public/ into the
# build output verbatim.
#
# This was missing, and nothing failed: the build succeeded, the image shipped,
# and `/og.png` was answered by the app-shell fallback with a page of HTML and a
# 200 — so every link to this station unfurled as a grey rectangle and no
# favicon ever loaded. `loadClientBundle` treats these as optional, which is
# right (a station should not refuse to boot over a picture) and is also what
# let the omission go unnoticed. See routes/client.ts.
COPY client/public ./public
RUN npm run build

# ---- the server --------------------------------------------------------------
# Debian (glibc) rather than Alpine so `npm ci` can take better-sqlite3's
# published prebuild instead of compiling it; the toolchain is installed anyway
# for the platforms that have no prebuild.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# Same base as the runtime stage, so the compiled better-sqlite3 binding that
# survives the prune can be copied straight across.
FROM deps AS prod-deps
WORKDIR /app
RUN npm prune --omit=dev

# ---- runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Created here and owned by `node` so a volume mounted over it inherits that
# ownership instead of coming up root-owned and unwritable.
RUN mkdir -p /data && chown node:node /data

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=client /client/dist ./client
COPY server/package.json ./

ENV HOST=0.0.0.0 \
    PORT=3000 \
    AUDIO_STORAGE_DIR=/data \
    CLIENT_DIR=/app/client
EXPOSE 3000
USER node

# Fastify logs every request, health probes included, so the steady-state
# interval is kept slow and the fast polling confined to start-up.
HEALTHCHECK --interval=30s --start-interval=2s --start-period=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Not `npm start`: that wrapper only exists to load a .env file, and on a
# platform the environment is already the environment.
CMD ["node", "dist/index.js"]
