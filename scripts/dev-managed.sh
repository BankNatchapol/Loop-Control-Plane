#!/usr/bin/env bash

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AO_ROOT="$ROOT/vendor/agent-orchestrator"
SUPERVISOR_PID=""
INTERRUPT_COUNT=0
LAST_INTERRUPT_SECOND=0
EXIT_CODE=0

signal_supervisor() {
  local signal="$1"
  if [[ -n "$SUPERVISOR_PID" ]] && kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
    kill "-$signal" "$SUPERVISOR_PID" 2>/dev/null || true
  fi
}

managed_listener_pids() {
  local port pid cwd
  for port in 3000 3100 14801 31101 31999; do
    while IFS= read -r pid; do
      [[ -n "$pid" ]] || continue
      cwd="$(
        lsof -a -p "$pid" -d cwd -Fn 2>/dev/null |
          sed -n 's/^n//p' |
          head -n 1
      )"
      case "$cwd" in
        "$ROOT"|"$ROOT"/*|"$AO_ROOT"|"$AO_ROOT"/*)
          printf '%s\n' "$pid"
          ;;
      esac
    done < <(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  done | sort -u
}

signal_managed_listeners() {
  local signal="$1"
  local pid pgid
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    if [[ -n "$pgid" && "$pgid" != "$$" ]]; then
      kill "-$signal" -- "-$pgid" 2>/dev/null || true
    else
      kill "-$signal" "$pid" 2>/dev/null || true
    fi
  done < <(managed_listener_pids)
}

force_cleanup() {
  printf '\n[managed] Forcing cleanup of managed process groups.\n'
  signal_supervisor TERM
  signal_managed_listeners TERM
  sleep 1
  signal_managed_listeners KILL
  if [[ -n "$SUPERVISOR_PID" ]] && kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
    kill -KILL "$SUPERVISOR_PID" 2>/dev/null || true
  fi
}

handle_interrupt() {
  local now
  now="$(date +%s)"
  if [[ "$INTERRUPT_COUNT" -gt 0 && "$now" -eq "$LAST_INTERRUPT_SECOND" ]]; then
    return
  fi
  LAST_INTERRUPT_SECOND="$now"
  INTERRUPT_COUNT=$((INTERRUPT_COUNT + 1))
  EXIT_CODE=130
  if [[ "$INTERRUPT_COUNT" -eq 1 ]]; then
    printf '\n[managed] Interrupt received; waiting for cleanup. Press Ctrl-C again to force exit.\n'
    signal_supervisor TERM
  else
    force_cleanup
  fi
}

handle_termination() {
  EXIT_CODE=143
  signal_supervisor TERM
}

trap handle_interrupt INT
trap handle_termination TERM HUP

node "$ROOT/scripts/dev-managed.mjs" &
SUPERVISOR_PID=$!

while kill -0 "$SUPERVISOR_PID" 2>/dev/null; do
  wait "$SUPERVISOR_PID"
  STATUS=$?
  if ! kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
    if [[ "$EXIT_CODE" -eq 0 ]]; then
      EXIT_CODE=$STATUS
    fi
    break
  fi
done

exit "$EXIT_CODE"
