#!/usr/bin/env bash
# Post-deployment check of a REAL scanning service, including the harmless EICAR antivirus test string.
#
#   SCAN_URL=https://contract-scanner-xxxx.a.run.app SCAN_TOKEN=... ./scripts/smoke.sh
#
# SCAN_URL is the service's base URL (no /scan). The token is read from the environment and never printed.
# Optional: WAIT_SECONDS=600 (how long to wait for ClamAV after a cold start; default 300).
#
# The EICAR string is piped straight from the shell and never saved to a file, so your laptop's own antivirus
# does not quarantine it.
set -uo pipefail
: "${SCAN_URL:?set SCAN_URL (the base URL of the Cloud Run service)}" "${SCAN_TOKEN:?set SCAN_TOKEN}"
SCAN_URL="${SCAN_URL%/}"; SCAN_URL="${SCAN_URL%/scan}"
WAIT_SECONDS="${WAIT_SECONDS:-300}"
fail() { echo "FAIL: $1"; exit 1; }
pass() { echo "PASS: $1"; }

# 1. Wait until ClamAV is ready. A cold start (new instance + signature load) can take minutes.
echo "Waiting for ClamAV to be ready (up to ${WAIT_SECONDS}s)..."
deadline=$((SECONDS + WAIT_SECONDS)); ready=""
while [ "$SECONDS" -lt "$deadline" ]; do
  ready=$(curl -sS -m 15 "$SCAN_URL/ready" 2>/dev/null || true)
  echo "$ready" | grep -q '"status":"ready"' && break
  ready=""; sleep 5
done
[ -n "$ready" ] || fail "/ready never reported ready (the service answers 503 until ClamAV has loaded its signatures)"
pass "/ready: $ready"
echo "$ready" | grep -q '"engine":"ClamAV"' || fail "/ready does not report a ClamAV engine"

# 2. A harmless file is clean, scanned by ClamAV
clean=$(printf 'This is an ordinary contract sentence.' | curl -sS -m 60 -X POST "$SCAN_URL/scan" \
  -H "Authorization: Bearer $SCAN_TOKEN" -H 'Content-Type: application/octet-stream' --data-binary @-)
echo "clean answer: $clean"
echo "$clean" | grep -q '"status":"clean"' || fail "expected status clean"
echo "$clean" | grep -q '"engine":"ClamAV"' || fail "clean answer does not name the ClamAV engine"
pass "ordinary text is reported clean by ClamAV"

# 3. The standard EICAR antivirus test string must be BLOCKED by the real engine
eicar=$(printf '%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' | curl -sS -m 60 -X POST "$SCAN_URL/scan" \
  -H "Authorization: Bearer $SCAN_TOKEN" -H 'Content-Type: application/octet-stream' --data-binary @-)
echo "EICAR answer: $eicar"
echo "$eicar" | grep -q '"status":"blocked"' || fail "EICAR was NOT blocked. Do not use this service."
echo "$eicar" | grep -qi 'eicar' || fail "EICAR answer does not name the signature"
pass "EICAR test string is blocked (real ClamAV signature)"

# 4. Authentication: wrong and missing tokens are rejected
for header in "Authorization: Bearer not-the-token" "X-None: none"; do
  code=$(printf 'x' | curl -sS -m 30 -o /dev/null -w '%{http_code}' -X POST "$SCAN_URL/scan" -H "$header" --data-binary @-)
  [ "$code" = "401" ] || fail "request with '$header' returned HTTP $code, expected 401"
done
pass "wrong or missing token -> 401"

# 5. ClamAV's TCP port must not be reachable from the internet
host=$(printf '%s' "$SCAN_URL" | sed -E 's#^https?://([^/:]+).*#\1#')
if command -v timeout >/dev/null 2>&1; then
  if timeout 8 bash -c "exec 3<>/dev/tcp/$host/3310" 2>/dev/null; then fail "port 3310 is OPEN on $host (ClamAV must be private)"; fi
  pass "port 3310 is not reachable from the internet"
else
  echo "SKIP: 'timeout' is not installed, so the port 3310 check was not run. Run: nc -zv -w 5 $host 3310  (it must fail)"
fi

echo "ALL CHECKS PASSED"
