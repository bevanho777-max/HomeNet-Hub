# syntax=docker/dockerfile:1
# ── HomeNet Hub v2 ─ multi-stage build ──────────────────────────────
# stage1 (builder): install deps incl. native better-sqlite3 (needs toolchain)
# stage2 (runtime): slim image, copy node_modules + source, run Fastify.
# The web/ frontend is vanilla JS/CSS — no bundler — so it is copied as-is.

# ---------- stage 1: builder ----------
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# build toolchain for better-sqlite3 / pg native bits
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
# omit dev deps; build native modules against this node
RUN npm install --omit=dev --no-audit --no-fund

# ---------- stage 2: runtime ----------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# libstdc++ already present in slim; copy prebuilt node_modules from builder
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY web ./web
# config/ and data/ are bind-mounted at runtime (see docker-compose.yml)

EXPOSE 3100
# container healthcheck hits /healthz (§5.1)
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
