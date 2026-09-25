FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY nest-cli.json tsconfig*.json ./
COPY src ./src

RUN printf 'DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build\n' > .env \
    && npm ci --no-audit --no-fund \
    && npm run build \
    && rm -f .env

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma.config.ts ./prisma.config.ts
RUN touch /app/.env && chown node:node /app/.env
USER node
EXPOSE 3003
CMD ["node", "dist/main.js"]
