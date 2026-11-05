#!/usr/bin/env bash
# Post-deploy check against a REAL scanning service. Usage:
#   SCAN_URL=https://contract-scanner-xxxx.a.run.app SCAN_TOKEN=... ./scripts/smoke.sh
# Sends a harmless file and the harmless EICAR antivirus test string, and checks a wrong token is rejected.
set -euo pipefail
: "${SCAN_URL:?set SCAN_URL}" "${SCAN_TOKEN:?set SCAN_TOKEN}"

echo "ready:   $(curl -fsS "$SCAN_URL/ready" | head -c 200)"

clean=$(printf 'This is an ordinary contract sentence.' | curl -sS -X POST "$SCAN_URL/scan" \
  -H "Authorization: Bearer $SCAN_TOKEN" -H 'Content-Type: application/octet-stream' --data-binary @-)
echo "clean:   $clean"
echo "$clean" | grep -q '"status":"clean"' || { echo "FAIL: expected clean"; exit 1; }

# The standard EICAR test string (harmless; every antivirus recognises it)
eicar=$(printf '%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' | curl -sS -X POST "$SCAN_URL/scan" \
  -H "Authorization: Bearer $SCAN_TOKEN" -H 'Content-Type: application/octet-stream' --data-binary @-)
echo "eicar:   $eicar"
echo "$eicar" | grep -q '"status":"blocked"' || { echo "FAIL: expected blocked"; exit 1; }

code=$(printf 'x' | curl -sS -o /dev/null -w '%{http_code}' -X POST "$SCAN_URL/scan" -H 'Authorization: Bearer wrong' --data-binary @-)
echo "no auth: HTTP $code"
[ "$code" = "401" ] || { echo "FAIL: expected 401"; exit 1; }
echo "OK"
