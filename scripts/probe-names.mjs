/**
 * Разовая проверка: две вкладки одного браузера с одинаковым ником.
 *
 * Сценарий из жизни — два окна на одной машине. Они делят localStorage,
 * значит присылают на сервер один и тот же `oasis.name`. Сервер обязан
 * развести их суффиксом, а клиент — сказать игроку, как его теперь зовут.
 *
 *   node scripts/probe-names.mjs http://localhost:5173
 */

import { setTimeout as delay } from 'node:timers/promises';

import puppeteer from 'puppeteer-core';

const URL_TO_OPEN = process.argv[2] ?? 'http://localhost:5173';

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

/** Вкладка без изоляции профиля: localStorage общий с остальными. */
async function openTab(label) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (error) => problems.push(`[${label}] pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`[${label}] console: ${message.text()}`);
  });
  await page.goto(URL_TO_OPEN, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__oasisDebug !== undefined, { timeout: 30_000 });
  return page;
}

const hud = (page) =>
  page.evaluate(() => ({
    name: window.__oasisDebug().selfName,
    roster: window.__oasisDebug().roster,
    chat: Array.from(document.querySelectorAll('#chat-log .chat-line'))
      .map((node) => node.textContent)
      .slice(-4),
  }));

// Первый старт: чистим профиль, чтобы имя сгенерировалось с нуля.
const setup = await browser.newPage();
await setup.goto(URL_TO_OPEN, { waitUntil: 'load' });
await setup.evaluate(() => window.localStorage.clear());
await setup.close();

const first = await openTab('первое окно');
await delay(1500);
const second = await openTab('второе окно');
await delay(2500);

const firstHud = await hud(first);
const secondHud = await hud(second);

console.log('первое окно:', firstHud);
console.log('второе окно:', secondHud);

if (firstHud.name === secondHud.name) {
  problems.push(`оба окна получили один ник: ${firstHud.name}`);
}
if (firstHud.roster !== 2) {
  problems.push(`первое окно видит ${firstHud.roster} игроков, а должно 2`);
}
if (!secondHud.chat.some((line) => line.includes('занят'))) {
  problems.push('второе окно не сообщило, что ник занят');
}

// Оба должны видеть друг друга в ростере под разными именами.
const rosterNames = await first.evaluate(() => {
  const names = [];
  for (const player of window.__oasisDebug().rosterPlayers) names.push(player.name);
  return names;
});
console.log('ростер:', rosterNames);

await first.screenshot({ path: '/tmp/oasis-name-1.png' });
await second.screenshot({ path: '/tmp/oasis-name-2.png' });

await browser.close();

if (problems.length > 0) {
  console.log('\nПРОБЛЕМЫ:');
  for (const line of problems) console.log(' -', line);
  process.exitCode = 2;
} else {
  console.log('\nок: имена разведены, оба видят друг друга');
}
