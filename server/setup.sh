#!/usr/bin/env bash
# Sets up Pigment's team server on Cloudflare (Workers + D1, free plan) and points a project at it.
# Usage: server/setup.sh --project /path/to/project [--name pigment-<project>] [--dry-run]
#
# You only log in (npx wrangler login opens your browser). The script then creates the database,
# its tables, a random team key and the Worker, writes .pigment/config.json in the project, and
# saves the team key in a private file on THIS computer. It never prints the key.
set -euo pipefail

PROJECT="" NAME="" DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[ -d "$PROJECT" ] || { echo "--project must be the project's folder" >&2; exit 1; }
PROJECT="$(cd "$PROJECT" && pwd)"
SLUG="$(basename "$PROJECT" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-' | sed 's/^-*//;s/-*$//' | cut -c1-40)"
[ -n "$NAME" ] || NAME="pigment-$SLUG"
HERE="$(cd "$(dirname "$0")" && pwd)"
KEYFILE="$HOME/.pigment/keys/$NAME.txt"
W="npx --yes wrangler@4"

say() { printf '  %s\n' "$*"; }
if [ "$DRY" = "1" ]; then
  say "plan: check the Cloudflare login (npx wrangler login if needed)"
  say "plan: create D1 database $NAME and its tables"
  say "plan: create a random team key, set it as the Worker secret TEAM_KEY, save it to $KEYFILE (only you can read it)"
  say "plan: deploy the Worker $NAME (workers.dev)"
  say "plan: write $PROJECT/.pigment/config.json with storage \"cloud\" and the server's address"
  exit 0
fi

command -v npx >/dev/null || { echo "Node.js (npx) is needed: https://nodejs.org" >&2; exit 1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
cp -R "$HERE/src" "$HERE/schema.sql" "$WORK/"

if ! (cd "$WORK" && $W whoami 2>/dev/null | grep -qi "logged in"); then
  say "Log in to Cloudflare in the browser window that opens."
  (cd "$WORK" && $W login)
fi

say "Creating the database…"
DBID="$(cd "$WORK" && $W d1 list --json 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const db=JSON.parse(s).find(d=>d.name===process.argv[1]);process.stdout.write(db?db.uuid:'')}catch{}})" "$NAME")"
if [ -z "$DBID" ]; then
  DBID="$(cd "$WORK" && $W d1 create "$NAME" 2>&1 | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)"
fi
[ -n "$DBID" ] || { echo "Could not create or find the database $NAME." >&2; exit 1; }

cat > "$WORK/wrangler.toml" <<EOF
name = "$NAME"
main = "src/index.js"
compatibility_date = "2025-09-01"
workers_dev = true

[observability]
enabled = false

[[d1_databases]]
binding = "DB"
database_name = "$NAME"
database_id = "$DBID"
EOF
(cd "$WORK" && $W d1 execute "$NAME" --remote --file schema.sql >/dev/null)
say "Database ready."

if [ -f "$KEYFILE" ]; then
  say "Keeping the team key already saved for $NAME."
else
  mkdir -p "$(dirname "$KEYFILE")"; chmod 700 "$(dirname "$KEYFILE")"
  (umask 077; node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" > "$KEYFILE")
fi

say "Deploying…"
URL="$(cd "$WORK" && $W deploy 2>&1 | grep -Eo 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1)"
[ -n "$URL" ] || { echo "The deploy did not report a workers.dev address. Run 'npx wrangler deploy' in server/ to see why." >&2; exit 1; }
(cd "$WORK" && $W secret put TEAM_KEY < "$KEYFILE" >/dev/null)

mkdir -p "$PROJECT/.pigment"
node -e "
const fs=require('fs');const p=process.argv[1];let c={};try{c=JSON.parse(fs.readFileSync(p,'utf8'))}catch{}
c.version=1;c.storage='cloud';c.provider='cloudflare';c.serverUrl=process.argv[2];
fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n')" "$PROJECT/.pigment/config.json" "$URL"
printf '# Pigment: local numbers never go into git\n*.jsonl\n' > "$PROJECT/.pigment/.gitignore"

echo
say "Done. The team server is live at $URL"
say "Commit .pigment/config.json so everyone who opens the project finds it."
say "The team key is saved in $KEYFILE — only you can read it."
say "Open that file, add the key in /config under Pigment (Team key), and share it with your team privately (not in the repo, not in a public chat)."
