# The build sandbox. Everything inside is treated as hostile: the container runs
# unprivileged, on an internal network with no egress, with a read-only root
# filesystem and a tmpfs for scratch (see docker-compose.yml).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY services/builder/package.json services/builder/tsconfig.json ./services/builder/
WORKDIR /app/services/builder
RUN npm install --no-audit --no-fund --silent \
 && npm install --no-save --silent typescript@5.6.3 @types/node@22.9.0
COPY services/builder/src ./src
RUN npx tsc -p tsconfig.json

# Vendored OpenSCAD libraries, fetched at pinned commits. Separate stage so the
# network access this needs never exists in the runtime image.
FROM debian:bookworm-slim AS libraries
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates coreutils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /vendor
COPY services/builder/libraries.json services/builder/vendor-libraries.sh ./
RUN sh vendor-libraries.sh libraries.json /opt/openscad-libraries

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openscad xvfb xauth ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=libraries /opt/openscad-libraries /opt/openscad-libraries
WORKDIR /app/services/builder
COPY services/builder/package.json ./
RUN npm install --omit=dev --no-audit --no-fund --silent
COPY --from=build /app/services/builder/dist ./dist
ENV NODE_ENV=production \
    OPENSCAD_PATH=openscad \
    OPENSCAD_WRAPPER="xvfb-run -a" \
    OPENSCAD_LIBRARY_DIR=/opt/openscad-libraries \
    BUILDER_PORT=8081
USER node
EXPOSE 8081
CMD ["node", "dist/server.js"]
