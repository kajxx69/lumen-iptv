# Portail Stalker factice : image de test, jamais de production.
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @lumen/fake-portal build
RUN pnpm --filter @lumen/fake-portal deploy --prod --legacy /out

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out .
ENV FAKE_PORTAL_ASSET_DIR=/data/assets \
    FAKE_PORTAL_HOST=0.0.0.0 \
    FAKE_PORTAL_PORT=8080
# Mires générées à la construction : démarrage immédiat du conteneur.
RUN mkdir -p /data/assets \
  && node dist/media/generate-assets-cli.js \
  && chown -R node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/_health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
