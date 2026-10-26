#!/usr/bin/env node
/**
 * Проверка деплоя снаружи: открывает публичную ссылку в headless-chromium
 * и смотрит, доходит ли игра до конца — «в сети», ростер, видимые тела.
 *
 * Зачем отдельно от зондов: зонды гоняются против localhost, а здесь
 * проверяется реальный путь «браузер → туннель → сервер». Ровно так ломалось:
 * туннель поднялся, HTTP отвечает, а WebSocket браузеру не проходит.
 *
 * Локальный DNS не резолвит *.trycloudflare.com (адрес провайдером режется),
 * поэтому для него хосты маппятся на рабочий anycast-адрес через
 * --host-resolver-rules: SNI от этого не меняется, TLS остаётся настоящим.
 * Остальные туннели (pinggy) резолвятся сами — их карта ломает сертификат.
 *
 * Запуск (после scripts/deploy.sh):
 *   node scripts/deploy-check.mjs                 # берёт адреса из .deploy-state
 *   CF_IP=172.64.32.1 node scripts/deploy-check.mjs
 *   node scripts/deploy-check.mjs <client-host> <ws-host>
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import puppeteer from 'puppeteer-core';

const ROOT = resolve(import.meta.dirname, '..');

/** Адреса по умолчанию — из состояния деплоя. */
function fromState() {
  try {
    const text = readFileSync(resolve(ROOT, '.deploy-state'), 'utf8');
    const get = (key) => text.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim();
    const client = get('CLIENT_URL')?.replace(/^https?:\/\//, '');
    const ws = get('WS_URL')?.replace(/^wss?:\/\//, '');
    if (!client || !ws) throw new Error('в .deploy-state нет CLIENT_URL/WS_URL');
    return { client, ws };
  } catch (error) {
    console.error(`не прочитал .deploy-state: ${error.message}`);
    console.error('запусти scripts/deploy.sh или передай адреса: node scripts/deploy-check.mjs <client-host> <ws-host>');
    process.exit(1);
  }
}

const fromArgs = process.argv[2] ? { client: process.argv[2], ws: process.argv[3] } : null;
const { client, ws } = fromArgs?.client && fromArgs?.ws ? fromArgs : fromState();

// Рабочие anycast-адреса Cloudflare нужны только для trycloudflare.com:
// локальный DNS резолвит его в адрес, до которого соединение не доходит.
// Остальные туннели (pinggy) резолвятся сами, и подменять их адрес нельзя —
// сертификат хоста перестанет совпадать (ERR_CERT_COMMON_NAME_INVALID).
const IP = process.env.CF_IP ?? '104.16.100.100';
const needsHostMap = client.endsWith('.trycloudflare.com') || ws.endsWith('.trycloudflare.com');
const resolverRules = needsHostMap
  ? `--host-resolver-rules=MAP ${client} ${IP}, MAP ${ws} ${IP}`
  : null;
const URL = `https://${client}/`;
const problems = [];

console.log(
  `проверяю ${URL} (wss://${ws}${needsHostMap ? `, хост → ${IP}` : ', DNS без подмены'})`,
);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    ...(resolverRules ? [resolverRules] : []),
  ],
});

async function open(label) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (error) => problems.push(`[${label}] pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`[${label}] console: ${message.text()}`);
  });
  page.on('requestfailed', (request) => {
    const text = request.failure()?.errorText ?? '';
    if (text.includes('ERR_ABORTED')) return;
    problems.push(`[${label}] ${request.url()} → ${text}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`[${label}] http ${response.status()} ${response.url()}`);
  });

  await page.goto(URL, { waitUntil: 'load', timeout: 60_000 });

  // Бесплатные туннели (pinggy) вставляют страницу «Enter site»: одна кнопка
  // ставит кукой согласие, после которой проходят и статика, и WebSocket.
  // Без этого клика игра открылась бы, но не подключилась бы — ровно такая
  // ошибка и была у людей на старом деплое.
  const clicked = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button, a')].find((element) =>
      /access\(\)|Enter site/i.test(element.outerHTML),
    );
    if (!button) return false;
    button.click();
    return true;
  });
  if (clicked) {
    console.log(`[${label}] страница предупреждения туннеля — нажал «Enter site»`);
    await page.waitForNavigation({ waitUntil: 'load', timeout: 30_000 }).catch(() => {});
  }

  await page.waitForFunction(
    () => document.getElementById('status-text')?.textContent === 'в сети',
    { timeout: 45_000 },
  );
  console.log(`[${label}] статус: в сети`);
  return page;
}

const debug = (page) => page.evaluate(() => window.__oasisDebug());

try {
  const first = await open('окно 1');
  await new Promise((r) => setTimeout(r, 2000));
  const second = await open('окно 2');
  await new Promise((r) => setTimeout(r, 4000));

  const hudA = await debug(first);
  const hudB = await debug(second);
  console.log('окно 1:', JSON.stringify(hudA));
  console.log('окно 2:', JSON.stringify(hudB));

  if (!hudA.selfName) problems.push('первое окно не получило ник');
  if (hudA.roster < 2) problems.push(`в первом окне игроков: ${hudA.roster}, ожидалось 2`);
  if (hudA.visibleOthers < 1) problems.push('первое окно не видит тела второго игрока');
} catch (error) {
  problems.push(`не дождался игры: ${error.message}`);
}

console.log(problems.length ? `\nПРОБЛЕМЫ:\n - ${problems.join('\n - ')}` : '\nок: деплой отвечает, игра запускается');
await browser.close();
process.exit(problems.length ? 2 : 0);
