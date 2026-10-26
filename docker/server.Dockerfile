# Backend Lumen. Les paquets du monorepo sont exécutés depuis leurs sources TypeScript
# (tsx) : la compilation en un seul fichier viendra avec l'image de production.
FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @lumen/server...
ENV LUMEN_HOST=0.0.0.0 \
    LUMEN_PORT=8090 \
    LUMEN_DATABASE_PATH=/data/lumen.db
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8090/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WORKDIR /repo/apps/server
CMD ["pnpm", "start"]
