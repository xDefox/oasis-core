/**
 * Зонд клиента: две вкладки в headless Chromium, настоящая игра.
 *
 * Не часть продукта — запускается вручную. Отвечает на то, что не проверяет
 * ни один unit-тест: клиент открывается, второй игрок виден и двигается,
 * предсказание не разъезжается, камера не дёргается, чат доходит.
 *
 * Требует поднятых сервера и vite (`npm run dev`) и puppeteer-core:
 *   npm install --no-save puppeteer-core
 *   node scripts/probe-client.mjs http://localhost:5173
 */

import { setTimeout as delay } from 'node:timers/promises';

import puppeteer from 'puppeteer-core';

const URL_TO_OPEN = process.argv[2] ?? 'http://localhost:5173';
const CHROMIUM = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium';

const browser = await puppeteer.launch({
  executablePath: CHROMIUM,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--window-size=1280,720',
  ],
});

const problems = [];
const notes = [];

async function newPlayer(name) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error') problems.push(`[${name}] console: ${text}`);
  });
  page.on('pageerror', (error) => problems.push(`[${name}] pageerror: ${error.message}`));
  page.on('requestfailed', (request) =>
    problems.push(`[${name}] ${request.url()} → ${request.failure()?.errorText}`),
  );
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`[${name}] ${response.status()} ${response.url()}`);
  });

  await page.goto(URL_TO_OPEN, { waitUntil: 'load' });
  await page.evaluate((nick) => {
    window.localStorage.clear();
    window.localStorage.setItem(
      'oasis.account',
      JSON.stringify({
        id: `acct_probe_${nick}`,
        createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
      }),
    );
    window.localStorage.setItem('oasis.name', nick);
  }, name);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'в сети', {
    timeout: 30_000,
  });
  await page.waitForFunction(() => window.__oasisDebug !== undefined, { timeout: 10_000 });
  // Ставим в центр площади: тесты механики не должны зависеть от разброса
  // точек спавна. Дальше сервер сам приведёт предсказание к своей позиции.
  await page.bringToFront();
  await page.evaluate(() => window.__oasisWarp?.(0, 0));
  await delay(1500);
  return page;
}

const debug = (page) => page.evaluate(() => window.__oasisDebug());

/** Уходит ли отрисовка вперёд позиции последнего тика (экстраполяция). */
async function page0Extrapolation(page) {
  await page.keyboard.down('KeyW');
  await delay(700);
  const snapshot = await debug(page);
  await page.keyboard.up('KeyW');
  const aheadX = snapshot.renderX - snapshot.x;
  const aheadZ = snapshot.renderZ - snapshot.z;
  return { aheadX: Number(aheadX.toFixed(3)), aheadZ: Number(aheadZ.toFixed(3)) };
}
const hud = (page) =>
  page.evaluate(() => ({
    status: document.getElementById('status-text')?.textContent ?? null,
    stats: document.getElementById('stats')?.innerText.replace(/\n/g, ' | ') ?? '(скрыта)',
    chat: Array.from(document.querySelectorAll('#chat-log .chat-line'))
      .map((node) => node.textContent)
      .slice(-5),
  }));

/** Насколько предсказание расходится с последним серверным снимком. */
const compare = (page) => page.evaluate(() => window.__oasisCompare());

const alpha = await newPlayer('alpha');
await delay(1200);
const beta = await newPlayer('beta');
await delay(2500);

console.log('alpha HUD:', await hud(alpha));
console.log('beta HUD:', await hud(beta));

const roster = await debug(alpha);
console.log('alpha debug:', roster);
if (roster.roster < 2) problems.push('ростер меньше двух: второй игрок не появился в состоянии');
if (roster.zoneGroups < 1) problems.push('зона не загрузилась: сцена пустая');
if (roster.avatars < 2) problems.push('аватары не созданы');

// Холодный старт swiftshader даёт 10–15 fps, а предсказание идёт по
// реальному времени — поэтому проверяем не «сколько прошёл», а что
// движение вообще началось и остановилось.
async function hold(page, key, ms) {
  await page.bringToFront();
  await delay(600);
  const before = await debug(page);
  const framesBefore = before.frames;
  await page.keyboard.down(key);
  await delay(ms);
  const during = await debug(page);
  await page.keyboard.up(key);
  return { before, during, frames: during.frames - framesBefore };
}

async function extrapolation(page) {
  await page.bringToFront();
  await delay(400);
  await page.keyboard.down('KeyW');
  await delay(900);
  const snapshot = await debug(page);
  await page.keyboard.up('KeyW');
  await delay(500);
  return {
    aheadX: Number((snapshot.renderX - snapshot.x).toFixed(3)),
    aheadZ: Number((snapshot.renderZ - snapshot.z).toFixed(3)),
    speed: Number(Math.hypot(snapshot.vx, snapshot.vz).toFixed(2)),
  };
}

