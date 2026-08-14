# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /build
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}

RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=openlabstock-pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

COPY astro.config.mjs ./
COPY public ./public
COPY src ./src
RUN pnpm run build

FROM ${NODE_IMAGE} AS runtime
ARG IMAGE_VERSION=local
LABEL org.opencontainers.image.title="OpenLabStock" \
      org.opencontainers.image.description="Laboratory consumables inventory" \
      org.opencontainers.image.version="${IMAGE_VERSION}"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4388 \
    DATA_DIR=/var/lib/openlabstock \
    BACKUP_DIR=/var/backups/openlabstock

WORKDIR /app
RUN install -d -o node -g node -m 700 /var/lib/openlabstock /var/backups/openlabstock

COPY package.json password.mjs server.mjs storage.mjs ./
COPY scripts ./scripts
COPY --from=build /build/dist ./dist

USER node
EXPOSE 4388
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4388/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server.mjs"]
