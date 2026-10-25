# Публичный доступ без VPS: Cloudflare quick tunnel

Задача F1-10: человек открывает сервер на своём ноуте, остальные заходят как на
сайт — из любой сети, без проброса портов, домена и аккаунта Cloudflare.

## Как это работает

Поднимаются **два** туннеля:

| Что | Локальный порт | Наружу |
| --- | --- | --- |
| клиент (статика) | 8080 | `https://<random>.trycloudflare.com` |
| игровой сервер (Colyseus) | 2567 | `wss://<random>.trycloudflare.com` |

Оба адреса выдаёт Cloudflare при старте (`trycloudflare.com`, без логина).
Адрес сервера нужно **вшить в сборку клиента** до `npm run build`:

```bash
echo "VITE_SERVER_URL=wss://<server-tunnel>.trycloudflare.com" \
  > packages/client/.env.production
npm run build -w @oasis/client
npx --yes serve -s packages/client/dist -l 8080
```

## Грабли на этой машине

`cloudflared` не может зарезолвить `api.trycloudflare.com` — системный
systemd-resolved отдаёт `no such host`, а `/etc/hosts` править нельзя (нет
прав). При этом через `1.1.1.1` имя резолвится нормально.

Обход: запускать `cloudflared` в mount-namespace, подменив `/etc/resolv.conf`
(юзернеймспейсы включены, root не нужен):

```bash
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /tmp/resolv-cf.conf
unshare -rm bash -c \
  'mount --bind /tmp/resolv-cf.conf /etc/resolv.conf && \
   exec cloudflared tunnel --no-autoupdate --edge-ip-version 4 --url http://localhost:PORT'
```

Это завёрнуто в `scripts/tunnel.sh`.

## Запуск

Всё в одну команду:

```bash
scripts/deploy.sh
```

Скрипт делает ровно эту последовательность и печатает ссылку:

1. останавливает старые процессы на 2567/8080, если висят;
2. поднимает сервер и его туннель — ждёт появления `wss://` в логе;
3. пишет `packages/client/.env.production` с этим адресом и собирает клиент
   (проверяет, что адрес реально попал в бандл);
4. поднимает статику и туннель клиента;
5. пишет состояние в `.deploy-state` (адреса, порты), резолвит адрес клиента
   через `1.1.1.1` и делает `curl` → печатает ссылку и HTTP-код.

Порядок важен: адрес `wss` туннеля выдаётся только при старте `cloudflared`,
а вшивается в бандл на этапе сборки — поэтому сервер и его туннель идут
раньше клиента.

Вручную (тот же порядок, если нужно точечно):

```bash
npm run build -w @oasis/client          # с .env.production под нужный wss
npx --yes serve -s packages/client/dist -l 8080 &
node_modules/.bin/tsx packages/server/src/index.ts &   # :2567

scripts/tunnel.sh 8080 /tmp/cf-client.log
scripts/tunnel.sh 2567 /tmp/cf-server.log
grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/cf-*.log
```

Сервер обязан слушать `0.0.0.0` (по умолчанию так, `HOST=0.0.0.0`).
`.deploy-state` — runtime-состояние (адреса меняются при каждом запуске),
в git не входит.

## Ограничения

- URL меняются при каждом перезапуске туннеля — клиент надо пересобирать.
- Туннель живёт, пока жив процесс и ноут; это не постоянный хостинг.
- Quick tunnel без SLA. Для фазы 2 — VPS + named tunnel или свой сервер.
- Проверка снаружи: `curl https://<client>/` → 200,
  WS-хэндшейк на сервер → `101`/открытое соединение.
