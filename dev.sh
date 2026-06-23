#!/usr/bin/env bash
# Start the OSCAR backend and the frontend together for local end-to-end testing.
#
#   bash dev.sh
#
# First run installs dependencies and downloads Chromium. The backend runs in the
# background; the frontend runs in the foreground. Ctrl+C stops both.

set -e
root="$(cd "$(dirname "$0")" && pwd)"
server="$root/server"

if [ ! -d "$server/node_modules" ]; then
  echo "Installing backend dependencies..."
  (cd "$server" && npm install)
fi

echo "Ensuring Chromium is installed..."
(cd "$server" && npx playwright install chromium >/dev/null)

if [ ! -d "$root/node_modules" ]; then
  echo "Installing frontend dependencies..."
  (cd "$root" && npm install)
fi

if [ ! -f "$root/.env" ]; then
  cp "$root/.env.example" "$root/.env"
  echo "Created .env from .env.example"
fi

echo "Starting backend (http://localhost:8787)..."
(cd "$server" && npm run dev) &
backend_pid=$!
trap 'kill $backend_pid 2>/dev/null' EXIT INT TERM

sleep 3
echo "Starting frontend..."
(cd "$root" && npm run dev)
