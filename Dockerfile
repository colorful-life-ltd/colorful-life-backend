FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN DATABASE_URL=postgresql://unused:unused@127.0.0.1/unused npm run generate:client && npm run build && npm prune --omit=dev --omit=peer --omit=optional && rm -rf dist/__tests__ dist/testing
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
# Application runs via node; package managers are build tools, not runtime requirements.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
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
