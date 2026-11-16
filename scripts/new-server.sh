#!/usr/bin/env bash
# Usage: scripts/new-server.sh <name> [<from-server>]
# Copies servers/<from-server> (default: hello) to servers/<name>, renames it to worker
# "mcp-<name>" and resets its wrangler.jsonc to placeholders. Nothing is created on
# Cloudflare; run scripts/provision.sh <name> <subdomain> next.
set -euo pipefail

name="${1:?usage: $0 <name> [<from-server>]   (name: lowercase, a-z0-9-)}"
from="${2:-hello}"
[[ "$name" =~ ^[a-z0-9-]+$ ]] || { echo "name must be lowercase a-z0-9-" >&2; exit 1; }
cd "$(dirname "$0")/.."
dir="servers/$name"
[[ -d "servers/$from" ]] || { echo "servers/$from does not exist" >&2; exit 1; }
[[ -e "$dir" ]] && { echo "$dir already exists" >&2; exit 1; }

rsync -a --exclude node_modules --exclude .wrangler "servers/$from/" "$dir/"

python3 -I - "$dir" "$name" "$from" <<'EOF'
import pathlib, re, sys
d, name, src = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
w = d / "wrangler.jsonc"
s = w.read_text()
s = re.sub(r'"name": "mcp-[a-z0-9-]+"', f'"name": "mcp-{name}"', s, count=1)
s = re.sub(r'"MCP_RESOURCE": "[^"]+"', f'"MCP_RESOURCE": "https://mcp-{name}.YOUR_SUBDOMAIN.workers.dev/mcp"', s)
s = re.sub(r'("binding": "OAUTH_KV", "id": )"[^"]+"', r'\1"YOUR_KV_ID"', s)
s = re.sub(r'"database_name": "[^"]+"', f'"database_name": "mcp-{name}"', s)
s = re.sub(r'"database_id": "[^"]+"', '"database_id": "YOUR_D1_ID"', s)
w.write_text(s)
p = d / "package.json"
p.write_text(p.read_text().replace(f"server-{src}", f"server-{name}"))
i = d / "src/index.ts"
i.write_text(re.sub(r'name: "[a-z0-9-]+"', f'name: "{name}"', i.read_text()))
EOF

npm install --silent
cat <<EOF
created $dir (worker mcp-$name, placeholders reset)
next:
  1. edit $dir/src/index.ts (your tools)
  2. scripts/provision.sh $name <workers-subdomain>
EOF
