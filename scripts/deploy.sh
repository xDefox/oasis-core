#!/usr/bin/env bash
# Один шаг: собрать клиент под актуальный адрес туннеля, поднять сервер,
# статику и два туннеля. Печатает ссылку для игроков.
#
#   scripts/deploy.sh
#
# Почему именно такой порядок: адрес wss-туннеля выдаётся только при старте
# cloudflared, а он вшивается в бандл на этапе сборки. Поэтому сначала
# поднимаем сервер и его туннель, потом собираем клиент, потом статику.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATIC_PORT="${STATIC_PORT:-8080}"
GAME_PORT="${GAME_PORT:-2567}"
STATE="$ROOT/.deploy-state"
CLIENT_LOG=/tmp/tun-client.log
SERVER_LOG=/tmp/tun-server.log
SERVER_PID=/tmp/oasis-server.pid
STATIC_PID=/tmp/oasis-static.pid

cd "$ROOT"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

alive() { lsof -ti:"$1" >/dev/null 2>&1; }

url_from() {
  local log="$1" i
  for i in $(seq 1 60); do
    local url
    url="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$log" 2>/dev/null | grep -v 'api\.' | tail -1 || true)"
    if [ -n "$url" ]; then printf '%s' "$url"; return 0; fi
    sleep 1
  done
  return 1
}

# ── 1. предупредить, если порты заняты ────────────────────────────────────
for p in "$GAME_PORT" "$STATIC_PORT"; do
  if alive "$p"; then
    pid="$(lsof -ti:"$p" | head -1)"
    say "порт $p уже занят (pid $pid) — останавливаю"
    lsof -ti:"$p" | xargs -r kill -9
    sleep 1
  fi
done

# ── 2. игровой сервер ─────────────────────────────────────────────────────
say "сервер на :$GAME_PORT"
nohup node_modules/.bin/tsx packages/server/src/index.ts > /tmp/oasis-server.log 2>&1 &
echo $! > "$SERVER_PID"
for i in $(seq 1 40); do alive "$GAME_PORT" && break; sleep 1; done
alive "$GAME_PORT" || { echo "сервер не поднялся, лог /tmp/oasis-server.log" >&2; exit 1; }

# ── 3. туннель сервера ────────────────────────────────────────────────────
say "туннель сервера"
: > "$SERVER_LOG"
nohup bash scripts/tunnel.sh "$GAME_PORT" "$SERVER_LOG" >/dev/null 2>&1 &
WS_URL="$(url_from "$SERVER_LOG")" || { echo "туннель сервера не выдал URL" >&2; exit 1; }
WS_HOST="${WS_URL#https://}"
say "  wss://$WS_HOST"

# ── 4. сборка клиента под этот адрес ──────────────────────────────────────
say "сборка клиента"
printf 'VITE_SERVER_URL=wss://%s\n' "$WS_HOST" > packages/client/.env.production
npm run build -w @oasis/client >/tmp/oasis-build.log 2>&1 || {
  echo "сборка упала, лог /tmp/oasis-build.log" >&2; exit 1;
}
if ! grep -qs "wss://$WS_HOST" packages/client/dist/assets/*.js; then
  echo "в бандле нет wss://$WS_HOST — сборка не подхватила .env.production" >&2
  exit 1
fi

# ── 5. статика + её туннель ───────────────────────────────────────────────
say "статика на :$STATIC_PORT"
nohup npx --yes serve -s packages/client/dist -l "$STATIC_PORT" >/tmp/oasis-static.log 2>&1 &
echo $! > "$STATIC_PID"
for i in $(seq 1 40); do alive "$STATIC_PORT" && break; sleep 1; done
alive "$STATIC_PORT" || { echo "статика не поднялась" >&2; exit 1; }

say "туннель клиента"
: > "$CLIENT_LOG"
nohup bash scripts/tunnel.sh "$STATIC_PORT" "$CLIENT_LOG" >/dev/null 2>&1 &
CLIENT_URL="$(url_from "$CLIENT_LOG")" || { echo "туннель клиента не выдал URL" >&2; exit 1; }

# ── 6. состояние ──────────────────────────────────────────────────────────
cat > "$STATE" <<EOF
CLIENT_URL=$CLIENT_URL
WS_URL=wss://$WS_HOST
GAME_PORT=$GAME_PORT
STATIC_PORT=$STATIC_PORT
EOF

sleep 5
# Локальный резолвер не видит *.trycloudflare.com (та же беда, что у
# cloudflared), поэтому адрес берём через 1.1.1.1 и подставляем в --resolve.
HOST="${CLIENT_URL#https://}"
IP="$(node -e "
  const dns=require('dns'); dns.setServers(['1.1.1.1']);
  dns.resolve4('$HOST', (e,a)=>process.stdout.write(e?'':(a[0]||'')));
" 2>/dev/null || true)"
if [ -n "$IP" ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --resolve "$HOST:443:$IP" "$CLIENT_URL/" || echo 000)"
else
  CODE="000 (не удалось зарезолвить локально — проверьте снаружи)"
fi

say ""
say "игра:  $CLIENT_URL"
say "ws:    wss://$WS_HOST"
say "статус клиента: HTTP $CODE"
say ""
say "остановить: lsof -ti:$GAME_PORT,$STATIC_PORT | xargs -r kill -9; pkill -f 'cloudflared tunnel'"
