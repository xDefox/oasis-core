#!/usr/bin/env bash
# Публичный туннель без аккаунта и без VPS.
#
# Зачем unshare: системный резолвер (systemd-resolved) не резолвит
# api.trycloudflare.com, а /etc/hosts править нельзя. Внутри
# mount-namespace подменяем /etc/resolv.conf на публичные DNS —
# cloudflared резолвит и поднимает quick tunnel.
#
# Вторая беда, выясненная 26.10: у api.trycloudflare.com системный DNS
# отдаёт 185.61.104.70/71, а до этих адресов соединение сбрасывается
# (скорее всего, режется провайдером). Рабочие любые anycast-адреса
# Cloudflare — например 104.16.100.100, на котором API отвечает 200.
# Поэтому в namespace подменяется и /etc/hosts: api → рабочий IP.
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
HOSTS=/tmp/hosts-cf
# IP, на котором api.trycloudflare.com отвечает 200 (проверяется вручную:
# curl --resolve api.trycloudflare.com:443:<ip> https://api.trycloudflare.com/)
API_IP="${CF_API_IP:-104.16.100.100}"

if [ ! -x "$CLOUDFLARED" ]; then
  echo "нет cloudflared: $CLOUDFLARED" >&2
  exit 1
fi

printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > "$RESOLV"
{ cat /etc/hosts; printf '%s api.trycloudflare.com\n' "$API_IP"; } > "$HOSTS"

exec setsid nohup unshare -rm bash -c \
  "mount --bind $RESOLV /etc/resolv.conf && mount --bind $HOSTS /etc/hosts && exec $CLOUDFLARED tunnel --no-autoupdate --edge-ip-version 4 --url http://localhost:$PORT" \
  > "$LOG" 2>&1 < /dev/null
