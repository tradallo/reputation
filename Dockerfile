# Minimal image for MCP-registry verifiers (Glama, etc.) that need to run
# the server and confirm it speaks the protocol. The server is stdio-based
# — registries pipe JSON-RPC requests on stdin and check the responses on
# stdout. End users still install via `npx @tradallo/reputation`; this
# Dockerfile exists for verifier infrastructure, not as the recommended
# install path.

FROM node:20-alpine AS build

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile=false --prod=false

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ─── Runtime image ───────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Copy only what the runtime needs — production deps + compiled output.
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
RUN corepack enable && pnpm install --prod --frozen-lockfile=false

# stdio MCP server — verifier sends JSON-RPC on stdin.
ENTRYPOINT ["node", "dist/index.js"]
