FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# `npm run build` typechecks before it bundles, and tsconfig.json takes in test/
# and scripts/ as well as src/, so they all have to be here or tsc fails on
# files it was told to include but cannot find.
COPY tsconfig.json vite.config.ts ./
COPY index.html landing.html how-it-works.html ./
COPY src ./src
COPY test ./test
COPY scripts ./scripts
# The unhashed files that answer on their own name — the favicon, the touch
# icon, the card an unfurler fetches, the 404 page. Vite copies public/ into the
# build output verbatim, and leaving it out is silent: the build succeeds and
# every one of those addresses is answered by the fallback instead. The root
# Dockerfile had exactly that bug. CI checks the content types now.
COPY public ./public
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80

HEALTHCHECK --interval=30s --start-interval=1s --start-period=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
