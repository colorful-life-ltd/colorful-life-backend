FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN DATABASE_URL=postgresql://unused:unused@127.0.0.1/unused npm run generate:client && npm run build && npm prune --omit=dev --omit=peer --omit=optional
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src/assets ./src/assets
COPY --from=build --chown=node:node /app/assets ./assets
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/certs ./certs
USER node
EXPOSE 3000
CMD ["node","dist/index.js"]
