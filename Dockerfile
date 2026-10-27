# AgentPad backend — Hugging Face Docker Space (BSC mainnet, read-only until TX_SEND_ENABLED=true).
# All configuration comes from Space variables; the signer keystore + password come from Space *secrets*
# (SIGNER_KEYSTORE_JSON / SIGNER_KEYSTORE_PASSWORD) and are never part of this repo.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npx tsc -p tsconfig.json

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=7860 \
    HOST=0.0.0.0 \
    DATABASE_URL=file:/data/agentpad.db \
    MIGRATIONS_DIR=/app/drizzle
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
# Free Spaces have no persistent disk: /data lives in the container and is wiped on restart/rebuild.
# The indexer re-reads the chain from START_BLOCK on every boot (on-chain data is never lost).
RUN mkdir -p /data && chown -R node:node /data /app
EXPOSE 7860
USER node
CMD ["node", "dist/src/main.js"]
