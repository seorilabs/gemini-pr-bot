FROM node:24.16.0-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.16.0-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
RUN groupadd --system --gid 10001 app \
  && useradd --system --uid 10001 --gid 10001 --create-home --home-dir /home/app app \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep tar \
  && rm -rf /var/lib/apt/lists/*
RUN curl https://cursor.com/install -fsS | bash \
  && cursor_dir="$(find /root/.local/share/cursor-agent/versions -mindepth 1 -maxdepth 1 -type d | head -n 1)" \
  && mkdir -p /opt/cursor-agent \
  && cp -a "$cursor_dir" /opt/cursor-agent/current \
  && ln -s /opt/cursor-agent/current/cursor-agent /usr/local/bin/agent \
  && ln -s /opt/cursor-agent/current/cursor-agent /usr/local/bin/cursor-agent \
  && rm -rf /root/.local
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER app
EXPOSE 3000
CMD ["node", "dist/index.js"]
