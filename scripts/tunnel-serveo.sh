#!/usr/bin/env bash
# Постоянный туннель: serveo.net (SSH-обратный туннель, F1-17).
#
# Зачем: у бесплатного pinggy адрес каждый раз новый и живёт 60 минут,
# ngrok не пускает агента с нашего IP (ERR_NGROK_9040), localtunnel отдаёт
# 408/таймауты. serveo резервирует имя за SSH-ключом и отдаёт
# https://<имя>.serveo.net — адрес не меняется между запусками.
#
# Регистрация ключа — один раз, вход через Google/GitHub:
#   ssh-keygen -lf ~/.ssh/serveo_key.pub
#   открыть https://console.serveo.net/ssh/keys?add=<fingerprint>
# Без регистрации serveo выдаёт случайный <хеш>-<ip>.serveousercontent.com
# и пишет в лог ссылку на регистрацию (deploy.sh печатает её отдельно).
#
# Использование:
#   scripts/tunnel-serveo.sh 2567 /tmp/serveo.log [имя]
#   SERVEO_SUBDOMAIN=oasis scripts/tunnel-serveo.sh 2567 /tmp/serveo.log
set -euo pipefail

PORT="${1:?порт}"
LOG="${2:-/tmp/serveo-$PORT.log}"
NAME="${3:-${SERVEO_SUBDOMAIN:-oasis-play}}"
KEY="${SERVEO_KEY:-$HOME/.ssh/serveo_key}"

if [ ! -f "$KEY" ]; then
  echo "нет SSH-ключа $KEY — сгенерируйте: ssh-keygen -t ed25519 -f $KEY -N ''" >&2
  exit 1
fi

: > "$LOG"
# -R <имя>:80:localhost:PORT — serveo держит имя за ключом, URL печатает
# сессия в лог: https://<имя>.serveo.net (или случайный без регистрации).
exec setsid nohup ssh -i "$KEY" -p 443 \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR \
  -o ServerAliveInterval=30 \
  -o ExitOnForwardFailure=yes \
  -o ConnectTimeout=15 \
  -R "$NAME:80:localhost:$PORT" serveo.net > "$LOG" 2>&1 < /dev/null
