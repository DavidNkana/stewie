#!/bin/bash
# Keeps the Evolution WhatsApp instance connected.
#
# Evolution stops auto-connecting an instance whose stored status is "close",
# so a dropped socket can leave the bot silently dead. This resets the status
# and restarts Evolution, then reports if the session needs re-pairing.
set -uo pipefail

EVOK=$(cat /home/davai/.davai-secrets/EVOLUTION_API_KEY)
DBPW=$(cat /home/davai/.davai-secrets/EVOLUTION_DB_PASSWORD)
INSTANCE=${1:-stewie}
LOG=/home/davai/tmp/evo/watchdog.log
DB="sudo -u postgres psql -d evolution_db -tAc"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }

state=$(curl -s --max-time 15 -H "apikey: $EVOK" \
  "http://127.0.0.1:8080/instance/connectionState/$INSTANCE" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log((j.instance&&j.instance.state)||'unknown');}catch(e){console.log('unknown');}});")

if [ "$state" = "open" ]; then
  exit 0
fi

log "instance=$INSTANCE state=$state - attempting recovery"

# A closed instance is skipped by Evolution's auto-connect, so clear the flag.
sudo -u postgres psql -d evolution_db -c \
  "UPDATE evolution_api.\"Instance\" SET \"connectionStatus\" = 'connecting', \"updatedAt\" = now() WHERE \"name\" = '$INSTANCE';" >> "$LOG" 2>&1
sudo systemctl restart evolution-api >> "$LOG" 2>&1

sleep 30
new_state=$(curl -s --max-time 15 -H "apikey: $EVOK" \
  "http://127.0.0.1:8080/instance/connectionState/$INSTANCE" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log((j.instance&&j.instance.state)||'unknown');}catch(e){console.log('unknown');}});")

if [ "$new_state" = "open" ]; then
  log "instance=$INSTANCE recovered"
else
  log "instance=$INSTANCE still '$new_state' - WhatsApp removed the device, it needs a fresh QR scan"
fi
