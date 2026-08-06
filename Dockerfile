# syntax=docker/dockerfile:1

# --- build stage -----------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# --ignore-scripts: lifecycle hooks must not run before src/ is copied, and no
# dependency here needs a postinstall step.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY scripts ./scripts
COPY spec ./spec
COPY src ./src
RUN npm run build

# Drop dev dependencies from the tree we are about to copy forward.
RUN npm prune --omit=dev --ignore-scripts

# --- runtime stage ---------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Cloud Run and most PaaS platforms inject PORT; this is the fallback.
ENV PORT=8080

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/spec/index.json ./spec/index.json
COPY --from=build /app/spec/reai-openapi.json ./spec/reai-openapi.json
COPY package.json ./

# node:alpine ships an unprivileged `node` user; there is no reason to run as root.
USER node

EXPOSE 8080

# The image defaults to remote/connector mode. For local stdio use, override with
#   docker run -i --rm -e REAI_USER_API_TOKEN=... reai-mcp node dist/index.js
CMD ["node", "dist/http.js"]
