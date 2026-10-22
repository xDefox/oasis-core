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
// yaw = 0: W = −Z, S = +Z, D = +X.
await walker.bringToFront();
await delay(400);

const startZone = (await debug(walker)).zone?.id ?? null;
let reachedPortal = false;
for (let step = 0; step < 60; step += 1) {
  const state = await debug(walker);
  // После F0-9 зона одна: признак перехода — смена zone.id, а не zoneGroups≥2.
  if (startZone && state.zone?.id && state.zone.id !== startZone) {
    reachedPortal = true;
    break;
  }

  const dz = PORTAL.z - state.z;
  const keys = ['KeyD'];
  if (dz > 0.8) keys.push('KeyS');
  if (dz < -0.8) keys.push('KeyW');

  await walker.keyboard.down('ShiftLeft');
  await Promise.all(keys.map((key) => walker.keyboard.down(key)));
  await delay(300);
  await Promise.all(keys.map((key) => walker.keyboard.up(key)));
  await walker.keyboard.up('ShiftLeft');
}

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
