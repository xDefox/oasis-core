#!/usr/bin/env bash
# Один шаг: поднять сервер, туннель и собрать клиент под адрес туннеля.
# Печатает ссылку для игроков.
#
#   scripts/deploy.sh                      # cloudflare, при сбое — pinggy
#   TUNNEL=cloudflare scripts/deploy.sh    # принудительно cloudflare
#   TUNNEL=pinggy scripts/deploy.sh        # принудительно pinggy
#   node scripts/deploy-check.mjs          # проверить, что деплой играется
#
# Почему один туннель, а не два (сначала было два): страница и WebSocket на
# разных доменах — это две страницы входа. Бесплатные туннели показывают
# предупреждение «ты уверен?» и запоминают согласие кукой на своём домене,
# поэтому второй адрес пользователь обойти не может. Сервер отдаёт собранный
# клиент сам (см. packages/server/src/index.ts), и всё живёт на одном хосте.
#
# Порядок: адрес wss-туннеля выдаётся только при старте туннеля, а он
# вшивается в бандл на этапе сборки — поэтому сначала сервер и туннель,
# потом сборка.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GAME_PORT="${GAME_PORT:-2567}"
STATE="$ROOT/.deploy-state"
SERVER_LOG=/tmp/tun-server.log
SERVER_PID=/tmp/oasis-server.pid

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
    url="$(grep -oE 'https://[a-z0-9-]+\.(trycloudflare\.com|free\.pinggy\.net|pinggy-free\.link)' "$log" 2>/dev/null | grep -v 'api\.' | tail -1 || true)"
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

# ── 1. освободить порты ────────────────────────────────────────────────────
for p in "$GAME_PORT" 8080 5173; do
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

# ── 3. туннель (страница и WebSocket на одном адресе) ─────────────────────
say "туннель (TUNNEL=$TUNNEL)"
URL="$(start_tunnel "$GAME_PORT" "$SERVER_LOG")" || { echo "туннель не выдал URL" >&2; exit 1; }
HOST="${URL#https://}"
say "  https://$HOST"

# ── 4. сборка клиента под этот адрес ──────────────────────────────────────
say "сборка клиента"
printf 'VITE_SERVER_URL=wss://%s\n' "$HOST" > packages/client/.env.production
npm run build -w @oasis/client >/tmp/oasis-build.log 2>&1 || {
  echo "сборка упала, лог /tmp/oasis-build.log" >&2; exit 1;
}
if ! grep -qs "wss://$HOST" packages/client/dist/assets/*.js; then
  echo "в бандле нет wss://$HOST — сборка не подхватила .env.production" >&2
  exit 1
fi
# Сервер отдаёт dist сам, отдельная статика и второй туннель не нужны.

# ── 5. состояние ──────────────────────────────────────────────────────────
cat > "$STATE" <<EOF
CLIENT_URL=https://$HOST
WS_URL=wss://$HOST
GAME_PORT=$GAME_PORT
STATIC_PORT=-
TUNNEL=$TUNNEL
EOF

sleep 3
# Проверка снаружи. У pinggy и localtunnel браузер получает страницу-предупреждение
# (511/200 с формой), поэтому обычный curl может вернуть и 200, и 511 — важно,
# что сеть до хоста достаёт. Настоящая проверка — scripts/deploy-check.mjs.
CODE="$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$URL/" || true)"
CODE="${CODE:-000}"
# ws: рукопожатие WebSocket (101 = туннель пропускает апгрейд). curl по
# умолчанию идёт по HTTP/2, там Connection: Upgrade вырезается — обязателен --http1.1.
# После 101 curl сам ругается на оборванный ответ (тут нет тела) — код читаем
# из -w, а статус выхода игнорируем, иначе к коду приклеивается «000».
WS_CHECK="$(curl -s -m 15 --http1.1 -o /dev/null -w '%{http_code}' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "$URL/" || true)"
WS_CHECK="${WS_CHECK:-000}"

say ""
say "игра:  $URL"
say "ws:    wss://$HOST"
say "страница: HTTP $CODE   ws: HTTP $WS_CHECK (101 = ок)"
if grep -q 'pinggy' "$SERVER_LOG" 2>/dev/null; then
  say "pinggy: первым игрокам нужно нажать «Enter site» на странице предупреждения"
  say "внимание: адрес туннеля живёт 60 минут, потом — повторный deploy.sh"
fi
say ""
say "остановить: lsof -ti:$GAME_PORT | xargs -r kill -9; pkill -f 'cloudflared tunnel'; pkill -f 'a.pinggy.io'"
