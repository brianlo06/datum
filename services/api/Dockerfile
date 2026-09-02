FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/scad-schema/package.json packages/scad-schema/tsconfig.json ./packages/scad-schema/
COPY services/api/package.json services/api/tsconfig.json ./services/api/
RUN npm install --no-audit --no-fund --silent --workspaces --include-workspace-root
COPY packages/scad-schema/src ./packages/scad-schema/src
COPY services/api/src ./services/api/src
RUN npx tsc -p packages/scad-schema/tsconfig.json \
 && npx tsc -p services/api/tsconfig.json

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY packages/scad-schema/package.json ./packages/scad-schema/
COPY services/api/package.json ./services/api/
RUN npm install --omit=dev --no-audit --no-fund --silent --workspaces --include-workspace-root
COPY --from=build /app/packages/scad-schema/dist ./packages/scad-schema/dist
COPY --from=build /app/services/api/dist ./services/api/dist
COPY db/migrations ./db/migrations
RUN mkdir -p /var/datum/artifacts && chown -R node:node /var/datum
USER node
EXPOSE 8080
CMD ["node", "services/api/dist/server.js"]
