/**
 * Общее для браузерных зондов.
 *
 * Зонды — не продукт: они гоняются в CI (`npm run test:browser`), чтобы
 * ловить то, чего не видят unit-тесты. Всё, что здесь, — про то, чтобы
 * зонд не врал: headless-браузер капризен, и «ложный провал» хуже, чем
 * отсутствие теста, потому что к нему привыкают и перестают читать.
 */

import { setTimeout as delay } from 'node:timers/promises';

import puppeteer from 'puppeteer-core';

export { delay };

export const CHROMIUM = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium';
export const URL_TO_OPEN = process.argv[2] ?? 'http://localhost:5173';

/** Собирает проблемы, а не падает сразу: нужен полный отчёт за один прогон. */
export class Problems {
  #items = [];

  add(message) {
    this.#items.push(message);
  }

  get count() {
    return this.#items.length;
  }

  /** Печатает отчёт и выставляет код выхода. Возвращает 0/2 для удобства. */
  finish() {
    if (this.#items.length === 0) {
      console.log('\nок: проблем не найдено');
      process.exitCode = 0;
      return 0;
    }
    console.log('\nПРОБЛЕМЫ:');
    for (const item of this.#items) console.log(` - ${item}`);
    process.exitCode = 2;
    return 2;
  }
}

/**
 * Запуск chromium для зонда.
 *
 * SwiftShader (софтверный GL) обязателен: в раннере нет GPU, и без него
 * WebGL-контекст не создаётся вовсе. `--enable-unsafe-swiftshader` — потому
 * что chromium иначе блокирует software-рендер как небезопасный.
 */
export async function launch({ width = 1280, height = 720 } = {}) {
  return puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      `--window-size=${width},${height}`,
    ],
  });
}

/**
 * Новая страница-игрок с заданным ником.
 *
 * Сбрасывает localStorage целиком, а не по ключам: иначе зонд зависит от
 * того, что оставил предыдущий зонд в том же профиле.
 *
 * ВСЕГДА зовёт bringToFront: в headless активна одна вкладка, и ввод,
 * отправленный в фоновую, уходит в никуда. Это уже давало «немой» зонд.
 */
export async function newPlayer(browser, name, problems, { accountAgeDays = 30 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error') problems.add(`[${name}] console: ${text}`);
  });
  page.on('pageerror', (error) => problems.add(`[${name}] pageerror: ${error.message}`));
  page.on('requestfailed', (request) => {
    const text = request.failure()?.errorText ?? '';
    if (text.includes('ERR_ABORTED')) return;
    problems.add(`[${name}] ${request.url()} → ${text}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.add(`[${name}] ${response.status()} ${response.url()}`);
  });

  await page.goto(URL_TO_OPEN, { waitUntil: 'load' });
  await page.evaluate(
    ({ nick, ageDays }) => {
      window.localStorage.clear();
      window.localStorage.setItem(
        'oasis.account',
        JSON.stringify({
          id: `acct_probe_${nick}`,
          createdAt: Date.now() - ageDays * 24 * 60 * 60 * 1000,
        }),
      );
      window.localStorage.setItem('oasis.name', nick);
    },
    { nick: name, ageDays: accountAgeDays },
  );
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(
    () => document.getElementById('status-text')?.textContent === 'в сети',
    { timeout: 30_000 },
  );
  await page.waitForFunction(() => window.__oasisDebug !== undefined, { timeout: 10_000 });
  await page.bringToFront();
  return page;
}

/** Снимок отладочного состояния клиента. */
export const debug = (page) => page.evaluate(() => window.__oasisDebug());

/**
 * Профиль скорости по кадрам.
 *
 * Нужен, чтобы отличить «плавный разгон» от «прыжка на целевую скорость».
 * Если просто спросить скорость через полторы секунды, оба варианта дадут
 * 5 м/с, и сломанный разгон не будет виден вообще.
 *
 * Собираем прямо в странице по requestAnimationFrame: опрос из Node
 * пропускал бы кадры, а headless рисует всего 10–15 fps.
 */
export const sampleVelocity = (page, ms) =>
  page.evaluate(async (duration) => {
    const samples = [];
    const started = performance.now();
    while (performance.now() - started < duration) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const state = window.__oasisDebug?.();
      if (!state) continue;
      samples.push({
        t: Math.round(performance.now() - started),
        speed: Number(Math.hypot(state.vx, state.vz).toFixed(3)),
        x: state.x,
        z: state.z,
      });
    }
    return samples;
  }, ms);

/**
 * Есть ли в профиле промежуточная скорость — признак плавного разгона.
 *
 * Мгновенный прыжок с 0 на 5 даёт только 0 и 5; плавный разгон обязательно
 * проходит через 1–4 м/с.
 */
export function hasIntermediateSpeed(samples, { min = 0.6, max = 4.4 } = {}) {
  return samples.some((sample) => sample.speed > min && sample.speed < max);
}

/** Дочерние элементы лога чата — чтобы проверить, что сообщение дошло. */
export const chat = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#chat-log .chat-line')).map((node) => node.textContent),
  );
