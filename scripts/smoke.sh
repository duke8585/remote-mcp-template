#!/usr/bin/env bash
# Usage: scripts/smoke.sh <server>
# Checks the deployed worker from the outside, the way claude.ai first sees it:
#   - POST /mcp without a token -> 401 with a WWW-Authenticate header pointing at resource metadata
#   - /.well-known/oauth-authorization-server -> 200 JSON advertising /authorize, /token, /register
set -euo pipefail

server="${1:?usage: $0 <server>}"
cd "$(dirname "$0")/../servers/$server"
resource=$(python3 -I -c 'import re; print(re.search(r"\"MCP_RESOURCE\":\s*\"([^\"]+)\"", open("wrangler.jsonc").read()).group(1))')
[[ "$resource" == *YOUR_SUBDOMAIN* ]] && { echo "servers/$server is not provisioned yet" >&2; exit 1; }
base="${resource%/mcp}"
fail=0

headers=$(curl -sS -o /dev/null -D - -X POST "$resource" -H 'content-type: application/json' -d '{}')
if grep -qi '^HTTP/[0-9.]* 401' <<<"$headers" && grep -qi '^www-authenticate:.*resource_metadata' <<<"$headers"; then
  echo "ok   /mcp without token -> 401 + WWW-Authenticate"
else
  echo "FAIL /mcp without token, got:"; echo "$headers"; fail=1
fi

meta=$(curl -sS "$base/.well-known/oauth-authorization-server")
if python3 -I -c '
import json, sys
m = json.loads(sys.argv[1])
assert all(k in m for k in ("authorization_endpoint", "token_endpoint", "registration_endpoint")), m
' "$meta" 2>/dev/null; then
  echo "ok   /.well-known/oauth-authorization-server"
else
  echo "FAIL /.well-known/oauth-authorization-server, got: $meta"; fail=1
fi

exit $fail
