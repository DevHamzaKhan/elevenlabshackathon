#!/usr/bin/env bash
# Every Caller check that needs no person: unit tests + dry-run calls against fakes/hub.py.
# Never places a real call (CALLER_DRY_RUN=1 is forced here).
set -euo pipefail
cd "$(dirname "$0")"

PORT="${CALLER_CHECK_PORT:-8799}"
LOGDIR="logs/check"
mkdir -p "$LOGDIR"

echo "== unit tests"
uv run pytest -q

uv sync -q
HUB_PID=""
CALLER_PID=""
cleanup() {
  [[ -n "$CALLER_PID" ]] && kill "$CALLER_PID" 2>/dev/null || true
  [[ -n "$HUB_PID" ]] && kill "$HUB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

# run_e2e <name> <allowlist> [fake hub args...]
run_e2e() {
  local name="$1" allowlist="$2"; shift 2
  echo "== dry-run end-to-end: $name"
  uv run fakes/hub.py --port "$PORT" --timeout 20 "$@" >"$LOGDIR/$name-hub.log" 2>&1 &
  HUB_PID=$!
  sleep 1  # let the fake hub bind; the caller would retry anyway
  HUB_URL="ws://localhost:$PORT" HUB_TOKEN=test CALLER_DRY_RUN=1 CALL_ALLOWLIST="$allowlist" \
    uv run --no-sync caller >"$LOGDIR/$name-caller.log" 2>&1 &
  CALLER_PID=$!
  local rc=0
  wait "$HUB_PID" || rc=$?
  HUB_PID=""
  kill "$CALLER_PID" 2>/dev/null || true
  wait "$CALLER_PID" 2>/dev/null || true
  CALLER_PID=""
  cat "$LOGDIR/$name-hub.log"
  if [[ $rc -ne 0 ]]; then
    echo "-- caller log:"; cat "$LOGDIR/$name-caller.log"
    echo "FAILED: $name (fake hub exit $rc)"
    exit "$rc"
  fi
}

run_e2e allowed "+14155550123"
run_e2e not_allowed "+14155550123" --to +14155550999 --expect-error not_allowed

echo "== all caller checks passed"
