#!/usr/bin/env bash
#
# SAU-293 — LIVE PSTN edge proof (real Twilio Call SID + recording URL).
#
# Proves the live telephony EDGE end-to-end: a real outbound PSTN call, originated
# by the agent via the Twilio REST Calls API to our OWN trial number, whose media is
# streamed (<Connect><Stream>) over a public tunnel into the real bridge server,
# which opens a live OpenAI Realtime session. Captures the Twilio Call SID + the
# recording URL.
#
# What this proves: Twilio → public tunnel → bridge → OpenAI Realtime media path is
# live, and an agent can originate the call (trial allows outbound to our own owned
# number — verified). What it does NOT prove on its own: a two-party CONVERSATION —
# a Twilio <Connect><Stream> leg is wired to exactly ONE socket, so a synthetic
# PATIENT cannot also be placed on this single self-call leg. The full conversational
# intake→booking is proven instead by scripts/synthetic-call-e2e.sh (agent-driven,
# no PSTN needed). See docs/SAU-293-*.md.
#
# Synthetic/internal only; HIPAA gate SAU-272 in force. Trial credit only.
set -uo pipefail
cd "$(dirname "$0")/.."   # → app/

BRIDGE_PORT="${TELEPHONY_BRIDGE_PORT:-5050}"
SLUG="${SLUG:-clinic-intake-booking}"
ENV_FILE=".env.local"
BRIDGE_LOG="/tmp/sau293-pstn-bridge.log"
CF_LOG="/tmp/sau293-pstn-cf.log"

[ -f "$ENV_FILE" ] || { echo "FATAL: $ENV_FILE missing"; exit 1; }
set -a; . "./$ENV_FILE"; set +a
SID="${TWILIO_ACCOUNT_SID:?}"; : "${TWILIO_AUTH_TOKEN:?}"; NUM="${TWILIO_PHONE_NUMBER:?}"

pids=()
cleanup() { echo; echo "[cleanup] stopping…"; for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

echo "[1/5] bridge :$BRIDGE_PORT"
: > "$BRIDGE_LOG"
TELEPHONY_BRIDGE_PORT="$BRIDGE_PORT" npm run --silent bridge >"$BRIDGE_LOG" 2>&1 & pids+=($!)
for _ in $(seq 1 30); do grep -q '"event":"listening"' "$BRIDGE_LOG" && break; sleep 1; done
grep -q '"event":"listening"' "$BRIDGE_LOG" || { echo "FATAL: bridge down"; cat "$BRIDGE_LOG"; exit 1; }

echo "[2/5] tunnel → bridge"
: > "$CF_LOG"
cloudflared tunnel --url "http://localhost:$BRIDGE_PORT" --no-autoupdate >"$CF_LOG" 2>&1 & pids+=($!)
BRIDGE_HTTPS=""
for _ in $(seq 1 30); do
  BRIDGE_HTTPS=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$CF_LOG" 2>/dev/null | head -1)
  [ -n "$BRIDGE_HTTPS" ] && break; sleep 1
done
[ -n "$BRIDGE_HTTPS" ] || { echo "FATAL: tunnel failed"; cat "$CF_LOG"; exit 1; }
STREAM_URL="wss://${BRIDGE_HTTPS#https://}/telephony/bridge?slug=${SLUG}"
echo "      stream: $STREAM_URL"
sleep 2

echo "[3/5] originate recorded outbound call  To=$NUM (own trial number)"
TWIML="<Response><Connect><Stream url=\"${STREAM_URL}\"/></Connect></Response>"
RESP=$(curl -s -u "$SID:$TWILIO_AUTH_TOKEN" -X POST \
  "https://api.twilio.com/2010-04-01/Accounts/$SID/Calls.json" \
  --data-urlencode "To=$NUM" --data-urlencode "From=$NUM" \
  --data-urlencode "Twiml=$TWIML" \
  --data-urlencode "Record=true")
CALL_SID=$(printf '%s' "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('sid',''))")
echo "      Call SID: ${CALL_SID:-<none>}"
[ -n "$CALL_SID" ] || { echo "FATAL: call not created. Resp: $RESP"; exit 1; }

echo "[4/5] let the media stream run ~22s…"
sleep 22

echo "[5/5] fetch call result + recording"
curl -s -u "$SID:$TWILIO_AUTH_TOKEN" "https://api.twilio.com/2010-04-01/Accounts/$SID/Calls/$CALL_SID.json" \
 | python3 -c "import sys,json;d=json.load(sys.stdin);print('      status:',d.get('status'),'duration:',d.get('duration'),'price:',d.get('price'))"
REC_JSON=$(curl -s -u "$SID:$TWILIO_AUTH_TOKEN" "https://api.twilio.com/2010-04-01/Accounts/$SID/Calls/$CALL_SID/Recordings.json")
printf '%s' "$REC_JSON" | python3 -c "
import sys,json
recs=json.load(sys.stdin).get('recordings',[])
if not recs: print('      recording: (none yet — may still be processing)')
for r in recs:
  print('      recording SID:', r.get('sid'),'duration:',r.get('duration'),'s')
  print('      recording URL: https://api.twilio.com'+r.get('uri','').replace('.json','.mp3'))
"

echo
echo "===== bridge-side proof (live Twilio media reached the bridge) ====="
grep -E '"event":"(connection|bridge_started|bridge_error|no_openai_key)"' "$BRIDGE_LOG" || echo "(no bridge connection logged — stream did not reach bridge)"
echo "===================================================================="
echo "Call SID: $CALL_SID   ·   bridge log: $BRIDGE_LOG"
