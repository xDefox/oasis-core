/**
 * Зонд мира: две вкладки, настоящая игра.
 *
 * Отвечает на то, что не проверяет ни один unit-тест: клиент открывается,
 * второй игрок виден и двигается, предсказание не разъезжается, скорость
 * не проскакивает, граница зоны держит, камера не проваливается, чат доходит.
 *
 * Запускается раннером (`npm run test:browser`), вручную — так:
 *   node scripts/probes/world.mjs http://localhost:5173
 */

import {
  chat,
  debug,
  delay,
  hasIntermediateSpeed,
  launch,
  newPlayer,
  Problems,
  sampleVelocity,
} from './_probe.mjs';

const problems = new Problems();
const browser = await launch();

const alpha = await newPlayer(browser, 'alpha', problems);
await delay(1200);
const beta = await newPlayer(browser, 'beta', problems);
await delay(2500);

const roster = await debug(alpha);
console.log('состояние alpha:', roster);
if (roster.roster < 2) problems.add('ростер меньше двух: второй игрок не появился в состоянии');
if (roster.zoneGroups < 1) problems.add('зона не загрузилась: сцена пустая');
if (roster.avatars < 2) problems.add('аватары не созданы');

// ── видят друг друга ────────────────────────────────────────────────────
// Проверяем сразу, пока оба стоят рядом: дальше по зонду они расходятся,
// и «не видно» становится правильным результатом, а не ошибкой.
if (roster.visibleOthers < 1) {
  problems.add('первый игрок не видит тело второго, хотя они в одной зоне и рядом');
}

// ── движение своим ходом ────────────────────────────────────────────────
// Headless swiftshader даёт 10–15 fps, а предсказание идёт по реальному
// времени. Поэтому проверяем не «сколько прошёл», а профиль скорости:
// разгон должен быть ПЛАВНЫМ, а остановка — полной.
await alpha.bringToFront();
await delay(600);
const before = await debug(alpha);
await alpha.keyboard.down('KeyW');
const accel = await sampleVelocity(alpha, 1200);
const during = await debug(alpha);
await alpha.keyboard.up('KeyW');
const brake = await sampleVelocity(alpha, 900);
const stopped = await debug(alpha);

const travelled = Math.hypot(during.x - before.x, during.z - before.z);
const speed = Math.hypot(during.vx, during.vz);
console.log(
  `движение: ${travelled.toFixed(2)} м, скорость ${speed.toFixed(2)} м/с, ` +
    `кадров ${during.frames - before.frames}`,
);
console.log('профиль разгона:', accel.map((s) => s.speed).join(' → '));
console.log('профиль торможения:', brake.map((s) => s.speed).join(' → '));

if (during.frames - before.frames < 5) {
  problems.add(`слишком мало кадров для проверки: ${during.frames - before.frames}`);
}
if (travelled < 1) problems.add(`игрок не сдвинулся: ${travelled.toFixed(2)} м`);
// 1.5 с на максимальных 8 м/с — это 12 м; больше означало бы телепорт.
if (travelled > 12.5) problems.add(`игрок быстрее скорости: ${travelled.toFixed(2)} м за 1.5 с`);
if (speed < 4.5) problems.add(`скорость не вышла на целевую — разгон сломан: ${speed.toFixed(2)}`);

// Разгон плавный: скорость проходит через промежуточные значения.
// Мгновенный прыжок 0 → 5 — это «скольжение по льду», баг плейтеста 22.10.
if (!hasIntermediateSpeed(accel)) {
  problems.add(
    `разгон не плавный: скорость прыгнула к цели мимо промежуточных значений ` +
      `(${accel.map((s) => s.speed).join(', ')})`,
  );
}
// Торможение тоже плавное: скорость не должна обнулиться одним кадром.
if (!hasIntermediateSpeed(brake)) {
  problems.add(
    `торможение не плавное: скорость обнулилась скачком ` +
      `(${brake.map((s) => s.speed).join(', ')})`,
  );
}
if (Math.abs(stopped.vx) > 0.001 || Math.abs(stopped.vz) > 0.001) {
  problems.add(`скорость не обнулилась: vx=${stopped.vx} vz=${stopped.vz}`);
}
// Экстраполяция рендера: тело чуть впереди позиции последнего тика.
const ahead = Math.hypot(during.renderX - during.x, during.renderZ - during.z);
console.log(`экстраполяция рендера: ${ahead.toFixed(3)} м впереди тика`);