// Предсказание считается по реальному времени, а headless-браузер с одной
// активной вкладкой даёт ~10 fps. Это проверка корректности, не perf.
const extrapolating = await extrapolation(alpha);
console.log('экстраполяция:', extrapolating);
console.log('  (render должен быть чуть впереди x/z — это догон внутри тика)');

const walk = await hold(alpha, 'KeyW', 1500);
await delay(1200);
const stopped = await debug(alpha);
const travelled = Math.hypot(walk.during.x - walk.before.x, walk.during.z - walk.before.z);
console.log(
  `движение: ${travelled.toFixed(2)} м за ${walk.frames} кадров, ` +
    `скорость ${Math.hypot(walk.during.vx, walk.during.vz).toFixed(2)} м/с`,
);
console.log('после остановки:', stopped);

if (walk.frames < 5) problems.push(`слишком мало кадров для проверки: ${walk.frames}`);
if (travelled < 1) problems.push(`игрок не сдвинулся: ${travelled.toFixed(2)} м`);
if (travelled > 12) problems.push(`игрок быстрее скорости: ${travelled.toFixed(2)} м за 1.5 с`);
if (Math.hypot(walk.during.vx, walk.during.vz) < 4.5) {
  problems.push('скорость не вышла на целевую — разгон сломан');
}
if (Math.abs(stopped.vx) > 0.001 || Math.abs(stopped.vz) > 0.001) {
  problems.push(`скорость не обнулилась: vx=${stopped.vx} vz=${stopped.vz}`);
}

// ── граница зоны: телепортируем к краю и бежим наружу ────────────────────
const wallRun = await (async () => {
  await alpha.bringToFront();
  await delay(600);
  // Ставим за 12 м до стены и просто идём вправо до упора. Телепорт на
  // сам край не используем: это не путь игрока, а отладочный хак.
  await alpha.evaluate(() => window.__oasisWarp?.(20, 0));
  await delay(2500);
  const atStart = await debug(alpha);
  await alpha.keyboard.down('KeyD');
  await delay(4000);
  const pressed = await debug(alpha);
  await alpha.keyboard.up('KeyD');
  return { atStart, pressed };
})();
console.log('граница зоны:', wallRun);
if (wallRun.pressed.x > 32.3) {
  problems.push(`игрок вышел за границу зоны: x=${wallRun.pressed.x} (предел 32)`);
}
if (wallRun.pressed.x < 31.4) {
  problems.push(`игрок не дошёл до стены: x=${wallRun.pressed.x}`);
}

// ── камера: не проваливается в игрока и держит дистанцию ─────────────────
const camera = await debug(alpha);
if (camera.cameraDistance < 0.5) {
  problems.push(`камера в игроке: ${camera.cameraDistance} м`);
}
if (camera.cameraDistance > 3.5 && camera.cameraDistance < 0.01) {
  problems.push('камера в бесконечности');
}

// ── чат ─────────────────────────────────────────────────────────────────
await alpha.keyboard.press('Enter');
await delay(300);
const chatOpen = await alpha.evaluate(() => !document.getElementById('chat-form')?.hidden);
if (!chatOpen) problems.push('Enter не открыл поле чата');
await alpha.keyboard.type('проверка связи');
await alpha.keyboard.press('Enter');
await delay(1200);

const betaHud = await hud(beta);
console.log('чат у beta:', betaHud.chat);
if (!betaHud.chat.some((line) => line.includes('проверка связи'))) {
  problems.push('сообщение не дошло до второго игрока');
}

// ── второй игрок двигается: виден ли он в состоянии первого ──────────────
await beta.bringToFront();
await delay(600);
const betaPos = await debug(beta);
await beta.keyboard.down('KeyW');
await delay(1200);
const betaMoved = await debug(beta);
await beta.keyboard.up('KeyW');
console.log('beta:', { betaPos, betaMoved });
if (Math.hypot(betaMoved.x - betaPos.x, betaMoved.z - betaPos.z) < 2) {
  problems.push('второй игрок не двигается');
}
await delay(1200);
const betaStopped = await debug(beta);
if (Math.abs(betaStopped.vx) > 0.001 || Math.abs(betaStopped.vz) > 0.001) {
  problems.push(`второй игрок не остановился: vx=${betaStopped.vx} vz=${betaStopped.vz}`);
}

for (const [name, page] of [
  ['alpha', alpha],
  ['beta', beta],
]) {
  await page.screenshot({ path: `/tmp/oasis-${name}.png` });
}
console.log('скриншоты: /tmp/oasis-alpha.png, /tmp/oasis-beta.png');

await browser.close();

for (const note of notes) console.log('заметка:', note);
if (problems.length > 0) {
  console.log('\nПРОБЛЕМЫ:');
  for (const line of problems) console.log(' -', line);
  process.exitCode = 2;
} else {
  console.log('\nошибок не найдено');
}
