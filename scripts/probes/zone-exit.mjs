/**
 * Зонд ухода в другой мир: тело должно пропасть, игрок — остаться в реестре.
 *
 * Раньше сервер переставал слать такого игрока, но клиент оставлял его тело
 * на последнем месте — «призрак» с ником торчал в зоне. Теперь тело
 * прячется, как только владелец вышел из зоны или за радиус видимости.
 *
 * Walker идёт пешком до настоящего портала: `__oasisWarp` тут не годится —
 * клиент знает границы только своей зоны и такой хак обрезает по границе.
 *
 * Запускается раннером (`npm run test:browser`), вручную — так:
 *   node scripts/probes/zone-exit.mjs http://localhost:5173
 */

import { debug, delay, launch, newPlayer, Problems } from './_probe.mjs';

const PORTAL = { x: 26, z: 0 };
const problems = new Problems();
const browser = await launch();

const watcher = await newPlayer(browser, 'watcher', problems);
await delay(800);
const walker = await newPlayer(browser, 'walker', problems);
await delay(2500);

await watcher.bringToFront();
await delay(600);
const before = await debug(watcher);
console.log('до ухода:', { roster: before.roster, visibleOthers: before.visibleOthers });

if (before.visibleOthers !== 1) {
  problems.add(`наблюдатель должен видеть 1 тело, видит ${before.visibleOthers}`);
}

// ── ведём walker к порталу, подруливая по фактической позиции ───────────
// yaw = 0: W = −Z, S = +Z, D = +X, A = −X.
//
// С F1-1 пропы реально блокируют: старая схема «всегда вперёд (D) + чинить z»
// заворачивала walker под лавку и там умирал — движение вбок было невозможно,
// а зонд проверял планировку, а не уход из зоны. Теперь подруливаем по обеим
// осям, как в zone-unload: это тот же контроллер, что уже стабильно доносит
// игрока до портала.
await walker.bringToFront();
await delay(400);

// Клавиши держим НЕПРЕРЫВНО и меняем только то, что реально изменилось.
//
// Цикл «всё отпустить → подождать → всё нажать» здесь не работает: спринт
// даёт 8 м/с, а разворот при ускорении 28 м/с² занимает ~0.4 с — дольше
// одного шага в 280 мс. В итоге каждый смена направления давала сетку
// отрицательного прироста: walker «доворачивал» в старую сторону, уезжал
// под лавку и там вставал намертво. С непрерывным вводом скорость
// разворачивается в тике, пока клавиша ещё зажата.
const held = new Set(['ShiftLeft']);
await walker.keyboard.down('ShiftLeft');

async function setKeys(next) {
  for (const key of [...held]) {
    if (key !== 'ShiftLeft' && !next.includes(key)) {
      await walker.keyboard.up(key);
      held.delete(key);
    }
  }
  for (const key of next) {
    if (!held.has(key)) {
      await walker.keyboard.down(key);
      held.add(key);
    }
  }
}

const startZone = (await debug(walker)).zone?.id ?? null;
let reachedPortal = false;
for (let step = 0; step < 60; step += 1) {
  const state = await debug(walker);
  // После F0-9 зона одна: признак перехода — смена zone.id, а не zoneGroups≥2.
  if (startZone && state.zone?.id && state.zone.id !== startZone) {
    reachedPortal = true;
    break;
  }

  const dx = PORTAL.x - state.x;
  const dz = PORTAL.z - state.z;
  const keys = [];
  if (dx > 0.6) keys.push('KeyD');
  if (dx < -0.6) keys.push('KeyA');
  if (dz > 0.6) keys.push('KeyS');
  if (dz < -0.6) keys.push('KeyW');
  if (keys.length === 0) keys.push('KeyD');

  await setKeys(keys);
  await delay(280);
}

await setKeys([]);
await walker.keyboard.up('ShiftLeft');

if (!reachedPortal) {
  const state = await debug(walker);
  problems.add(`walker не дошёл до портала: x=${state.x} z=${state.z}`);
}

await delay(1500);
const walkerAfter = await debug(walker);
console.log('walker ушёл:', { x: walkerAfter.x, z: walkerAfter.z, zoneGroups: walkerAfter.zoneGroups });

await watcher.bringToFront();
await delay(1500);
const after = await debug(watcher);
console.log('после ухода:', {
  roster: after.roster,
  visibleOthers: after.visibleOthers,
  trackedOthers: after.trackedOthers,
});

if (after.visibleOthers !== 0) {
  problems.add(`тело ушедшего игрока осталось видимым: ${after.visibleOthers}`);
}
// Ростер — реестр мира, а не список видимых: игрок всё ещё в мире.
if (after.roster !== 2) {
  problems.add(`ростер должен остаться из двух (он ещё в мире): ${after.roster}`);
}

await watcher.screenshot({ path: '/tmp/oasis-zone-exit.png' }).catch(() => {});

await browser.close();
problems.finish();
