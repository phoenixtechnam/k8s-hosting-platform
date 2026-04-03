#!/bin/sh
set -e

echo "Running database migrations..."
node dist/db/migrate.js 2>&1 || echo "Migration failed or already applied — continuing"

echo "Running database seed..."
node dist/db/seed.js 2>&1 || echo "Seed failed or already applied — continuing"

echo "Starting Adminer proxy server..."
node dist/adminer-server.js &
ADMINER_PID=$!

echo "Starting main server..."
node dist/server.js &
MAIN_PID=$!

# Graceful shutdown: kill both processes on SIGINT/SIGTERM
trap "kill $MAIN_PID $ADMINER_PID 2>/dev/null; exit 0" INT TERM

# Wait for both processes. If one exits unexpectedly, the trap handles cleanup.
wait $MAIN_PID $ADMINER_PID
