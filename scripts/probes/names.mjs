/**
 * Зонд ников: две вкладки одного браузера с одинаковым ником.
 *
 * Сценарий из жизни — два окна на одной машине. Они делят localStorage,
 * значит шлют на сервер один и тот же `oasis.name`. Сервер обязан развести
 * их суффиксом, а клиент — сказать игроку, как его теперь зовут. Ник —
 * единственное, по чему игроки друг друга опознают, поэтому дубль это баг.
 *
 * Запускается раннером (`npm run test:browser`), вручную — так:
 *   node scripts/probes/names.mjs http://localhost:5173
 */

import { chat, debug, delay, launch, Problems, URL_TO_OPEN } from './_probe.mjs';

const problems = new Problems();
const browser = await launch();

/**
 * Вкладка без изоляции профиля: localStorage общий со всеми остальными —
 * это и есть проверяемая ситуация.
 */
async function openTab(label) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (error) => problems.add(`[${label}] pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.add(`[${label}] console: ${message.text()}`);
  });
  await page.goto(URL_TO_OPEN, { waitUntil: 'load' });
  await page.waitForFunction(
    () => document.getElementById('status-text')?.textContent === 'в сети',
    { timeout: 30_000 },
  );
  await page.bringToFront();
  return page;
}

// Чистим профиль, чтобы ник сгенерировался с нуля в первом окне.
const setup = await browser.newPage();
await setup.goto(URL_TO_OPEN, { waitUntil: 'load' });
await setup.evaluate(() => window.localStorage.clear());
await setup.close();

const first = await openTab('первое окно');
await delay(1500);
const second = await openTab('второе окно');
await delay(2500);

const firstHud = await debug(first);
const secondHud = await debug(second);
console.log('первое окно:', { name: firstHud.selfName, roster: firstHud.roster });
console.log('второе окно:', { name: secondHud.selfName, roster: secondHud.roster });

if (!firstHud.selfName || !secondHud.selfName) {
  problems.add('клиент не получил выданный сервером ник');
}
if (firstHud.selfName === secondHud.selfName) {
  problems.add(`оба окна получили один ник: ${firstHud.selfName}`);
}
if (firstHud.roster !== 2) {
  problems.add(`первое окно видит ${firstHud.roster} игроков, а должно 2`);
}

const secondChat = await chat(second);
console.log('чат второго окна:', secondChat.slice(-4));
if (!secondChat.some((line) => line.includes('занят'))) {
  problems.add('второе окно не сообщило, что ник занят');
}

const rosterNames = firstHud.rosterPlayers.map((player) => player.name).sort();
console.log('ростер:', rosterNames);
const unique = new Set(rosterNames.map((name) => name.toLowerCase()));
if (unique.size !== rosterNames.length) {
  problems.add(`в ростере дубли имён: ${rosterNames.join(', ')}`);
}

await first.screenshot({ path: '/tmp/oasis-names-first.png' });
await second.screenshot({ path: '/tmp/oasis-names-second.png' });

await browser.close();
problems.finish();
