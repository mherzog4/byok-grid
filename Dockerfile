# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_IMAGE=node:24.19.0-slim@sha256:cd84903a12dbd26b46f1f3b8144a2568c41c5d37ddd0c7a80a34c7a19786b35f
ARG RUST_IMAGE=rust:1.94.0-slim-bookworm@sha256:a86cada82e36ebd7a9bffed7548792c55a952fdb20718eea9278a936bcb76e62
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

FROM ${RUST_IMAGE} AS connector-runner-builder
WORKDIR /app

COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY apps/connector-runner/Cargo.toml apps/connector-runner/Cargo.toml
COPY apps/connector-runner/src apps/connector-runner/src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
  --mount=type=cache,target=/app/target \
  cargo build --locked --release --package byok-grid-connector-runner && \
  cp /app/target/release/byok-grid-connector-runner /tmp/connector-runner

FROM ${DEBIAN_IMAGE} AS connector-runner
COPY --from=connector-runner-builder /tmp/connector-runner /usr/local/bin/connector-runner

ENV CONNECTOR_RUNNER_LISTEN=0.0.0.0:4319
USER 65532:65532
EXPOSE 4319
ENTRYPOINT ["/usr/local/bin/connector-runner"]

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app

ARG NPM_VERSION=12.0.2

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/workflow-worker/package.json apps/workflow-worker/package.json
COPY apps/analytics-projector/package.json apps/analytics-projector/package.json
COPY packages/airbyte-destination/package.json packages/airbyte-destination/package.json
COPY packages/connector-sdk/package.json packages/connector-sdk/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/security/package.json packages/security/package.json

RUN --mount=type=cache,target=/root/.npm \
  npm install --global npm@${NPM_VERSION} --no-audit --no-fund && \
  npm ci --strict-allow-scripts --no-audit --no-fund

# Production entrypoints execute Node directly. Keep npm available to builders,
# but remove its global dependency tree from every Node runtime image.
FROM ${NODE_IMAGE} AS node-runtime
RUN rm -rf /usr/local/lib/node_modules/npm && \
  rm -f /usr/local/bin/npm /usr/local/bin/npx

FROM dependencies AS sdk-builder
COPY tsconfig.base.json ./
COPY packages/connector-sdk/tsconfig.json packages/connector-sdk/tsconfig.json
COPY packages/connector-sdk/tsconfig.build.json packages/connector-sdk/tsconfig.build.json
COPY packages/connector-sdk/src packages/connector-sdk/src
RUN npm run build --workspace=@byok-grid/connector-sdk

FROM dependencies AS airbyte-destination-builder
COPY tsconfig.base.json ./
COPY packages/airbyte-destination/package.json packages/airbyte-destination/package.json
COPY packages/airbyte-destination/tsconfig.json packages/airbyte-destination/tsconfig.json
COPY packages/airbyte-destination/tsconfig.build.json packages/airbyte-destination/tsconfig.build.json
COPY packages/airbyte-destination/src packages/airbyte-destination/src
RUN npm run build --workspace=@byok-grid/airbyte-destination

FROM node-runtime AS airbyte-destination
WORKDIR /airbyte

ENV NODE_ENV=production

COPY --from=airbyte-destination-builder --chown=node:node /app/packages/airbyte-destination/dist ./dist
COPY --chown=node:node packages/airbyte-destination/package.json ./package.json
COPY --chown=node:node packages/airbyte-destination/README.md ./README.md
COPY --chown=node:node packages/connector-sdk/LICENSE ./licenses/Apache-2.0.txt

LABEL org.opencontainers.image.licenses="Apache-2.0"
USER node
ENTRYPOINT ["node", "/airbyte/dist/cli.js"]

FROM sdk-builder AS web-builder
COPY . .

# Next.js evaluates server modules while collecting routes, so the build uses a
# throwaway migrated SQLite database. All deployment configuration remains
# runtime-only, allowing one attested image digest to serve any operator origin.
ENV SQLITE_DATABASE_URL=file:/tmp/byok-grid-build.sqlite
ENV BETTER_AUTH_SECRET=build-only-placeholder-not-for-runtime
ENV BETTER_AUTH_URL=http://localhost:3000
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run db:sqlite:migrate --workspace=@byok-grid/db
RUN --mount=type=cache,target=/app/apps/web/.next/cache \
  npm run build --workspace=@byok-grid/web

