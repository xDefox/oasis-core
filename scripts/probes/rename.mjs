/**
 * Зонд смены ника: `/name` — команда, которую разбирает клиент, а решает сервер.
 *
 * Что проверяем (ни один unit-тест этого не видит):
 *   1. команда не уходит в чат как обычное сообщение;
 *   2. сервер выдаёт ник, клиент его показывает и запоминает;
 *   3. второй игрок видит новый ник в ростере;
 *   4. конфликт разводится суффиксом, и игрок об этом узнаёт.
 *
 * Запускается раннером (`npm run test:browser`), вручную — так:
 *   node scripts/probes/rename.mjs http://localhost:5173
 */

import { chat, debug, delay, launch, newPlayer, Problems } from './_probe.mjs';

const problems = new Problems();
const browser = await launch();

const alpha = await newPlayer(browser, 'rename-alpha', problems);
await delay(1200);
const beta = await newPlayer(browser, 'rename-beta', problems);
await delay(2500);

/** Вводит команду через поле чата — тем же путём, что живой игрок. */
async function command(page, text) {
  await page.bringToFront();
  await page.keyboard.press('Enter');
  await delay(250);
  const open = await page.evaluate(() => !document.getElementById('chat-form')?.hidden);
  if (!open) problems.add('Enter не открыл поле чата');
  await page.keyboard.type(text, { delay: 20 });
  await page.keyboard.press('Enter');
  await delay(1200);
}

const before = await debug(alpha);
console.log('до смены:', { self: before.selfName, roster: before.rosterPlayers });

// ── успешная смена ──────────────────────────────────────────────────────
await command(alpha, '/name ренамед');

const afterRename = await debug(alpha);
console.log('после смены:', {
  self: afterRename.selfName,
  roster: afterRename.rosterPlayers,
});

if (afterRename.selfName !== 'ренамед') {
  problems.add(`клиент не принял выданный ник: ${afterRename.selfName}`);
}

const alphaChat = await chat(alpha);
console.log('чат alpha:', alphaChat.slice(-3));
if (!alphaChat.some((line) => line.includes('теперь ты «ренамед»'))) {
  problems.add('клиент не сообщил игроку о новом нике');
}

// Команда не должна уйти в мир как обычное сообщение.
if (alphaChat.some((line) => line.includes('/name'))) {
  problems.add('команда /name ушла в чат как текст');
}

// Ник сохраняется между сессиями. Читаем localStorage, а не перезагружаем
// страницу: реконнекта пока нет (F0-8), старая сессия держит ник до
// TCP-таймаута, и перезагрузка проверяла бы не то.
// Важно: проверяем СРАЗУ после своей смены. Вкладки одного браузера делят
// localStorage, поэтому следующая смена ника в другой вкладке перезапишет
// ключ — это не баг, а свойство профиля.
const stored = await alpha.evaluate(() => window.localStorage.getItem('oasis.name'));
console.log('в localStorage:', stored);
if (stored !== 'ренамед') {
  problems.add(`ник не сохранился в localStorage: ${stored}`);
}

// ── второй игрок видит новый ник ────────────────────────────────────────
const betaView = await debug(beta);
console.log('beta видит ростер:', betaView.rosterPlayers);
if (!betaView.rosterPlayers.some((player) => player.name === 'ренамед')) {
  problems.add('второй игрок не увидел новый ник в ростере');
}
if (betaView.rosterPlayers.some((player) => player.name === 'rename-alpha')) {
  problems.add('старый ник остался в ростере у второго игрока');
}

// ── конфликт разводится суффиксом ───────────────────────────────────────
await command(beta, '/name ренамед');

const betaRenamed = await debug(beta);
console.log('beta после конфликта:', { self: betaRenamed.selfName });
if (betaRenamed.selfName !== 'ренамед (2)') {
  problems.add(`конфликт не разведён суффиксом: ${betaRenamed.selfName}`);
}

const betaChat = await chat(beta);
if (!betaChat.some((line) => line.includes('теперь ты «ренамед (2)»'))) {
  problems.add('второй игрок не узнал, что ник занят и выдан суффикс');
}

// ── ник сохраняется между сессиями ──────────────────────────────────────
// (проверка стоит выше — сразу после своей смены: localStorage общий на профиль)
await alpha.screenshot({ path: '/tmp/oasis-rename.png' }).catch(() => {});

await browser.close();
problems.finish();
