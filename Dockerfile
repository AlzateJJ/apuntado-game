FROM node:24.22.3-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/check-node.mjs scripts/check-node.mjs
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci
COPY . .
RUN npm run build

# A separate, one-shot migration image. Runtime does not ship development tools.
FROM build AS migrate
USER node
CMD ["node", "scripts/migrate.mjs"]

FROM build AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts

FROM node:24.22.3-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 SERVE_WEB=true
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/package.json ./apps/web/package.json
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages/contracts ./packages/contracts
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/main.js"]
