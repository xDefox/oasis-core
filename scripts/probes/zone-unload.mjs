/**
 * F0-9: зоны не копятся в памяти клиента.
 *
 * Раньше каждая смена зоны добавляла геометрию в сцену и не снимала старую.
 * После нескольких порталов в памяти висели все посещённые зоны.
 *
 * Мутация: убрать `unloadZonesExcept(...)` из onTeleport/onZone — этот зонд
 * упадёт на `zoneGroups > 1` после второго перехода.
 *
 * Смена зоны — тестовым хуком `POST /debug/move`, а не пешим маршрутом до
 * портала. Та же причина, что в `zone-exit.mjs`: зонд отвечает на вопрос
 * «старая зона выгружена?», а не «можно ли пройти от спавна до портала».
 * Пеший маршрут умирал на каждом обновлении мира: на пути пропы
 * (F1-16 — колонна `col0` стоит прямо в центре портала, лавки в плазе),
 * а спавн ещё и случайный на кольце, так что результат зависел от удачи.
 * Клиентский путь при этом не отличается: и портал, и хук шлют одно
 * `S2C.Teleport`, клиент выгружает зону в `onTeleport`.
 *
 * Запускается раннером (`npm run test:browser`), вручную — так:
 *   node scripts/probes/zone-unload.mjs http://localhost:5173
 */

import { debug, delay, launch, newPlayer, Problems } from './_probe.mjs';

/** Откуда зонд зовёт тестовый хук: тот же сервер, что и игра. */
const SERVER =
  process.env.OASIS_SERVER_URL ?? `http://localhost:${process.env.OASIS_SERVER_PORT ?? 2567}`;

const problems = new Problems();
const browser = await launch();

const page = await newPlayer(browser, 'unloader', problems);
await delay(2000);

/**
 * Перенос в другую зону через хук и ожидание, пока клиент применит
 * `S2C.Teleport`. Возвращает id целевой зоны или null, если хук не ответил.
 */
async function hop() {
  const move = await fetch(`${SERVER}/debug/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'unloader' }),
  })
    .then(async (response) => ({ status: response.status, body: await response.json() }))
    .catch((error) => ({ status: 0, body: { ok: false, error: String(error) } }));

  console.log('перенос:', move.body);
  if (!move.body?.ok) {
    problems.add(
      `сервер не перенёс игрока (HTTP ${move.status}): ${move.body?.error ?? 'нет ответа'}`,
    );
    return null;
  }

  const destination = move.body.to;
  const applied = await page
    .waitForFunction(
      (zoneId) => window.__oasisDebug().zone?.id === zoneId,
      { timeout: 30_000, polling: 200 },
      destination,
    )
    .then(() => true)
    .catch(() => false);

  if (!applied) {
    const state = await debug(page);
    problems.add(`клиент не перешёл в зону ${destination}: осталась ${state.zone?.id}`);
  }
  return destination;
}

const before = await debug(page);
console.log('старт:', {
  zone: before.zone?.id,
  zoneGroups: before.zoneGroups,
  loadedZones: before.loadedZones,
});
if (before.zoneGroups !== 1) {
  problems.add(`на старте должна быть ровно 1 зона, есть ${before.zoneGroups}`);
}
const startZone = before.zone?.id;
if (!startZone) problems.add('зона на старте неизвестна');

// ── первый переход ──────────────────────────────────────────────────────
const midZone = await hop();
await delay(800);
const mid = await debug(page);
console.log('после 1-го перехода:', {
  zone: mid.zone?.id,
  zoneGroups: mid.zoneGroups,
  loadedZones: mid.loadedZones,
  x: mid.x,
  z: mid.z,
});

if (mid.zone?.id === startZone) {
  problems.add(`не сменили зону после перехода: всё ещё ${mid.zone?.id}`);
}
if (midZone && mid.zone?.id !== midZone) {
  problems.add(`зона после перехода ${mid.zone?.id}, а сервер вёл в ${midZone}`);
}
if (mid.zoneGroups !== 1) {
  problems.add(
    `после 1-го перехода зоны копятся: zoneGroups=${mid.zoneGroups} ` +
      `(loaded=${(mid.loadedZones ?? []).join(',')}) — нужен unload`,
  );
}

// ── возврат: сервер снова ведёт в первую зону, отличную от текущей ───────
await hop();
await delay(800);
const end = await debug(page);
console.log('после возврата:', {
  zone: end.zone?.id,
  zoneGroups: end.zoneGroups,
  loadedZones: end.loadedZones,
  x: end.x,
  z: end.z,
});

if (end.zone?.id !== startZone) {
  problems.add(`не вернулись в ${startZone}, сейчас ${end.zone?.id}`);
}
if (end.zoneGroups !== 1) {
  problems.add(
    `после 2-го перехода зоны копятся: zoneGroups=${end.zoneGroups} ` +
      `(loaded=${(end.loadedZones ?? []).join(',')}) — нужен unload`,
  );
}

// Без выгрузки после двух переходов обычно ≥2; с выгрузкой всегда 1.
if (end.zoneGroups > 1 || mid.zoneGroups > 1) {
  problems.add('F0-9 регрессия: посещённые зоны остались в сцене');
}

await page.screenshot({ path: '/tmp/oasis-zone-unload.png' }).catch(() => {});
await browser.close();
problems.finish();
