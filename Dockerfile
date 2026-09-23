ARG NODE_IMAGE=node:22-bookworm-slim

# Vite/esbuild emit portable JavaScript; compile natively, install runtime deps for the target.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json CHANGELOG.md ./
COPY apps apps
COPY packages packages
COPY scripts scripts
COPY deploy/release-policy.json deploy/release-policy.json
COPY docs/releases docs/releases

RUN npm ci --ignore-scripts
COPY . .
RUN npm run build
RUN node scripts/build-runtime.mjs --source-root /app --output /app/runtime

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production

ARG OCI_VERSION
ARG OCI_REVISION
ARG OCI_SOURCE=https://github.com/PatrickLiveCool/Tennis-PMS
ARG OCI_CREATED
ENV TENNIS_RELEASE_VERSION=${OCI_VERSION} \
    TENNIS_RELEASE_REVISION=${OCI_REVISION}
LABEL org.opencontainers.image.version="${OCI_VERSION}" \
      org.opencontainers.image.revision="${OCI_REVISION}" \
      org.opencontainers.image.source="${OCI_SOURCE}" \
      org.opencontainers.image.created="${OCI_CREATED}"

COPY --from=build /app/runtime/ ./
RUN npm ci --omit=dev --ignore-scripts

USER node

EXPOSE 4200
CMD ["node", "scripts/tennis/server-entry.mjs"]
