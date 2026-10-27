/**
 * Зонд восстановления после перезагрузки (F0-8).
 *
 * Самый частый способ потерять место в прототипе: нажать F5. Раньше это
 * выбрасывало игрока на спавн с ником (2). Теперь сессия живёт в
 * sessionStorage вкладки, токен в welcome — сервер возвращает на то же
 * место под тем же ником.
 *
 * Что проверяем:
 *   1. до перезагрузки — на позиции, отличной от спавна;
 *   2. перезагрузка вкладки (reload), дождались входа;
 *   3. welcome с resumed=true, тот же ник, позиция почти та же;
 *   4. второму игроку тело осталось тем же (не появился дубль).
 */

import {
  chat,
  debug,
  delay,
  launch,
  newPlayer,
  Problems,
  startSampling,
  stopSampling,
} from './_probe.mjs';

const problems = new Problems();
const browser = await launch();

const alpha = await newPlayer(browser, 'recon-alpha', problems);
await delay(1200);

// В реальном мире один браузер = один аккаунт, а `localStorage` у вкладок
// общий. В зонде же вкладки — это два игрока: бета перезаписала и ник, и
// `oasis.account`, и без снапшота альфа после F5 пришла бы с чужим
// accountId — сервер справедливо отверг бы токен («токен от другого
// аккаунта»). Снимаем личность альфы до появления беты.
const alphaIdentity = await alpha.evaluate(() => ({
  name: localStorage.getItem('oasis.name'),
  account: localStorage.getItem('oasis.account'),
}));

const beta = await newPlayer(browser, 'recon-beta', problems);
await delay(2500);

await alpha.bringToFront();
await delay(600);
const before = await debug(alpha);
console.log('до перезагрузки:', { x: before.x, z: before.z, name: before.selfName, roster: before.roster });

if (before.roster < 2) problems.add('ростер меньше двух до перезагрузки');

// Уходим со спавна, чтобы можно было отличить «вернулся» от «заспавнился
// заново». Ввод в headless уходит в никуда, пока вкладка не в фокусе:
// Input.ts чистит клавиши на `blur` window. Поэтому ходим с проверкой
// фокуса и повтором, а не разом — один «немой» проход ронял весь зонд.
await startSampling(alpha);
let moved = await debug(alpha);
let travelled = 0;
for (let attempt = 1; attempt <= 3 && travelled < 0.4; attempt += 1) {
  await alpha.bringToFront();
  await delay(300);
  const focused = await alpha.evaluate(() => document.hasFocus());
  await alpha.keyboard.down('KeyD');
  await delay(900);
  await alpha.keyboard.up('KeyD');
  await delay(500);
  moved = await debug(alpha);
  travelled = Math.hypot(moved.x - before.x, moved.z - before.z);
  console.log(
    `ходьба #${attempt}: фокус=${focused} frames=${moved.frames} → ` +
      `${travelled.toFixed(2)} м, поз(${moved.x.toFixed(2)}, ${moved.z.toFixed(2)})`,
  );
}
if (travelled < 0.4) problems.add(`не отошёл от спавна для проверки: ${travelled.toFixed(2)} м`);

/**
 * Ждём, пока игрок реально остановится.
 *
 * После отпускания клавиши тело ещё скользит с инерцией (замедление — это
 * та же общая `stepVelocity`). Если снять «точку пропадания» во время
 * скольжения, сервер докатится уже после снимка — и проверка отката
 * посчитает разницу между двумя точками одного скольжения, а не обрыв.
 */
async function waitStable(targetPage, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let current = await debug(targetPage);
  let steady = 0;
  while (Date.now() < deadline && steady < 3) {
    await delay(250);
    const next = await debug(targetPage);
    steady = Math.hypot(next.x - current.x, next.z - current.z) < 0.02 ? steady + 1 : 0;
    current = next;
  }
  return current;
}

const at = await waitStable(alpha);
console.log(`остановился: поз(${at.x.toFixed(2)}, ${at.z.toFixed(2)})`);

// Позиция до обрыва нужна серверная: клиент держит своё предсказание и в
// пределах SOFT_TOLERANCE (1 м) к серверу не подтягивается — мерять откат
// по клиенту значит мерять не место, где игрока держали, а разницу
// предсказания и авторитета.
const compareBefore = await alpha.evaluate(() => window.__oasisCompare?.() ?? null);
console.log('сверка клиент/сервер до перезагрузки:', compareBefore);
const atX = compareBefore?.serverX ?? at.x;
const atZ = compareBefore?.serverZ ?? at.z;

