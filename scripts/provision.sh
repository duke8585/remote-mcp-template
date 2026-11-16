#!/usr/bin/env bash
# Usage: scripts/provision.sh <server> <workers-subdomain>
#   server:             folder name under servers/, e.g. "hello"
#   workers-subdomain:  your account's *.workers.dev subdomain (dashboard -> Workers & Pages)
# Replaces the placeholders in servers/<server>/wrangler.jsonc with real resources:
#   YOUR_SUBDOMAIN -> <workers-subdomain>
#   YOUR_KV_ID     -> a new KV namespace for OAuth state
#   YOUR_D1_ID     -> a new D1 database, migrations applied (only if the server has one)
# Only placeholders still present are filled, and D1 migrations are applied on every run,
# so re-running after a failure (or after adding a migration) is safe.
# Needs `npx wrangler login` first.
set -euo pipefail

server="${1:?usage: $0 <server> <workers-subdomain>}"
subdomain="${2:?missing workers-subdomain}"
[[ "$subdomain" =~ ^[a-z0-9-]+$ ]] || { echo "subdomain must be lowercase a-z0-9-" >&2; exit 1; }
cd "$(dirname "$0")/../servers/$server"
cfg=wrangler.jsonc
worker=$(python3 -I -c 'import re; print(re.search(r"\"name\":\s*\"([^\"]+)\"", open("wrangler.jsonc").read()).group(1))')

# Replace one placeholder in wrangler.jsonc.
fill() { python3 -I -c 'import pathlib, sys; p = pathlib.Path(sys.argv[1]); p.write_text(p.read_text().replace(sys.argv[2], sys.argv[3]))' "$cfg" "$1" "$2"; }
has() { grep -q "$1" "$cfg"; }

if has YOUR_KV_ID; then
  out=$(npx wrangler kv namespace create "$worker-oauth" 2>&1) || { echo "$out" >&2; exit 1; }
  id=$(printf '%s' "$out" | grep -oE '"id": *"[0-9a-f]{32}"' | grep -oE '[0-9a-f]{32}' || true)
  [[ -n "$id" ]] || { echo "could not parse KV id from wrangler output:" >&2; echo "$out" >&2; exit 1; }
  fill YOUR_KV_ID "$id"
  echo "KV namespace $worker-oauth: $id"
fi

if has YOUR_D1_ID; then
  db=$(python3 -I -c 'import re; print(re.search(r"\"database_name\":\s*\"([^\"]+)\"", open("wrangler.jsonc").read()).group(1))')
  out=$(npx wrangler d1 create "$db" 2>&1) || { echo "$out" >&2; exit 1; }
  id=$(printf '%s' "$out" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)
  [[ -n "$id" ]] || { echo "could not parse D1 id from wrangler output:" >&2; echo "$out" >&2; exit 1; }
  fill YOUR_D1_ID "$id"
  echo "D1 database $db: $id"
fi

# Every run, not only on creation: wrangler skips applied migrations, so a failed or
# declined apply is retried, and new migration files get applied.
if grep -q '"d1_databases"' "$cfg"; then
  db=$(python3 -I -c 'import re; print(re.search(r"\"database_name\":\s*\"([^\"]+)\"", open("wrangler.jsonc").read()).group(1))')
  npx wrangler d1 migrations apply "$db" --remote
fi

has YOUR_SUBDOMAIN && fill YOUR_SUBDOMAIN "$subdomain"

resource=$(python3 -I -c 'import re; print(re.search(r"\"MCP_RESOURCE\":\s*\"([^\"]+)\"", open("wrangler.jsonc").read()).group(1))')
cat <<EOF
provisioned servers/$server
next:
  1. Google OAuth client -> add redirect URI ${resource%/mcp}/callback   (docs/google-oauth.md)
  2. scripts/set-secrets.sh $server <client.json>   (prompts for allowed emails)
  3. claude.ai -> Settings -> Connectors -> $resource
EOF
