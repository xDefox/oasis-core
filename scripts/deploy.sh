#!/usr/bin/env bash
# Один шаг: собрать клиент под актуальный адрес туннеля, поднять сервер,
# статику и два туннеля. Печатает ссылку для игроков.
#
#   scripts/deploy.sh                      # cloudflare, при сбое — pinggy
#   TUNNEL=cloudflare scripts/deploy.sh    # принудительно cloudflare
#   TUNNEL=pinggy scripts/deploy.sh        # принудительно pinggy (аварийный)
#   node scripts/deploy-check.mjs          # проверить, что деплой играется
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

# TUNNEL: auto | cloudflare | pinggy
#   auto      — пробуем Cloudflare, через 15 с без URL переходим на pinggy
#   cloudflare— только trycloudflare.com (нужен доступ к api.trycloudflare.com)
#   pinggy    — SSH-туннель pinggy.io (без аккаунта, адрес живёт 60 минут)
TUNNEL="${TUNNEL:-auto}"

url_from() {
  local log="$1" wait="${2:-45}" i
  for i in $(seq 1 "$wait"); do
    local url
    # оба бэкенда печатают https://<случайный-хост>
    url="$(grep -oE 'https://[a-z0-9-]+\.(trycloudflare\.com|free\.pinggy\.net|pinggy-free\.link|localhost\.run)' "$log" 2>/dev/null | grep -v 'api\.' | tail -1 || true)"
    if [ -n "$url" ]; then printf '%s' "$url"; return 0; fi
    sleep 1
  done
  return 1
}

# start_tunnel <порт> <лог> → печатает URL туннеля
start_tunnel() {
  local port="$1" log="$2" url

  if [ "$TUNNEL" != "pinggy" ]; then
    : > "$log"
    nohup bash scripts/tunnel.sh "$port" "$log" >/dev/null 2>&1 &
    if url="$(url_from "$log" 15)"; then printf '%s' "$url"; return 0; fi
    if [ "$TUNNEL" = "cloudflare" ]; then return 1; fi
    echo "  cloudflared не дал URL — пробую pinggy" >&2
    pkill -f "cloudflared tunnel .*localhost:$port" 2>/dev/null || true
  fi
  : > "$log"
  nohup bash scripts/tunnel-pinggy.sh "$port" "$log" >/dev/null 2>&1 &
  url="$(url_from "$log" 45)" || return 1
  printf '%s' "$url"
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
say "туннель сервера (TUNNEL=$TUNNEL)"
WS_URL="$(start_tunnel "$GAME_PORT" "$SERVER_LOG")" || { echo "туннель сервера не выдал URL" >&2; exit 1; }
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

say "туннель клиента (TUNNEL=$TUNNEL)"
CLIENT_URL="$(start_tunnel "$STATIC_PORT" "$CLIENT_LOG")" || { echo "туннель клиента не выдал URL" >&2; exit 1; }

# ── 6. состояние ──────────────────────────────────────────────────────────
cat > "$STATE" <<EOF
CLIENT_URL=$CLIENT_URL
WS_URL=wss://$WS_HOST
GAME_PORT=$GAME_PORT
STATIC_PORT=$STATIC_PORT
EOF

sleep 5
# Сначала обычный curl (pinggy резолвится локально), иначе — через 1.1.1.1
# и --resolve: локальный резолвер не видит *.trycloudflare.com (та же беда,
# что у cloudflared).
HOST="${CLIENT_URL#https://}"
CODE="$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$CLIENT_URL/" || echo 000)"
if [ "$CODE" != "200" ]; then
  IP="$(node -e "
    const dns=require('dns'); dns.setServers(['1.1.1.1']);
    dns.resolve4('$HOST', (e,a)=>process.stdout.write(e?'':(a[0]||'')));
  " 2>/dev/null || true)"
  if [ -n "$IP" ]; then
    CODE="$(curl -s -m 15 -o /dev/null -w '%{http_code}' --resolve "$HOST:443:$IP" "$CLIENT_URL/" || echo 000)"
  else
    CODE="000 (не удалось зарезолвить локально — проверьте снаружи)"
  fi
fi

# ws: рукопожатие WebSocket через туннель (101 = туннель пропускает апгрейд)
WS_CHECK="$(curl -s -m 15 -o /dev/null -w '%{http_code}' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "https://$WS_HOST/" || echo 000)"

say ""
say "игра:  $CLIENT_URL"
say "ws:    wss://$WS_HOST"
say "статус клиента: HTTP $CODE"
say "статус ws: HTTP $WS_CHECK (101 = ок)"
if grep -q 'pinggy' "$CLIENT_LOG" 2>/dev/null; then
  say "внимание: адрес туннеля живёт 60 минут, потом — повторный deploy.sh"
fi
say ""
say "остановить: lsof -ti:$GAME_PORT,$STATIC_PORT | xargs -r kill -9; pkill -f 'cloudflared tunnel'; pkill -f 'a.pinggy.io'"
