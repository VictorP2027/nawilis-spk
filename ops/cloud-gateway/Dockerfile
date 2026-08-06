# The WhatsApp watcher, containerised — so the gateway can live on a cheap
# cloud box instead of somebody's laptop. Build context is the REPO ROOT:
#
#   docker build -f ops/cloud-gateway/Dockerfile -t nawilis-watcher .
#
# --ignore-scripts keeps Playwright from downloading browsers: the watcher
# sends over HTTP, it never drives one.
FROM node:20-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts && npx tsc -b packages/core

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/core/package.json packages/core/package.json
COPY --from=build /app/scripts/alerts-drain.mjs scripts/alerts-drain.mjs
# Env comes from the runtime (compose/Fly secrets): MONGODB_URI, MONGODB_DB,
# WHATSAPP_PROVIDER=waha, WAHA_BASE_URL=http://waha:3000, WAHA_API_KEY, WAHA_SESSION.
CMD ["node", "scripts/alerts-drain.mjs", "--send", "--watch=30"]
