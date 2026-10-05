#!/bin/bash
# Checks which Origins sign-up accepts/blocks. Build first: NITRO_PRESET=node-server npm run build:node
# usage: scen.sh  — runs each scenario against /home/claude/pgtest/.output
cd "$(dirname "$0")/.."
run() { # label, "ENV=.. ENV=..", host-header, origin, extra-curl-headers...
  local label="$1" envs="$2" host="$3" origin="$4"; shift 4
  rm -rf /tmp/pgs
  env -u BETTER_AUTH_URL -u RENDER_EXTERNAL_URL -u BETTER_AUTH_TRUSTED_ORIGINS -u DATABASE_URL \
    NODE_ENV=production HOST=127.0.0.1 PORT=10001 PGLITE_DATA_DIR=/tmp/pgs VITE_AUTH_ENABLED=true \
    BETTER_AUTH_SECRET=0123456789abcdef0123456789abcdef $envs \
    node .output/server/index.mjs > /tmp/scen.log 2>&1 &
  local pid=$!
  for i in $(seq 1 30); do curl -s -o /dev/null http://127.0.0.1:10001/login && break; sleep 1; done
  local email="u$RANDOM@example.com"
  local code=$(curl -s -o /tmp/scen.body -w "%{http_code}" -X POST http://127.0.0.1:10001/api/auth/sign-up/email \
     -H 'content-type: application/json' -H "host: $host" -H "origin: $origin" "$@" \
     -d "{\"email\":\"$email\",\"password\":\"password1234\",\"name\":\"T\"}")
  printf "%-62s -> %s %s\n" "$label" "$code" "$(head -c 60 /tmp/scen.body | tr -d '\n')"
  kill $pid 2>/dev/null; wait $pid 2>/dev/null
}
echo "=== should SUCCEED (200) ==="
run "S1 Docker, BETTER_AUTH_URL unset, open http://localhost:10000" "" "localhost:10000" "http://localhost:10000"
run "S2 URL=localhost:10000 but port-mapped, open localhost:3000" "BETTER_AUTH_URL=http://localhost:10000" "localhost:3000" "http://localhost:3000"
run "S3 Render URL set, visited via custom domain (proxy hdrs)" "BETTER_AUTH_URL=https://a.onrender.com" "hub.mydomain.com" "https://hub.mydomain.com" -H "x-forwarded-proto: https"
run "S4 VPS behind nginx, URL unset, https domain" "" "hub.example.com" "https://hub.example.com" -H "x-forwarded-proto: https" -H "x-forwarded-host: hub.example.com"
run "S5 LAN IP, URL unset" "" "192.168.1.50:10000" "http://192.168.1.50:10000"
echo "=== must stay BLOCKED (403) ==="
run "X1 cross-site origin vs configured URL" "BETTER_AUTH_URL=https://a.onrender.com" "a.onrender.com" "https://evil.example.com" -H "x-forwarded-proto: https"
run "X2 cross-site origin, URL unset" "" "hub.example.com" "https://evil.example.com" -H "x-forwarded-proto: https"
run "X3 spoofed origin on loopback" "" "localhost:10000" "http://attacker.test"
echo "=== strict mode (BETTER_AUTH_STRICT_ORIGINS=true): S1-style must be BLOCKED again ==="
run "STRICT, URL unset, open http://localhost:10000" "BETTER_AUTH_STRICT_ORIGINS=true" "localhost:10000" "http://localhost:10000"
run "STRICT + explicit URL still allowed" "BETTER_AUTH_STRICT_ORIGINS=true BETTER_AUTH_URL=https://hub.example.com" "hub.example.com" "https://hub.example.com" -H "x-forwarded-proto: https"