FROM node-runtime AS web
WORKDIR /app

ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=web-builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=web-builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --chown=node:node scripts/container/web-entrypoint.sh ./scripts/container/web-entrypoint.sh
RUN mkdir -p /data && chown node:node /data && chmod 0555 ./scripts/container/web-entrypoint.sh

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]
ENTRYPOINT ["./scripts/container/web-entrypoint.sh"]
CMD ["node", "apps/web/server.js"]

FROM dependencies AS worker-dependencies
RUN npm prune --omit=dev
# Optional peers can retain development-only database tooling after pruning.
# Remove the legacy PostgreSQL driver and Drizzle's schema generator explicitly,
# then fail the build if their runtime trees survive.
RUN npm uninstall postgres drizzle-kit --workspace=@byok-grid/db --ignore-scripts --no-audit --no-fund && \
  test ! -e /app/node_modules/postgres && \
  test ! -e /app/node_modules/drizzle-kit && \
  test ! -e /app/node_modules/@esbuild-kit/core-utils && \
  test ! -e /app/node_modules/@esbuild-kit/esm-loader

FROM node-runtime AS worker-runtime
WORKDIR /app

ENV NODE_ENV=production
# The production images execute TypeScript through tsx. Its default cache lives
# under /tmp, so disable it at the image boundary to keep every entrypoint
# compatible with a completely read-only root filesystem.
ENV TSX_DISABLE_CACHE=1

COPY --from=worker-dependencies --chown=node:node /app/node_modules ./node_modules
# npm nests Ajv 8 under the connectors workspace because the root development
# graph also contains Ajv 6. Preserve that pruned production subtree explicitly.
COPY --from=worker-dependencies --chown=node:node /app/packages/connectors/node_modules ./packages/connectors/node_modules
COPY --chown=node:node package.json package-lock.json tsconfig.base.json ./
COPY --chown=node:node apps/workflow-worker/package.json apps/workflow-worker/package.json
COPY --chown=node:node apps/workflow-worker/src apps/workflow-worker/src
COPY --chown=node:node packages/connector-sdk/package.json packages/connector-sdk/package.json
COPY --chown=node:node packages/connector-sdk/src packages/connector-sdk/src
COPY --from=sdk-builder --chown=node:node /app/packages/connector-sdk/dist packages/connector-sdk/dist
COPY --chown=node:node packages/connectors/package.json packages/connectors/package.json
COPY --chown=node:node packages/connectors/src packages/connectors/src
COPY --chown=node:node packages/db/package.json packages/db/package.json
COPY --chown=node:node packages/db/src packages/db/src
COPY --chown=node:node packages/db/sqlite-migrations packages/db/sqlite-migrations
COPY --chown=node:node packages/domain/package.json packages/domain/package.json
COPY --chown=node:node packages/domain/src packages/domain/src
COPY --chown=node:node packages/security/package.json packages/security/package.json
COPY --chown=node:node packages/security/src packages/security/src
COPY --chown=node:node scripts/container/workflow-worker-entrypoint.sh ./scripts/container/workflow-worker-entrypoint.sh
COPY --chown=node:node scripts/container/worker-health-probe.mjs ./scripts/container/worker-health-probe.mjs
COPY --chown=node:node scripts/container/migration-entrypoint.sh ./scripts/container/migration-entrypoint.sh
COPY --chown=node:node scripts/container/maintenance-entrypoint.sh ./scripts/container/maintenance-entrypoint.sh
RUN chmod 0555 ./scripts/container/workflow-worker-entrypoint.sh ./scripts/container/migration-entrypoint.sh ./scripts/container/maintenance-entrypoint.sh
RUN mkdir -p /data && chown node:node /data

USER node

FROM worker-runtime AS workflow-worker
ENTRYPOINT ["./scripts/container/workflow-worker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "apps/workflow-worker/src/index.ts"]

FROM worker-runtime AS analytics-projector
COPY --chown=node:node apps/analytics-projector/package.json apps/analytics-projector/package.json
COPY --chown=node:node apps/analytics-projector/src apps/analytics-projector/src
ENTRYPOINT ["node", "--import", "tsx", "apps/analytics-projector/src/index.ts"]

FROM worker-runtime AS migration
ENTRYPOINT ["./scripts/container/migration-entrypoint.sh"]
CMD ["node", "--import", "tsx", "packages/db/src/sqlite/migrate-cli.ts"]

FROM worker-runtime AS maintenance
ENTRYPOINT ["./scripts/container/maintenance-entrypoint.sh"]