// ── перезагрузка ────────────────────────────────────────────────────────
// Восстанавливаем личность альфы (см. снапшот выше): ник и аккаунт в
// `localStorage` на момент перезагрузки принадлежат бете.
await alpha.evaluate((identity) => {
  if (identity.name) localStorage.setItem('oasis.name', identity.name);
  if (identity.account) localStorage.setItem('oasis.account', identity.account);
}, alphaIdentity);
// Последний снимок сервера непосредственно перед обрывом: именно его точку
// обязан вернуть сервер. Меряем серверную, а не клиентскую координату — у
// предсказания свой допуск (SOFT_TOLERANCE 1 м), и откат по клиенту
// показывал бы ложное расхождение в 1–1.2 м.
const compareDrop = await alpha.evaluate(() => window.__oasisCompare?.() ?? null);
console.log('сверка клиент/сервер перед обрывом:', compareDrop);
const dropX = compareDrop?.serverX ?? atX;
const dropZ = compareDrop?.serverZ ?? atZ;

console.log('перезагружаем вкладку...');
await alpha.reload({ waitUntil: 'load' });
await alpha.waitForFunction(
  () => document.getElementById('status-text')?.textContent === 'в сети',
  { timeout: 30_000 },
);
await alpha.waitForFunction(() => window.__oasisDebug !== undefined, { timeout: 10_000 });
await alpha.bringToFront();
await delay(1500);

const after = await debug(alpha);
console.log('после перезагрузки:', {
  x: after.x,
  z: after.z,
  name: after.selfName,
  roster: after.roster,
});

const compareAfter = await alpha.evaluate(() => window.__oasisCompare?.() ?? null);
console.log('сверка клиент/сервер после перезагрузки:', compareAfter);

if (after.selfName !== 'recon-alpha') {
  problems.add(`ник сменился после перезагрузки: ${after.selfName}`);
}
const drift = Math.hypot(after.x - dropX, after.z - dropZ);
console.log(`откат позиции (сервер до обрыва → сейчас): ${drift.toFixed(2)} м`);
if (drift > 0.6) {
  problems.add(`после перезагрузки позиция далеко от того места, где пропал: ${drift.toFixed(2)} м`);
}
// Ростер сравниваем не по числу, а по составу: в зонде перед альфой ещё
// висят гости из прошлых прогонов, и их grace-окно истекает по ходу
// проверки — число меняется, а состав (альфа + бета) обязан остаться.
const namesAfter = (after.rosterPlayers ?? []).map((p) => p.name);
for (const expected of ['recon-alpha', 'recon-beta']) {
  if (!namesAfter.includes(expected)) {
    problems.add(`после перезагрузки в ростере нет ${expected}: [${namesAfter.join(', ')}]`);
  }
}

// Бета не должна видеть дубль альфы: её тело ровно одно. Считаем по нику,
// а не по числу чужих тел — рядом ещё гости из прошлых прогонов, и они
// чужие тела, но не дубли.
const betaView = await debug(beta);
console.log('beta видит:', { roster: betaView.roster, avatars: betaView.avatars, trackedOthers: betaView.trackedOthers });
if (betaView.roster < 2) problems.add('beta не видит альфу после её перезагрузки');
const alphaCount = (betaView.rosterPlayers ?? []).filter((p) => p.name === 'recon-alpha').length;
if (alphaCount !== 1) {
  problems.add(`у беты в ростере тел альфы: ${alphaCount} (нужно ровно 1)`);
}

// В чате должно быть сообщение о восстановлении, а не «добро пожаловать».
const lines = await chat(alpha);
console.log('чат alpha после перезагрузки:', lines.slice(-4));
if (lines.some((l) => l.includes('добро пожаловать'))) {
  problems.add('после возврата показали «добро пожаловать» — значит заспавнились заново, а не вернулись');
}
if (!lines.some((l) => l.includes('снова'))) {
  problems.add('клиент не сообщил о восстановлении связи');
}

await alpha.screenshot({ path: '/tmp/oasis-reconnect.png' });
await browser.close();
problems.finish();
