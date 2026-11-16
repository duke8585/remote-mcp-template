#!/usr/bin/env bash
# Usage: scripts/check-auth.sh [base-url]   (default http://localhost:8787)
# Drives the OAuth flow of a running server with curl, as a fake MCP client, up to the
# Google redirect and back. Run it after changing packages/auth:
#   cd servers/hello && cp .dev.vars.example .dev.vars && npm run dev    # in one terminal
#   scripts/check-auth.sh                                                # in another
# Google credentials can stay fake: the script never completes a real Google login, and
# MCP_RESOURCE in .dev.vars must point at the same base URL.
set -uo pipefail
B="${1:-http://localhost:8787}"
D=$(mktemp -d)
pass=0; fail=0
check() { if eval "$2"; then echo "ok   $1"; pass=$((pass+1)); else echo "FAIL $1"; fail=$((fail+1)); fi; }
hdr() { grep -i "^$1:" | head -1 | cut -d' ' -f2- | tr -d '\r'; }

curl -s -o /dev/null "$B/" || { echo "nothing listening at $B (start the server with npm run dev)" >&2; exit 1; }

h=$(curl -s -o /dev/null -D - -X POST $B/mcp -H 'content-type: application/json' -d '{}')
check "/mcp no token -> 401 + resource_metadata" "grep -q ' 401' <<<\"\$h\" && grep -qi 'www-authenticate:.*resource_metadata' <<<\"\$h\""
prm=$(curl -s $B/.well-known/oauth-protected-resource/mcp)
check "protected resource = $B/mcp (MCP_RESOURCE)" "grep -qF '\"resource\":\"$B/mcp\"' <<<\"\$prm\""

reg=$(curl -s -X POST $B/register -H 'content-type: application/json' \
  -d '{"redirect_uris":["https://client.example/cb"],"client_name":"<b>evil</b>","token_endpoint_auth_method":"none"}')
cid=$(python3 -I -c 'import json,sys; print(json.loads(sys.argv[1])["client_id"])' "$reg")
check "dynamic client registration" "[[ -n '$cid' ]]"

V=verifier-0123456789-0123456789-0123456789-0123456789
C=$(printf '%s' $V | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=')
AUTH="$B/authorize?response_type=code&client_id=$cid&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&state=s1&code_challenge=$C&code_challenge_method=S256&resource=$(python3 -I -c "import sys,urllib.parse as u; print(u.quote(sys.argv[1], safe=\"\"))" "$B/mcp")"

page=$(curl -s -c $D/a -b $D/a -D $D/h1 "$AUTH")
handle=$(grep -o 'name="handle" value="[^"]*"' <<<"$page" | sed 's/.*value="//; s/"$//')
check "approval page with handle" "[[ -n '$handle' ]] && grep -q ' 200' $D/h1"
check "client name escaped" "grep -q '&#60;b&#62;evil' <<<\"\$page\" && ! grep -q '<b>evil' <<<\"\$page\""
check "frame-ancestors none" "grep -qi \"frame-ancestors 'none'\" $D/h1"

bad=$(curl -s -o /dev/null -w '%{http_code}' "$B/authorize?response_type=code&client_id=nope&redirect_uri=https%3A%2F%2Fx%2Fcb&state=s")
check "unknown client -> 400 not 500 (got $bad)" "[[ $bad == 400 ]]"

x=$(curl -s -o /dev/null -w '%{http_code}' -b $D/other -X POST $B/authorize -d "handle=$handle&action=approve")
check "handle without its browser cookie -> 400 (got $x)" "[[ $x == 400 ]]"

h=$(curl -s -o /dev/null -D - -c $D/a -b $D/a -X POST $B/authorize -d "handle=$handle&action=approve")
loc=$(hdr location <<<"$h")
check "approve -> Google with state" "[[ '$loc' == https://accounts.google.com/* ]] && grep -q 'state=' <<<'$loc'"
gstate=$(python3 -I -c 'import sys,urllib.parse as u; print(u.parse_qs(u.urlparse(sys.argv[1]).query)["state"][0])' "$loc")

h=$(curl -s -o /dev/null -D - -c $D/a -b $D/a "$B/callback?state=$gstate&error=access_denied")
loc=$(hdr location <<<"$h")
check "google error -> back to client with access_denied + state" "[[ '$loc' == https://client.example/cb?* ]] && grep -q 'error=access_denied' <<<'$loc' && grep -q 'state=s1' <<<'$loc'"
r=$(curl -s -o /dev/null -w '%{http_code}' -c $D/a -b $D/a "$B/callback?state=$gstate&error=access_denied")
check "callback state is single use (got $r)" "[[ $r == 400 ]]"

h=$(curl -s -o /dev/null -D - -c $D/a -b $D/a "$AUTH")
loc=$(hdr location <<<"$h")
check "remembered approval skips page -> Google" "[[ '$loc' == https://accounts.google.com/* ]]"
gstate=$(python3 -I -c 'import sys,urllib.parse as u; print(u.parse_qs(u.urlparse(sys.argv[1]).query)["state"][0])' "$loc")
h=$(curl -s -o /dev/null -D - -c $D/a -b $D/a "$B/callback?state=$gstate&code=bogus")
loc=$(hdr location <<<"$h")
check "bad google code -> back to client with server_error" "grep -q 'error=server_error' <<<'$loc' && grep -q 'state=s1' <<<'$loc'"

page=$(curl -s -c $D/b -b $D/b "$AUTH")
handle=$(grep -o 'name="handle" value="[^"]*"' <<<"$page" | sed 's/.*value="//; s/"$//')
h=$(curl -s -o /dev/null -D - -c $D/b -b $D/b -X POST $B/authorize -d "handle=$handle&action=cancel")
loc=$(hdr location <<<"$h")
check "cancel -> back to client with access_denied" "[[ '$loc' == https://client.example/cb?* ]] && grep -q 'error=access_denied' <<<'$loc'"

echo "$pass passed, $fail failed"; rm -rf $D; exit $fail
