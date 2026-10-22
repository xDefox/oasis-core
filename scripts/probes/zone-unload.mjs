/**
 * F0-9: зоны не копятся в памяти клиента.
 *
 * Раньше каждая смена зоны добавляла геометрию в сцену и не снимала старую.
 * После нескольких порталов в памяти висели все посещённые зоны.
 *
 * Мутация: убрать `unloadZonesExcept(...)` из onTeleport/onZone — этот зонд
 * упадёт на `zoneGroups > 1` после второго перехода.
 *
 *   node scripts/probes/zone-unload.mjs http://localhost:5173
 */

import { debug, delay, launch, newPlayer, Problems } from './_probe.mjs';

/** Портал plaza → grove (см. content/default/world.json). */
const PORTAL_TO_GROVE = { x: 26, z: 0 };
/** Обратный портал grove → plaza. */
const PORTAL_BACK = { x: 92, z: 0 };

const problems = new Problems();
const browser = await launch();

const page = await newPlayer(browser, 'unloader', problems);
await delay(2000);

async function walkTo(target, untilZoneId = null) {
  for (let step = 0; step < 80; step += 1) {
    const state = await debug(page);
    if (untilZoneId && state.zone?.id === untilZoneId) return state;
    if (!untilZoneId) {
      const dist = Math.hypot(target.x - state.x, target.z - state.z);
      if (dist < 2.5) return state;
    }

    const dx = target.x - state.x;
    const dz = target.z - state.z;
    // yaw=0: W=−Z, S=+Z, D=+X, A=−X
    const keys = [];
    if (dx > 0.6) keys.push('KeyD');
    if (dx < -0.6) keys.push('KeyA');
    if (dz > 0.6) keys.push('KeyS');
    if (dz < -0.6) keys.push('KeyW');
    if (keys.length === 0) keys.push('KeyD');

    await page.keyboard.down('ShiftLeft');
    await Promise.all(keys.map((key) => page.keyboard.down(key)));
    await delay(280);
    await Promise.all(keys.map((key) => page.keyboard.up(key)));
    await page.keyboard.up('ShiftLeft');
  }
  return debug(page);
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

await walkTo(PORTAL_TO_GROVE, 'z_grove');
await delay(800);
const mid = await debug(page);
console.log('после 1-го портала:', {
  zone: mid.zone?.id,
  zoneGroups: mid.zoneGroups,
  loadedZones: mid.loadedZones,
  x: mid.x,
  z: mid.z,
});

if (mid.zone?.id === startZone) {
  problems.add(`не сменили зону после портала: всё ещё ${mid.zone?.id}`);
}
if (mid.zoneGroups !== 1) {
  problems.add(
    `после 1-го портала зоны копятся: zoneGroups=${mid.zoneGroups} ` +
      `(loaded=${(mid.loadedZones ?? []).join(',')}) — нужен unload`,
  );
}

await walkTo(PORTAL_BACK, startZone);
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
    `после 2-го портала зоны копятся: zoneGroups=${end.zoneGroups} ` +
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
