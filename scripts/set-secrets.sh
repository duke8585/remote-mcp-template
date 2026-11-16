#!/usr/bin/env bash
# Usage: scripts/set-secrets.sh <server> <google-oauth-client.json> <allowed-emails>
#   server:          folder name under servers/, e.g. "hello"
#   allowed-emails:  comma-separated, e.g. "me@gmail.com,me@work.com"
# Deploys the worker (secrets need an existing worker), then pipes each secret
# into `wrangler secret put` via stdin so values never hit argv, logs or the terminal.
set -euo pipefail

server="${1:?usage: $0 <server> <client.json> <allowed-emails>}"
json="$(cd "$(dirname "${2:?missing client.json}")" && pwd)/$(basename "$2")"
emails="${3:?missing allowed-emails}"
cd "$(dirname "$0")/../servers/$server"

field() {
  python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1]))
c = d.get("web") or d.get("installed") or d
print(c[sys.argv[2]], end="")
' "$json" "$1"
}

resource=$(python3 -I -c 'import re; print(re.search(r"\"MCP_RESOURCE\":\s*\"([^\"]+)\"", open("wrangler.jsonc").read()).group(1))')
callback="${resource%/mcp}/callback"

if ! python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1])); c = d.get("web") or d.get("installed") or d
sys.exit(0 if sys.argv[2] in c.get("redirect_uris", []) else 1)
' "$json" "$callback"; then
  echo "WARN: $callback is not in the JSON's redirect_uris - add it in Google Cloud console or login will fail" >&2
fi

echo "deploying worker..."
npx wrangler deploy

echo "setting secrets..."
field client_id     | npx wrangler secret put GOOGLE_CLIENT_ID
field client_secret | npx wrangler secret put GOOGLE_CLIENT_SECRET
printf '%s' "$emails" | npx wrangler secret put ALLOWED_EMAILS
openssl rand -hex 32 | tr -d '\n' | npx wrangler secret put COOKIE_ENCRYPTION_KEY

echo
npx wrangler secret list
echo "done. connector url: $resource"
