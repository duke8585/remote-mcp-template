#!/usr/bin/env bash
# Usage: scripts/set-secrets.sh <server> <google-oauth-client.json>
#   server:  folder name under servers/, e.g. "hello"
# Deploys the worker (secrets need an existing worker), then sets its secrets:
#   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  from the client JSON
#   ALLOWED_EMAILS                          prompted for, comma-separated
#   CONSENT_SECRET                          random, only if not set yet (rotating it forces re-approval)
# Every value is piped into `wrangler secret put` over stdin, never passed as an argument.
# Safe to re-run, e.g. after creating a new Google client.
set -euo pipefail

server="${1:?usage: $0 <server> <client.json>}"
json="$(cd "$(dirname "${2:?missing client.json}")" && pwd)/$(basename "$2")"
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
[[ "$resource" == *YOUR_SUBDOMAIN* ]] && { echo "run scripts/provision.sh $server <subdomain> first" >&2; exit 1; }
callback="${resource%/mcp}/callback"

if ! python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1])); c = d.get("web") or d.get("installed") or d
sys.exit(0 if sys.argv[2] in c.get("redirect_uris", []) else 1)
' "$json" "$callback"; then
  echo "WARN: $callback is not in the JSON's redirect_uris." >&2
  echo "      Add it in Google Cloud console (the JSON is a snapshot, so it may just be stale)." >&2
fi

read -r -p "Google accounts allowed to log in (comma-separated): " emails
[[ -n "${emails// /}" ]] || { echo "empty allowlist would lock everyone out; aborting" >&2; exit 1; }

echo "deploying worker..."
npx wrangler deploy

echo "setting secrets..."
field client_id     | npx wrangler secret put GOOGLE_CLIENT_ID
field client_secret | npx wrangler secret put GOOGLE_CLIENT_SECRET
printf '%s' "$emails" | npx wrangler secret put ALLOWED_EMAILS
if npx wrangler secret list 2>/dev/null | grep -q '"CONSENT_SECRET"'; then
  echo "CONSENT_SECRET already set, keeping it"
else
  openssl rand -hex 32 | tr -d '\n' | npx wrangler secret put CONSENT_SECRET
fi

echo
npx wrangler secret list
echo "done. connector url: $resource"
