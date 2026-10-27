#!/usr/bin/env bash
# Резервный туннель: pinggy.io (SSH-обратный туннель, без аккаунта).
#
# Зачем: на этой машине api.trycloudflare.com отдаёт connection reset —
# quick-tunnel Cloudflare не поднимается вообще. pinggy доступен по SSH
# на 443-й порт и отдаёт HTTPS-адрес сразу.
#
# Ограничение бесплатного туннеля: адрес живёт 60 минут, потом его надо
# поднять заново. Постоянный адрес — это F1-17: scripts/tunnel-serveo.sh
# (имя резервируется за SSH-ключом и не меняется между запусками).
#
# Использование:
#   scripts/tunnel-pinggy.sh 8080 /tmp/pg-client.log
#   scripts/tunnel-pinggy.sh 2567 /tmp/pg-server.log
set -euo pipefail

PORT="${1:?порт}"
LOG="${2:-/tmp/pinggy-$PORT.log}"

: > "$LOG"
# -Rt:80:localhost:PORT — формат pinggy (порт туннеля + внутренний адрес).
# URL печатается сессией в лог: https://<random>-<ip>.free.pinggy.net
exec setsid nohup ssh -p 443 \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR \
  -o ServerAliveInterval=30 \
  -o ExitOnForwardFailure=yes \
  -o ConnectTimeout=15 \
  -Rt:80:localhost:$PORT a.pinggy.io > "$LOG" 2>&1 < /dev/null
