#!/bin/sh
# Optional one-time setup, then exec the server so it receives SIGTERM directly.
set -eu

if [ "${RUN_MIGRATIONS_ON_START:-false}" = "true" ]; then
  echo "[entrypoint] applying migrations (prisma migrate deploy)"
  # Prisma Migrate takes its own advisory lock, so concurrent instances serialize.
  node node_modules/prisma/build/index.js migrate deploy
fi

if [ "${SEED_DEMO:-false}" = "true" ]; then
  echo "[entrypoint] seeding demo catalog"
  node --experimental-strip-types prisma/seed.ts
fi

exec "$@"
