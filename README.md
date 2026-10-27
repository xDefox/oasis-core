# OASIS Core

> Веб-ядро федеративной платформы виртуальных миров: открытый протокол,
> сервер-авторитет и референсный веб-клиент. По мотивам «Первому игроку
> приготовиться» (*Ready Player One*, 2018).

**Статус:** альфа, фаза 1 (вертикальный срез фазы 0 закрыт 22.10). Команда из
двух человек, всё через PR. Что делаем дальше — `docs/11-work-plan.md`, §4.4.

---

## Быстрый старт

Нужен **Node.js 24+** (проверено на 26). Docker не нужен.

```bash
git clone https://github.com/xDefox/oasis-core.git
cd oasis-core
npm install
npm run dev
```

Клиент — <http://localhost:5173>, сервер слушает `ws://localhost:2567`.

Полный чек-лист онбординга — [`docs/12-quickstart.md`](docs/12-quickstart.md).

## Что внутри

| Пакет | Что делает |
|---|---|
| `packages/protocol` | типы, константы, бинарный кодек, zod-схемы |
| `packages/server` | Colyseus-комната, симуляция, ledger, генератор мира |
| `packages/client` | Three.js (WebGPU/WebGL2), ввод, интерполяция, HUD |

`content/default/world.json` — сгенерированный мир: коммитится в репозиторий,
генерация детерминирована по `seed`.

## Команды

| Команда | Что делает |
|---|---|
| `npm run dev` | сервер + клиент с цветными префиксами |
| `npm run typecheck` | `tsc` по трём пакетам |
| `npm test` | кодек + интеграционный тест на двух клиентах |
| `npm run test:browser` | headless-зонды в Chromium |
| `node scripts/mutation-check.mjs` | мутационная проверка: тест обязан падать без своего фикса |
| `npm run generate:world -w @oasis/server` | перегенерировать мир |

## Документация

| Файл | Про что |
|---|---|
| [00-overview](docs/00-overview.md) | что это, ограничения, границы v1 |
| [01-canon-and-economy](docs/01-canon-and-economy.md) | канон и экономика мира |
| [02-architecture](docs/02-architecture.md) | архитектура |
| [03-web-client](docs/03-web-client.md) | веб-клиент |
| [04-roadmap-and-budget](docs/04-roadmap-and-budget.md) | роадмап и бюджет |
| [05-economy-and-antifraud](docs/05-economy-and-antifraud.md) | экономика и антифрод |
| [06-legal-rf](docs/06-legal-rf.md) | юридические вопросы (юрисдикция РФ) |
| [07-sources](docs/07-sources.md) | источники |
| [08-decisions](docs/08-decisions.md) | принятые решения (ADR) |
| [09-first-world](docs/09-first-world.md) | спецификация первого мира |
| [10-protocol-v0](docs/10-protocol-v0.md) | формат байтов и сообщений |
| [11-work-plan](docs/11-work-plan.md) | правила работы, владение модулями, бэклог |
| [12-quickstart](docs/12-quickstart.md) | онбординг за пять команд |

## Как участвовать

Полные правила — в [`docs/11-work-plan.md`](docs/11-work-plan.md). Коротко:

1. Всё через PR в `main`. Прямой пуш в `main` запрещён настройкой репозитория.
2. Нужен **один approve** от второго человека. Мержит автор PR.
3. Обязательные проверки: `typecheck + tests`, `проверка мира`, `мутации (тесты не врут?)`, `headless-мир`.
4. Правки `packages/protocol` — только с approve второго человека (см. `.github/CODEOWNERS`).
5. Новый тест обязан падать, если убрать его фикс. Проверяется мутацией, а не «на глаз».
6. Размер PR — до 400 строк диффа. Больше — режем на части.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) — три джоба:

| Джоб | Что проверяет | Время |
|---|---|---|
| `static` | typecheck, тесты, проверка мира, сборка клиента | секунды |
| `mutation` | что тесты ловят свой баг | минуты |
| `browser` | реальный мир в headless Chromium | минуты |

Разделение намеренное: если браузерный джоб флапнет, он не должен маскировать
быстрый и честный вердикт `static`.

## Лицензия

Лицензия пока не выбрана — до этого момента действуют права авторов по умолчанию.
Открытый протокол из `packages/protocol` создавался с расчётом на то, что миры
смогут хостить и другие люди.
