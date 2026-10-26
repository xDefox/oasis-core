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

Здесь **две** разные беды, выясненные по очереди (25.10 и 26.10):

1. `cloudflared` не может зарезолвить `api.trycloudflare.com` — системный
   systemd-resolved отдаёт `no such host`, а `/etc/hosts` править нельзя (нет
   прав). При этом через `1.1.1.1` имя резолвится нормально.
2. Даже когда имя резолвится, системный DNS отдаёт для `api.trycloudflare.com`
   `185.61.104.70/71`, а до этих адресов соединение **сбрасывается/таймаут**
   (режется на уровне сети). Рабочие anycast-адреса Cloudflare отвечают:
   `104.16.100.100`, `172.64.32.1`, `104.20.1.1` → `200`; `162.159.140.220` и
   `172.66.0.218` → `403` (чужой роут на API); `185.61.104.x` → таймаут.

Обход обеих: запускать `cloudflared` в mount-namespace, подменив и
`/etc/resolv.conf`, и `/etc/hosts` (юзернеймспейсы включены, root не нужен):

```bash
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /tmp/resolv-cf.conf
{ cat /etc/hosts; echo '104.16.100.100 api.trycloudflare.com'; } > /tmp/hosts-cf
unshare -rm bash -c \
  'mount --bind /tmp/resolv-cf.conf /etc/resolv.conf && \
   mount --bind /tmp/hosts-cf /etc/hosts && \
   exec cloudflared tunnel --no-autoupdate --edge-ip-version 4 --url http://localhost:PORT'
```

Если API снова перестанет отвечать — IP подбирается вручную:

```bash
for ip in 104.16.100.100 172.64.32.1 104.20.1.1; do
  curl -s -m 8 --resolve api.trycloudflare.com:443:$ip \
    -o /dev/null -w "$ip %{http_code}\n" -X POST https://api.trycloudflare.com/tunnel
done
```

Рабочий IP задаётся переменной `CF_API_IP`, всё это завёрнуто в
`scripts/tunnel.sh`.

## Резерв: pinggy, если Cloudflare недоступен

`api.trycloudflare.com` в какой-то момент может быть закрыт совсем — тогда
`deploy.sh` сам (за 15 секунд) переключается на SSH-туннель pinggy
(`scripts/tunnel-pinggy.sh`, аккаунт не нужен):

- плюс: поднимается из любого места, где открыт SSH на 443;
- минус: **бесплатный туннель скринит браузерные запросы** — страница
  отдаётся, но WebSocket браузеру не проходит (`X-Pinggy-No-Screen` умеют
  только скрипты). То есть играть через pinggy нельзя, работает только
  показ страницы;
- минус: адрес живёт 60 минут.

Поэтому pinggy — аварийный вариант, а не замена. Выбор принудительно:
`TUNNEL=cloudflare scripts/deploy.sh` или `TUNNEL=pinggy scripts/deploy.sh`.

## Проверка, что деплой действительно играется

`curl 200` ничего не доказывает: туннель может отдавать статику, а WebSocket
— молча не проходить (ровно так ломалось). Полная проверка:

```bash
node scripts/deploy-check.mjs        # берёт адреса из .deploy-state
```

Она открывает публичную ссылку в headless-chromium (с `--host-resolver-rules`,
потому что локальный DNS не резолвит `*.trycloudflare.com`), ждёт «в сети»,
поднимает второго игрока и проверяет ростер и видимые тела. Код выхода 0 —
деплой играется.

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
- Проверка снаружи: `curl https://<client>/` → 200, WS-хэндшейк на сервер →
  `101`; окончательно — `node scripts/deploy-check.mjs` (см. выше).
