FROM node:22-slim AS builder

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm i -g pnpm && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

RUN groupadd -r scout && useradd -r -g scout -m -d /home/scout scout

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

RUN mkdir -p /home/scout/.automaton && chown -R scout:scout /home/scout/.automaton

USER scout

HEALTHCHECK --interval=5m --timeout=30s \
  CMD curl -sf http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js", "--run"]
