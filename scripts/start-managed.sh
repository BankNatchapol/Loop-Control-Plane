#!/usr/bin/env bash
# One-shot bootstrap + start for Loop Control Plane + managed Agent Orchestrator.
# Usage: npm start   (or: bash scripts/start-managed.sh)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() {
  printf '[start] %s\n' "$*"
}

die() {
  printf '[start] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || die "Missing required command: $name"
}

require_node_version() {
  require_command node
  local major
  major="$(node -p "Number(process.versions.node.split('.')[0])")"
  if [[ "$major" -lt 20 ]]; then
    die "Node.js 20+ is required (found v$(node -v))."
  fi
}

needs_npm_install() {
  [[ ! -d "$ROOT/node_modules" ]] && return 0
  [[ ! -x "$ROOT/node_modules/.bin/next" ]] && return 0
  [[ ! -f "$ROOT/package-lock.json" ]] && return 0
  [[ "$ROOT/package-lock.json" -nt "$ROOT/node_modules/.package-lock.json" ]] && return 0
  return 1
}

needs_ao_submodule() {
  [[ ! -f "$ROOT/vendor/agent-orchestrator/package.json" ]]
}

needs_ao_build() {
  [[ ! -f "$ROOT/vendor/agent-orchestrator/packages/cli/dist/index.js" ]]
}

needs_corepack() {
  ! command -v pnpm >/dev/null 2>&1
}

log "Loop Control Plane — bootstrap + managed start"
log "Repository: $ROOT"

require_node_version
require_command npm
require_command git
require_command tmux

if needs_ao_submodule; then
  log "Initializing agent-orchestrator submodule…"
  git submodule update --init --recursive
fi

if needs_npm_install; then
  log "Installing npm dependencies…"
  npm install
else
  log "npm dependencies look up to date."
fi

if needs_corepack; then
  log "Enabling Corepack (for AO pnpm build)…"
  corepack enable >/dev/null 2>&1 || true
fi

if needs_ao_build; then
  log "Building managed Agent Orchestrator (first run may take a few minutes)…"
  npm run ao:setup
else
  log "Agent Orchestrator build present."
fi

log "Applying database migrations…"
npm run db:migrate

log "Starting Loop Control Plane + Agent Orchestrator…"
log "Open http://localhost:3100 when ready (AO API :3000, mux proxy :31101)."
log "Press Ctrl-C to stop both and clean up AO sessions."

exec bash "$ROOT/scripts/dev-managed.sh"
