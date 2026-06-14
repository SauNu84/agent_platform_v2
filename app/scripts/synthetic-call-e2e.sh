#!/usr/bin/env bash
#
# SAU-293 — one-command agent-driven SYNTHETIC end-to-end clinic call (test-only).
#
# Brings up the REAL telephony bridge (`npm run bridge`, the shipped entrypoint),
# then runs the synthetic patient driver (scripts/synthetic-caller.ts) which
# impersonates a Twilio Media Stream and plays the patient with a 2nd OpenAI
# Realtime session. The clinic agent runs its true intake → booking flow; we then
# extract the bridge's own finalize log (outcome + event id) + the dialogue.
#
# No tunnels, no Twilio credit, runs entirely in one session. Synthetic / internal
# only; HIPAA gate SAU-272 stays in force (mock calendar, no real PHI).
#
#   ./scripts/synthetic-call-e2e.sh
set -uo pipefail
cd "$(dirname "$0")/.."   # → app/

BRIDGE_PORT="${TELEPHONY_BRIDGE_PORT:-5050}"
BRIDGE_LOG="/tmp/sau293-bridge.log"
CALLER_LOG="/tmp/sau293-caller.log"
: > "$BRIDGE_LOG"; : > "$CALLER_LOG"

bridge_pid=""
cleanup() {
  [ -n "$bridge_pid" ] && kill "$bridge_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[1/3] starting bridge on :$BRIDGE_PORT (real npm run bridge)…"
TELEPHONY_BRIDGE_PORT="$BRIDGE_PORT" npm run --silent bridge >"$BRIDGE_LOG" 2>&1 &
bridge_pid=$!

# Wait for the bridge to report listening.
for _ in $(seq 1 30); do
  grep -q '"event":"listening"' "$BRIDGE_LOG" && break
  sleep 1
done
if ! grep -q '"event":"listening"' "$BRIDGE_LOG"; then
  echo "FATAL: bridge did not start. Log:"; cat "$BRIDGE_LOG"; exit 1
fi
echo "      bridge up."

echo "[2/3] running synthetic patient driver…"
SYNTH_BRIDGE_URL="ws://localhost:$BRIDGE_PORT/telephony/bridge" \
  npx tsx --env-file-if-exists=.env.local scripts/synthetic-caller.ts 2>&1 | tee "$CALLER_LOG"

# Give the bridge a moment to flush its finalize log.
sleep 2

echo
echo "[3/3] ===== SAU-293 RESULT ====="
echo "--- bridge tool calls ---"
grep '"event":"tool_call"' "$BRIDGE_LOG" || echo "(none)"
echo "--- bridge finalize (outcome + event id) ---"
grep '"event":"finalized"' "$BRIDGE_LOG" || echo "(none — call may not have finalized)"
echo "--- bridge errors (if any) ---"
grep -E '"event":"(bridge_error|realtime_error|tool_error|no_openai_key|scenario_not_found)"' "$BRIDGE_LOG" || echo "(none)"
echo "==============================="
echo "Full logs: $BRIDGE_LOG  ·  $CALLER_LOG"
