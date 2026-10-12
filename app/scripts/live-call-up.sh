#!/usr/bin/env bash
#
# SAU-292 — one-command live Twilio call bring-up (synthetic / internal callers ONLY).
#
# Brings up the full local live-call path and points the trial number at it, so a
# human tester only has to DIAL. Tears everything down (and restores the number's
# voice webhook) on Ctrl-C.
#
#   1. bridge server          → :$BRIDGE_PORT  (media-stream WS, μ-law both ways)
#   2. cloudflared quick tunnel → bridge  ⇒ TELEPHONY_PUBLIC_URL (wss://…)
#   3. cloudflared quick tunnel → web     ⇒ public https webhook URL (opened BEFORE
#      next dev listens, so the webhook knows the exact URL Twilio will sign)
#   4. next dev               → :$WEB_PORT  (serves the incoming-call webhook,
#      signature verification ON, TELEPHONY_PUBLIC_WEBHOOK_URL = that URL)
#   5. PATCH the trial number's Voice "A CALL COMES IN" webhook → that URL
#   6. print "Dial +1… now"
#
# SAU-541 (CISO R2): NOTHING reachable through a tunnel runs with
# TWILIO_VERIFY_SIGNATURES=false. With verification off the webhook would answer any
# unauthenticated POST, and the bridge would admit any socket — a free call against
# a clinic's minute cap. Both processes are pinned to `true` below, overriding .env.local.
#
# Creds are read from app/.env.local (gitignored). The auth token is NEVER echoed.
# Tunnels are ephemeral (trycloudflare.com) — fine for a live test, not for prod.
# Real-patient calls are OUT OF SCOPE here (HIPAA gate SAU-272 / pilot SAU-290).
set -euo pipefail
cd "$(dirname "$0")/.."   # → app/

BRIDGE_PORT="${TELEPHONY_BRIDGE_PORT:-5050}"
WEB_PORT="${WEB_PORT:-3000}"
ENV_FILE=".env.local"
WEBHOOK_PATH="/api/telephony/twilio/incoming-call"

[ -f "$ENV_FILE" ] || { echo "FATAL: $ENV_FILE missing (Twilio creds)"; exit 1; }
set -a; . "./$ENV_FILE"; set +a
SID="${TWILIO_ACCOUNT_SID:?TWILIO_ACCOUNT_SID not set}"
: "${TWILIO_AUTH_TOKEN:?TWILIO_AUTH_TOKEN not set}"
NUMBER="${TWILIO_PHONE_NUMBER:?set TWILIO_PHONE_NUMBER to the claimed trial number (E.164)}"

pids=(); orig_voice_url=""
cleanup() {
  echo; echo "[cleanup] stopping processes…"
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  if [ -n "$orig_voice_url" ]; then
    echo "[cleanup] restoring number voice webhook"
    curl -s -u "$SID:$TWILIO_AUTH_TOKEN" -X POST \
      "https://api.twilio.com/2010-04-01/Accounts/$SID/IncomingPhoneNumbers/$PN_SID.json" \
      --data-urlencode "VoiceUrl=$orig_voice_url" >/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Resolve the IncomingPhoneNumber SID + remember its current voice_url to restore.
read -r PN_SID orig_voice_url < <(curl -s -u "$SID:$TWILIO_AUTH_TOKEN" \
  "https://api.twilio.com/2010-04-01/Accounts/$SID/IncomingPhoneNumbers.json?PhoneNumber=$NUMBER" \
  | python3 -c "import sys,json;n=json.load(sys.stdin)['incoming_phone_numbers'];print(n[0]['sid'], n[0].get('voice_url','')) if n else sys.exit('number not owned')")
echo "[twilio] number $NUMBER  PN=$PN_SID"

wait_for_tunnel() { # $1=logfile → echoes https URL
  for _ in $(seq 1 30); do
    u=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$1" 2>/dev/null | head -1)
    [ -n "$u" ] && { echo "$u"; return 0; }
    sleep 1
  done
  return 1
}

echo "[1/5] bridge :$BRIDGE_PORT (stream signatures verified)"
TWILIO_VERIFY_SIGNATURES=true TELEPHONY_BRIDGE_PORT="$BRIDGE_PORT" npm run --silent bridge >/tmp/sau292-bridge.log 2>&1 & pids+=($!)
sleep 3

echo "[2/5] tunnel → bridge"
cloudflared tunnel --url "http://localhost:$BRIDGE_PORT" --no-autoupdate >/tmp/sau292-cf-bridge.log 2>&1 & pids+=($!)
BRIDGE_HTTPS=$(wait_for_tunnel /tmp/sau292-cf-bridge.log) || { echo "FATAL: bridge tunnel failed"; exit 1; }
export TELEPHONY_PUBLIC_URL="wss://${BRIDGE_HTTPS#https://}"
echo "      TELEPHONY_PUBLIC_URL=$TELEPHONY_PUBLIC_URL"

echo "[3/5] tunnel → web (opened first: the webhook must know the URL Twilio signs)"
cloudflared tunnel --url "http://localhost:$WEB_PORT" --no-autoupdate >/tmp/sau292-cf-web.log 2>&1 & pids+=($!)
WEB_HTTPS=$(wait_for_tunnel /tmp/sau292-cf-web.log) || { echo "FATAL: web tunnel failed"; exit 1; }
WEBHOOK_URL="${WEB_HTTPS}${WEBHOOK_PATH}"

echo "[4/5] next dev :$WEB_PORT (X-Twilio-Signature verified against $WEBHOOK_URL)"
TELEPHONY_PUBLIC_URL="$TELEPHONY_PUBLIC_URL" TELEPHONY_PUBLIC_WEBHOOK_URL="$WEBHOOK_URL" \
  TWILIO_VERIFY_SIGNATURES=true \
  npm run --silent dev -- -p "$WEB_PORT" >/tmp/sau292-web.log 2>&1 & pids+=($!)
sleep 6

echo "[5/5] point number Voice webhook → $WEBHOOK_URL"
curl -s -u "$SID:$TWILIO_AUTH_TOKEN" -X POST \
  "https://api.twilio.com/2010-04-01/Accounts/$SID/IncomingPhoneNumbers/$PN_SID.json" \
  --data-urlencode "VoiceUrl=$WEBHOOK_URL" --data-urlencode "VoiceMethod=POST" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('      voice_url now:', d.get('voice_url'))"

cat <<EOF

============================================================
  READY — DIAL  $NUMBER  NOW  (synthetic/internal tester only)
  Trial notice plays first ("press any key"), then the agent answers.
  webhook : $WEBHOOK_URL
  bridge  : $TELEPHONY_PUBLIC_URL/telephony/bridge
  logs    : /tmp/sau292-{bridge,web,cf-bridge,cf-web}.log
  Ctrl-C to tear down + restore the number's previous webhook.
============================================================
EOF
wait
