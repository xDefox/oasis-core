#!/usr/bin/env bash
# Один шаг: поднять сервер, туннель и собрать клиент под адрес туннеля.
# Печатает ссылку для игроков.
#
#   scripts/deploy.sh                      # auto: serveo → cloudflare → pinggy
#   TUNNEL=serveo scripts/deploy.sh        # F1-17: постоянный <имя>.serveousercontent.com
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

# TUNNEL: auto | serveo | cloudflare | pinggy
#   auto      — serveo, если есть ключ; иначе Cloudflare, через 15 с — pinggy
#   serveo    — постоянный адрес <имя>.serveo.net: имя держится за SSH-ключом,
#               между запусками не меняется (нужна однократная регистрация ключа)
#   cloudflare— только trycloudflare.com (нужен доступ к api.trycloudflare.com)
#   pinggy    — SSH-туннель pinggy.io (без аккаунта, адрес живёт 60 минут)
TUNNEL="${TUNNEL:-auto}"
SERVEO_KEY="${SERVEO_KEY:-$HOME/.ssh/serveo_key}"
# Имя проверено 27.10: занятое (oasis, oasis-core) serveo отклоняет через
# «remote port forwarding failed», свободное — резервирует за зарегистрированным
# ключом. Чужой незарегистрированный ключ имя получить не может.
SERVEO_SUBDOMAIN="${SERVEO_SUBDOMAIN:-oasis-play}"

url_from() {
  local log="$1" wait="${2:-45}" i
  for i in $(seq 1 "$wait"); do
    local url
    # все бэкенды печатают https://<хост>; console.serveo.net — не туннель,
    # это ссылка на регистрацию ключа, её в URL не берём.
    url="$(grep -oE 'https://[a-z0-9-]+\.(trycloudflare\.com|free\.pinggy\.net|pinggy-free\.link|serveo\.net|serveousercontent\.com)' "$log" 2>/dev/null | grep -vE 'api\.|console\.' | tail -1 || true)"
    if [ -n "$url" ]; then printf '%s' "$url"; return 0; fi
    sleep 1
  done
  return 1
}

# start_tunnel <порт> <лог> → печатает URL туннеля
start_tunnel() {
  local port="$1" log="$2" url

  # F1-17: постоянный адрес — serveo первым, если есть ключ
  if [ "$TUNNEL" = "serveo" ] || { [ "$TUNNEL" = "auto" ] && [ -f "$SERVEO_KEY" ]; }; then
    : > "$log"
    # Старый туннель держит имя: без его остановки новый ssh получает
    # «remote port forwarding failed for listen port 80» и деплой падает.
    # Для pinggy этого не было — там адрес каждый раз свой.
    pkill -f 'ssh .*serveo\.net' 2>/dev/null || true
    sleep 1
    nohup bash scripts/tunnel-serveo.sh "$port" "$log" "$SERVEO_SUBDOMAIN" >/dev/null 2>&1 &
    if url="$(url_from "$log" 20)"; then printf '%s' "$url"; return 0; fi
    if [ "$TUNNEL" = "serveo" ]; then
      # причина отказа — например, «remote port forwarding failed» (имя занято)
      echo "  serveo не поднялся: $(tr -d '\033' < "$log" | head -1)" >&2
      return 1
    fi
    echo "  serveo не дал URL — пробую дальше" >&2
    pkill -f 'ssh .*serveo\.net' 2>/dev/null || true
  fi

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
# setsid — своя сессия у сервера: без неё процесс умирал вместе с родительской
# командой (SIGHUP при выходе шелла), и деплой выглядел «сам упал».
# Как у tunnel-pinggy.sh, где ssh так переживает закрытие шелла.
setsid nohup node_modules/.bin/tsx packages/server/src/index.ts > /tmp/oasis-server.log 2>&1 &
for i in $(seq 1 40); do alive "$GAME_PORT" && break; sleep 1; done
alive "$GAME_PORT" || { echo "сервер не поднялся, лог /tmp/oasis-server.log" >&2; exit 1; }
# PID из lsof, а не из $!: setsid может форкнуться, и $! тогда окажется его pid
echo "$(lsof -ti:"$GAME_PORT" | head -1)" > "$SERVER_PID"

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
# Имя проверено 27.10: у зарегистрированного ключа serveo отдаёт
# <имя>.serveousercontent.com (домен совпадает со случайным!),
# поэтому «постоянность» определяется по имени, а не по домену.
if [ "$HOST" = "$SERVEO_SUBDOMAIN.serveousercontent.com" ] ||
   [ "$HOST" = "$SERVEO_SUBDOMAIN.serveo.net" ]; then
  say "serveo: адрес постоянный — имя «$SERVEO_SUBDOMAIN» закреплено за ключом"
  say "        тот же адрес будет и при следующем запуске deploy.sh"
elif [ "$TUNNEL" = "serveo" ]; then
  # имя не совпало: ключ не зарегистрирован (serveo игнорирует имя и даёт
  # <хеш>-<ip>) либо имя заняли — печатаем, как зарегистрировать ключ
  say "serveo: постоянное имя не получилось — адрес $HOST не сохранится"
  say "        регистрация ключа (один раз, вход через Google/GitHub):"
  fp="$(ssh-keygen -lf "$SERVEO_KEY.pub" 2>/dev/null | awk '{print $2}')" || fp=""
  if [ -n "${fp:-}" ]; then
    add="$(printf '%s' "$fp" | sed -e 's/:/%3A/g' -e 's#/#%2F#g' -e 's/+/%2B/g')"
    say "        https://console.serveo.net/ssh/keys?add=$add"
  else
    say "        ключ $SERVEO_KEY не найден: ssh-keygen -t ed25519 -f $SERVEO_KEY -N ''"
  fi
fi
if grep -q 'pinggy' "$SERVER_LOG" 2>/dev/null; then
  say "pinggy: первым игрокам нужно нажать «Enter site» на странице предупреждения"
  say "внимание: адрес туннеля живёт 60 минут, потом — повторный deploy.sh"
fi
say ""
say "остановить: lsof -ti:$GAME_PORT | xargs -r kill -9; pkill -f 'cloudflared tunnel'; pkill -f '[a].pinggy.io'; pkill -f '[s]erveo.net'"
