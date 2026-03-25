#!/bin/sh
set -e

echo "Running database migrations..."
node dist/db/migrate.js 2>&1 || echo "Migration failed or already applied — continuing"

echo "Running database seed..."
node dist/db/seed.js 2>&1 || echo "Seed failed or already applied — continuing"

echo "Starting server..."
exec node dist/server.js
