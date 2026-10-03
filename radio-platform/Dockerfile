# Simple image: the built web page + server/lite.ts. No database, no Prisma, no secrets.
# (The older Postgres-backed variant is Dockerfile.db.)
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY lite/package.json lite/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/lite.ts /app/server/news.ts /app/server/preview.ts ./server/
COPY --from=build /app/server/sources/ajn.ts ./server/sources/ajn.ts
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "server/lite.ts"]
