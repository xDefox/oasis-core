#!/usr/bin/env bash
# Публичный туннель без аккаунта и без VPS.
#
# Зачем unshare: системный резолвер (systemd-resolved) не резолвит
# api.trycloudflare.com, а /etc/hosts править нельзя. Внутри
# mount-namespace подменяем /etc/resolv.conf на публичные DNS —
# cloudflared резолвит и поднимает quick tunnel.
#
# Использование:
#   scripts/tunnel.sh 8080 /tmp/cf-client.log
#   scripts/tunnel.sh 2567 /tmp/cf-server.log
#
# URL печатается в лог: "https://<random>.trycloudflare.com".
set -euo pipefail

PORT="${1:?порт}"
LOG="${2:-/tmp/cf-$PORT.log}"
CLOUDFLARED="${CLOUDFLARED:-$HOME/.local/bin/cloudflared}"
RESOLV=/tmp/resolv-cf.conf

if [ ! -x "$CLOUDFLARED" ]; then
  echo "нет cloudflared: $CLOUDFLARED" >&2
  exit 1
fi

printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > "$RESOLV"

exec setsid nohup unshare -rm bash -c \
  "mount --bind $RESOLV /etc/resolv.conf && exec $CLOUDFLARED tunnel --no-autoupdate --edge-ip-version 4 --url http://localhost:$PORT" \
  > "$LOG" 2>&1 < /dev/null
