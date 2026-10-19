FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN DATABASE_URL=postgresql://unused:unused@127.0.0.1/unused npx prisma generate && npm run build && npm prune --omit=dev --omit=peer --omit=optional
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src/assets ./src/assets
COPY --from=build --chown=node:node /app/assets ./assets
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 3000
CMD ["node","dist/index.js"]
