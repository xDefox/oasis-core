/**
 * Разовая диагностика: как оживает игрок после отпускания клавиши.
 *
 * Вопрос, на который отвечает: клиент считает, что стоит на месте
 * (его x = 30), а зонд видит 12. Кто из них расходится с сервером —
 * клиент или зонд?
 */

import { setTimeout as delay } from 'node:timers/promises';

import puppeteer from 'puppeteer-core';

const URL_TO_OPEN = 'http://localhost:5173';

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

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
await page.goto(URL_TO_OPEN, { waitUntil: 'load' });
await page.evaluate(() => {
  window.localStorage.clear();
  window.localStorage.setItem(
    'oasis.account',
    JSON.stringify({ id: 'acct_diag', createdAt: Date.now() - 30 * 86400000 }),
  );
  window.localStorage.setItem('oasis.name', 'diag');
});
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'в сети');
await page.waitForFunction(() => window.__oasisDebug !== undefined);
await page.bringToFront();

const debug = () => page.evaluate(() => window.__oasisDebug());
const compare = () => page.evaluate(() => window.__oasisCompare());

// Есть ли на странице два исполнения клиента (двойной запуск main)?
const duplicate = await page.evaluate(() => {
  const same = window.__oasisWarp === window.__oasisWarp;
  return { same, keys: Object.keys(window).filter((key) => key.startsWith('__oasis')) };
});
console.log('страница:', duplicate);

for (const warp of [
  ['центр', [0, 0]],
  ['край', [30, 0]],
  ['дальний угол', [29, -28]],
]) {
  await page.evaluate(([, [x, z]]) => window.__oasisWarp?.(x, z), warp);
  await delay(1200);
  console.log(`${warp[0]} после варпа:`, await debug());
}

console.log('--- идём вправо 3 с ---');
await page.keyboard.down('KeyD');
for (let i = 0; i < 6; i += 1) {
  await delay(500);
  console.log(`  t=${(i + 1) * 0.5}s`, await compare());
}
await page.keyboard.up('KeyD');
console.log('--- отпустили ---');
for (let i = 0; i < 6; i += 1) {
  await delay(400);
  console.log(`  t=+${(i + 1) * 0.4}s`, await compare());
}

await browser.close();
