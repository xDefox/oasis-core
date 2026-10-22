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
 * Начинает сбор профиля скорости и ждёт первый образец.
 *
 * Ждать первый образец обязательно: без него первое же изменение скорости
 * не с чем сравнить, и скачок 0 → 5 проходит незамеченным. Сбор идёт в
 * странице по requestAnimationFrame и живёт до `stopSampling` — так образец
 * «в покое» попадает в выборку до нажатия клавиши.
 */
export async function startSampling(page) {
  await page.evaluate(() => {
    const samples = [];
    window.__oasisSamples = samples;
    window.__oasisSampling = true;
    const loop = () => {
      if (!window.__oasisSampling) return;
      const state = window.__oasisDebug?.();
      if (state) {
        samples.push({
          t: Math.round(performance.now()),
          speed: Number(Math.hypot(state.vx, state.vz).toFixed(3)),
          simTicks: state.simTicks,
        });
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await page.waitForFunction(() => (window.__oasisSamples?.length ?? 0) >= 1, {
    timeout: 15_000,
    polling: 50,
  });
}

/** Останавливает сбор и возвращает образцы. */
export const stopSampling = (page) =>
  page.evaluate(() => {
    window.__oasisSampling = false;
    return window.__oasisSamples ?? [];
  });

/** Длительность тика предсказания, мс (`TICK_MS` в @oasis/protocol). */
export const TICK_MS = 50;
/** Ускорение и торможение, м/с² (`PLAYER_ACCEL` / `PLAYER_DECEL`). */
export const PLAYER_ACCEL = 28;
export const PLAYER_DECEL = 42;

/**
 * Прирост скорости, который физика объяснить не может.
 *
 * Почему не «есть ли в выборке промежуточная скорость»: на 3 fps разгон
 * 0 → 5 занимает 0.18 с и целиком укладывается между двумя кадрами, поэтому
 * промежуточной скорости в выборке просто нет — проверка врала бы на
 * зелёном коде (так CI и упал). Предел прироста за тик держится при любом
 * fps: 28 м/с² × 0.05 с = 1.4 м/с, а мгновенный разгон даёт 5 м/с за один
 * тик. Число тиков берём из самих образцов, а не из времени.
 *
 * Слепая зона: если один кадр успевает проинтегрировать 4+ тика (200 мс
 * симуляции), скачок 0 → 5 в него укладывается. Сейчас это невозможно:
 * клиент ограничивает шаг кадра 100 мс, то есть максимум 2 тика.
 */
export function unexplainedSpeedGrowth(samples, accel = PLAYER_ACCEL) {
  const found = [];
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const next = samples[i];
    const ticks = next.simTicks - prev.simTicks;
    const allowed = (accel * ticks * TICK_MS) / 1000 + 0.05;
    const growth = next.speed - prev.speed;
    if (growth > allowed) {
      found.push(
        `${prev.speed} → ${next.speed} м/с за ${ticks} тик(ов) ` +
          `(физика разрешает ${allowed.toFixed(2)})`,
      );
    }
  }
  return found;
}

/** То же для торможения: скорость не может упасть быстрее, чем даёт decel. */
export function unexplainedSpeedDrop(samples, decel = PLAYER_DECEL) {
  const found = [];
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const next = samples[i];
    const ticks = next.simTicks - prev.simTicks;
    const allowed = (decel * ticks * TICK_MS) / 1000 + 0.05;
    const drop = prev.speed - next.speed;
    if (drop > allowed) {
      found.push(
        `${prev.speed} → ${next.speed} м/с за ${ticks} тик(ов) ` +
          `(физика разрешает ${allowed.toFixed(2)})`,
      );
    }
  }
  return found;
}

/** Дочерние элементы лога чата — чтобы проверить, что сообщение дошло. */
export const chat = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('#chat-log .chat-line')).map((node) => node.textContent),
  );
