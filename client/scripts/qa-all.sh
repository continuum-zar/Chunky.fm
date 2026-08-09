#!/usr/bin/env bash
#
# Every browser QA script, in one run.
#
#   npm run qa:all
#
# Needs a Vite dev server on CLIENT_URL, a built server (`cd server && npm run
# build`), and at least two tracks in the library a few minutes long. See the
# README and scripts/qa-env.ts.
#
# The station is restarted before each script, and that is the point of this
# file. The roster, the chat and the evening's history all live
# in the session, and most of these scripts open by asserting on an empty one,
# so run back-to-back against one long-lived station, whichever goes second
# fails on the first one's leftovers. Restarting is the only thing that gives
# each script the empty room it is written against.
set -u

cd "$(dirname "${BASH_SOURCE[0]}")/.."

export CHROME_PATH=${CHROME_PATH:-/usr/bin/google-chrome}
export CLIENT_URL=${CLIENT_URL:-http://localhost:5173}
export API_URL=${API_URL:-http://localhost:3000}
export ADMIN_PASSWORD=${ADMIN_PASSWORD:-change-me}
export TRACK_ID=${TRACK_ID:-1}
export OTHER_TRACK_ID=${OTHER_TRACK_ID:-2}

SERVER_DIR=$(cd ../server && pwd)
PORT=$(node -e 'process.stdout.write(new URL(process.env.API_URL).port || "3000")')
LOGS=${QA_LOG_DIR:-$(mktemp -d)}
mkdir -p "$LOGS"

up() { curl -s -o /dev/null --max-time 2 "$API_URL/health"; }

restart_station() {
  pkill -f 'dist/index\.js' 2>/dev/null
  for _ in $(seq 1 20); do sleep 0.5; up || break; done
  ( cd "$SERVER_DIR" \
      && PORT=$PORT ADMIN_PASSWORD="$ADMIN_PASSWORD" AUDIO_STORAGE_DIR="${AUDIO_STORAGE_DIR:-$SERVER_DIR/audio_storage}" \
         nohup node dist/index.js >/dev/null 2>&1 & )
  for _ in $(seq 1 20); do sleep 0.5; up || continue
    # On air, because a station is off by default: going live the instant it
    # was deployed would put every restart on air with an empty queue. Every
    # script below assumes a broadcast is happening — the chat, the wish book
    # and the mic are all refused without a session to belong to.
    curl -s -o /dev/null -X POST -H "authorization: Bearer $ADMIN_PASSWORD" \
      -H 'content-type: application/json' -d '{"action":"start"}' \
      "$API_URL/api/session"
    return 0
  done
  return 1
}

SCRIPTS=(
  qa:playback qa:admin qa:mic qa:soundcheck qa:voice qa:chat qa:chat-refusal qa:wishes
  qa:history qa:presence qa:reconnect qa:offline verify:sync
)

echo "logs → $LOGS"
failures=0
for script in "${SCRIPTS[@]}"; do
  restart_station || { printf 'SETUP-FAIL  %-18s no station on %s\n' "$script" "$API_URL"; failures=$((failures + 1)); continue; }

  # The only one that does not put a track on for itself: it is measuring two
  # listeners against a song that is already playing.
  if [ "$script" = "verify:sync" ]; then
    curl -s -o /dev/null -X POST -H "authorization: Bearer $ADMIN_PASSWORD" \
      -H 'content-type: application/json' -d "{\"action\":\"play\",\"trackId\":$TRACK_ID}" \
      "$API_URL/api/playback"
    sleep 1
  fi

  log="$LOGS/${script//:/-}.log"
  npm run "$script" >"$log" 2>&1
  code=$?
  passed=$(grep -c '^PASS' "$log")
  failed=$(grep -c '^FAIL' "$log")
  if [ "$code" -eq 0 ] && [ "$failed" -eq 0 ]; then
    printf 'PASS  %-18s %s checks\n' "$script" "$passed"
  else
    printf 'FAIL  %-18s %s pass / %s fail (exit %s) → %s\n' "$script" "$passed" "$failed" "$code" "$log"
    failures=$((failures + 1))
  fi
done

pkill -f 'dist/index\.js' 2>/dev/null
echo
if [ "$failures" -eq 0 ]; then
  echo "ALL QA PASSED"
else
  echo "$failures QA SCRIPT(S) FAILED"
fi
exit $((failures > 0))