// ── граница зоны держит ─────────────────────────────────────────────────
// Идём вправо до упора. Но сначала уходим от портала (он в (26, 0) с
// радиусом 3): иначе игрок уйдёт в соседнюю зону, и проверка стены не
// выполнится вовсе.
//
// Проверяем не «дошёл ли до стены x=32», а «всегда ли игрок внутри своей
// зоны»: первая версия теста называла нормальный уход в соседнюю зону
// «выходом за границу» — тест врал, а продукт был прав.
await alpha.bringToFront();
await delay(600);
const atWallStart = await debug(alpha);

// Отходим по z: yaw = 0, значит S = +Z.
await alpha.keyboard.down('KeyS');
await delay(2500);
await alpha.keyboard.up('KeyS');
await delay(600);
const aside = await debug(alpha);
console.log('отошли от портала:', { x: aside.x, z: aside.z, зона: aside.zone?.id });

if (Math.abs(aside.z) < 5) {
  problems.add(`не удалось отойти от портала по z: z=${aside.z} (нужно |z| > 5)`);
}

await alpha.keyboard.down('KeyD');
await delay(8000);
const pressed = await debug(alpha);
await alpha.keyboard.up('KeyD');
console.log('у стены:', {
  старт: { x: atWallStart.x, z: atWallStart.z },
  финиш: { x: pressed.x, z: pressed.z },
  зона: pressed.zone,
});

if (!pressed.zone) {
  problems.add('не удалось определить зону игрока');
} else {
  const { x: cx, z: cz, w, d } = pressed.zone.bounds;
  const eps = 0.5; // запас на дробный шаг предсказания
  if (
    pressed.x < cx - w / 2 - eps ||
    pressed.x > cx + w / 2 + eps ||
    pressed.z < cz - d / 2 - eps ||
    pressed.z > cz + d / 2 + eps
  ) {
    problems.add(
      `игрок вне своей зоны: (${pressed.x}, ${pressed.z}) ` +
        `при границах ${pressed.zone.id} ` +
        `x∈[${cx - w / 2}, ${cx + w / 2}] z∈[${cz - d / 2}, ${cz + d / 2}]`,
    );
  }
  // Упёрся ли он в стену своей зоны, а не прошёл сквозь неё.
  const wallX = pressed.zone.bounds.x + pressed.zone.bounds.w / 2;
  if (pressed.zone.id === 'z_plaza' && pressed.x < wallX - 0.7) {
    problems.add(`игрок не дошёл до стены: x=${pressed.x} (ждём ~${wallX})`);
  }
}

// ── камера ──────────────────────────────────────────────────────────────
if (pressed.cameraDistance < 0.5) problems.add(`камера в игроке: ${pressed.cameraDistance} м`);
if (pressed.cameraDistance > 20) problems.add(`камера улетела: ${pressed.cameraDistance} м`);

// ── чат доходит до второго игрока ───────────────────────────────────────
await alpha.bringToFront();
await alpha.keyboard.press('Enter');
await delay(300);
const chatOpen = await alpha.evaluate(() => !document.getElementById('chat-form')?.hidden);
if (!chatOpen) problems.add('Enter не открыл поле чата');
await alpha.keyboard.type('проверка связи');
await alpha.keyboard.press('Enter');
await delay(1500);

const betaChat = await chat(beta);
console.log('чат у beta:', betaChat.slice(-3));
if (!betaChat.some((line) => line.includes('проверка связи'))) {
  problems.add('сообщение не дошло до второго игрока');
}

// ── второй игрок двигается у себя и это видно первому ───────────────────
await beta.bringToFront();
await delay(600);
const betaBefore = await debug(beta);
await beta.keyboard.down('KeyW');
await delay(1200);
const betaMoved = await debug(beta);
await beta.keyboard.up('KeyW');
const betaTravelled = Math.hypot(betaMoved.x - betaBefore.x, betaMoved.z - betaBefore.z);
console.log(`движение beta: ${betaTravelled.toFixed(2)} м`);
if (betaTravelled < 2) problems.add('второй игрок не двигается');

await delay(1200);
const betaStopped = await debug(beta);
if (Math.abs(betaStopped.vx) > 0.001 || Math.abs(betaStopped.vz) > 0.001) {
  problems.add(`второй игрок не остановился: vx=${betaStopped.vx} vz=${betaStopped.vz}`);
}

await browser.close();
problems.finish();
