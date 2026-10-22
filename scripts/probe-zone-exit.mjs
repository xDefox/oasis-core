/**
 * Разовая проверка: игрок ушёл в другой мир — аватар должен пропасть.
 *
 * Walker идёт пешком до настоящего портала (никаких `__oasisWarp`: клиент
 * знает границы только своей зоны и такой хак обрезает). Пока он идёт,
 * контроллер подруливает по фактической позиции. Как только портал его
 * перебросил — тело у наблюдателя должно исчезнуть, а ростер остаться.
 *
 *   node scripts/probe-zone-exit.mjs http://localhost:5173
 */

import { setTimeout as delay } from 'node:timers/promises';

import puppeteer from 'puppeteer-core';

const URL_TO_OPEN = process.argv[2] ?? 'http://localhost:5173';
const PORTAL = { x: 26, z: 0 };

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
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

async function newPlayer(name) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (error) => problems.push(`[${name}] pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`[${name}] console: ${message.text()}`);
  });
  await page.goto(URL_TO_OPEN, { waitUntil: 'load' });
  await page.evaluate((nick) => {
    window.localStorage.clear();
    window.localStorage.setItem(
      'oasis.account',
      JSON.stringify({ id: `acct_zone_${nick}`, createdAt: Date.now() - 30 * 86400000 }),
    );
    window.localStorage.setItem('oasis.name', nick);
  }, name);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__oasisDebug !== undefined, { timeout: 30_000 });
  await page.bringToFront();
  await delay(1200);
  return page;
}

const debug = (page) => page.evaluate(() => window.__oasisDebug());

const watcher = await newPlayer('watcher');
await delay(800);
const walker = await newPlayer('walker');
await delay(2500);

await watcher.bringToFront();
await delay(600);
const beforeExit = await debug(watcher);
console.log('до ухода:', {
  walker: await debug(walker),
  roster: beforeExit.roster,
  visibleOthers: beforeExit.visibleOthers,
});

if (beforeExit.visibleOthers !== 1) {
  problems.push(`наблюдатель должен видеть 1 тело, видит ${beforeExit.visibleOthers}`);
}

// ── ведём walker к порталу, подруливая по фактической позиции ────────────
// yaw = 0: W = −Z, S = +Z, D = +X.
await walker.bringToFront();
await delay(400);

let reachedPortal = false;
for (let step = 0; step < 60; step += 1) {
  const state = await debug(walker);
  // Признак портала надёжнее координат: клиент догружает вторую зону,
  // то есть зона реально сменилась. Координатный порог проскакивается
  // между опросами — он и дал ложную «не дошёл».
  if (state.zoneGroups >= 2) {
    reachedPortal = true;
    break;
  }

  const dx = PORTAL.x - state.x;
  const dz = PORTAL.z - state.z;
  if (Math.abs(dx) < 2.5 && Math.abs(dz) < 2.5) {
    reachedPortal = true;
    break;
  }

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
  problems.push(`walker не дошёл до портала: ${JSON.stringify(await debug(walker))}`);
}

// Портал срабатывает в пределах радиуса — дадим пару тиков.
await delay(1500);
const walkerAfter = await debug(walker);
console.log('walker после портала:', { x: walkerAfter.x, z: walkerAfter.z });

await watcher.bringToFront();
await delay(1500);
const afterExit = await debug(watcher);
console.log('после ухода:', {
  roster: afterExit.roster,
  visibleOthers: afterExit.visibleOthers,
  trackedOthers: afterExit.trackedOthers,
});

if (afterExit.visibleOthers !== 0) {
  problems.push(`тело ушедшего игрока осталось видимым: ${afterExit.visibleOthers}`);
}
if (afterExit.roster !== 2) {
  problems.push(`ростер должен остаться из двух (он ещё в мире): ${afterExit.roster}`);
}

await watcher.screenshot({ path: '/tmp/oasis-zone-exit.png' });

await browser.close();

if (problems.length > 0) {
  console.log('\nПРОБЛЕМЫ:');
  for (const line of problems) console.log(' -', line);
  process.exitCode = 2;
} else {
  console.log('\nок: ушедший в другой мир пропал из вида');
}
