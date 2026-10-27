/**
 * Зонд ухода в другой мир: тело должно пропасть, игрок — остаться в реестре.
 *
 * Раньше сервер переставал слать такого игрока, но клиент оставлял его тело
 * на последнем месте — «призрак» с ником торчал в зоне. Теперь тело
 * прячется, как только владелец вышел из зоны или за радиус видимости.
 *
 * Как уводим: тестовым хуком сервера `POST /debug/move` (нужен флаг
 * `OASIS_TEST_HOOKS`, раннер его включает), а не пешим маршрутом до портала.
 * Это осознанный выбор: зонд отвечает на вопрос «что происходит, когда игрок
 * вышел из зоны», а не «можно ли пройти от спавна до портала». Второй вопрос
 * умирал на каждом обновлении мира — маршрут был зашит координатами пропов,
 * а пропы меняются (F1-16), и чек падал бы на живом коде.
 *
 * Клиентский `__oasisWarp` не годится вместо хука: он двигает только локальное
 * предсказание и обрезается по границе своей зоны, сервер о переносе не
 * узнаёт и сверкой возвращает игрока обратно.
 *
 * Запускается раннером (`npm run test:browser`), вручную — так:
 *   node scripts/probes/zone-exit.mjs http://localhost:5173
 */

import { debug, delay, launch, newPlayer, Problems } from './_probe.mjs';

/** Откуда зонд зовёт тестовый хук: тот же сервер, что и игра. */
const SERVER =
  process.env.OASIS_SERVER_URL ?? `http://localhost:${process.env.OASIS_SERVER_PORT ?? 2567}`;

const problems = new Problems();
const browser = await launch();

const watcher = await newPlayer(browser, 'watcher', problems);
await delay(800);
const walker = await newPlayer(browser, 'walker', problems);
await delay(2500);

await watcher.bringToFront();

// Ждём ПОЯВЛЕНИЕ тела, а не спим фиксированное время.
//
// Однократный замер через 600 мс на быстрой машине видит тело, а в CI при
// 3–15 fps там бывает непрокрученный кадр — зонд падал на живом коде
// («наблюдатель должен видеть 1 тело, видит 0»). Тот же приём, что
// `waitForTicks`: меряем состояние, а не часы.
const sawWalker = await watcher
  .waitForFunction(() => window.__oasisDebug().visibleOthers >= 1, {
    timeout: 30_000,
    polling: 200,
  })
  .then(() => true)
  .catch(() => false);

const before = await debug(watcher);
console.log('до ухода:', { roster: before.roster, visibleOthers: before.visibleOthers });

if (!sawWalker) {
  problems.add(`наблюдатель должен видеть 1 тело, видит ${before.visibleOthers}`);
}

// ── просим сервер увести игрока в другую зону ─────────────────────────────
//
// Зона выбирается сервером (первая, отличная от текущей), точка — центр её
// bounds: зонд не знает про пропы и маршруты вообще. Роут без флага
// OASIS_TEST_HOOKS не существует, поэтому прод-сервер на этот запрос молча
// отдаст 404 — и зонд честно об этом скажет.
const move = await fetch(`${SERVER}/debug/move`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'walker' }),
})
  .then(async (response) => ({ status: response.status, body: await response.json() }))
  .catch((error) => ({ status: 0, body: { ok: false, error: String(error) } }));

console.log('перенос:', move.body);

if (!move.body?.ok) {
  problems.add(
    `сервер не перенёс игрока (HTTP ${move.status}): ${move.body?.error ?? 'нет ответа'}`,
  );
}

// Клиент должен применить S2C.Teleport: своя зона у walker'а меняется на
// целевую. Без этого игрок мысленно остался бы в старом мире, а тело у
// наблюдателя пропало бы по одной лишь серверной причине — проверка была бы
// наполовину слепой.
const destination = move.body?.to;
if (destination) {
  const applied = await walker
    .waitForFunction(
      (zoneId) => window.__oasisDebug().zone?.id === zoneId,
      { timeout: 30_000, polling: 200 },
      destination,
    )
    .then(() => true)
    .catch(() => false);

  if (!applied) {
    const state = await debug(walker);
    problems.add(`клиент walker не перешёл в зону ${destination}: осталась ${state.zone?.id}`);
  }
}

// То же по телу: не «в момент замера», а «в итоге обязано пропасть».
// На медленной машине кадр с ушедшим игроком ещё может доживать, когда
// часы уже кончились, — это не баг, а опоздание рендера. Страница watcher'а
// была в фоне, пока мы зовём хук: сначала возвращаем фокус, иначе рендер в
// фоновой вкладке троттлится и ждать придётся до таймаута.
await watcher.bringToFront();

const bodyGone = await watcher
  .waitForFunction(() => window.__oasisDebug().visibleOthers === 0, {
    timeout: 30_000,
    polling: 200,
  })
  .then(() => true)
  .catch(() => false);

const after = await debug(watcher);
const walkerAfter = await debug(walker);
console.log('после ухода:', {
  roster: after.roster,
  visibleOthers: after.visibleOthers,
  trackedOthers: after.trackedOthers,
});
console.log('walker ушёл:', { zone: walkerAfter.zone?.id, roster: walkerAfter.roster });

if (!bodyGone) {
  problems.add(`тело ушедшего игрока осталось видимым: ${after.visibleOthers}`);
}

// Ростер — реестр мира, а не список видимых: оба игрока обязаны остаться
// в нём, хотя walker ушёл в другую зону.
//
// Своих ищем по именам, а не по точному счётчику. В реестре висят чужие
// сессии в grace-окне F0-8 от предыдущих зондов (30 с), и их срок истекает
// ровно во время проверки: ростер падает с 3 до 2 прямо под замером, и чек
// падал на живом коде. Инвариант теста — состав, а не размер.
for (const side of [
  {
    label: 'наблюдателя',
    self: after.selfName,
    other: walkerAfter.selfName,
    roster: after.rosterPlayers,
  },
  {
    label: 'ушедшего',
    self: walkerAfter.selfName,
    other: after.selfName,
    roster: walkerAfter.rosterPlayers,
  },
]) {
  const names = (side.roster ?? []).map((player) => player.name);
  const missing = [side.self, side.other].filter((name) => name && !names.includes(name));
  if (missing.length > 0) {
    problems.add(
      `у ${side.label} в ростере нет обоих игроков (нет: ${missing.join(', ')}; ` +
        `есть: ${names.join(', ') || '—'})`,
    );
  }
}

await watcher.screenshot({ path: '/tmp/oasis-zone-exit.png' }).catch(() => {});

await browser.close();
problems.finish();
