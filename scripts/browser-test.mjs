#!/usr/bin/env node
/**
 * Браузерные тесты: поднять мир целиком и прогнать зонды.
 *
 * Отвечает на то, чего не видят unit-тесты и typecheck: клиент открывается,
 * сцена не пустая, двое видят друг друга, ник не дублируется, ушедший в
 * другой мир исчезает из вида. Все три реальных бага плейтеста 22.10 были
 * видны ТОЛЬКО здесь — поэтому зонды гоняются в CI, а не руками.
 *
 * Что делает:
 *   1. поднимает сервер (`@oasis/server`) и ждёт /health;
 *   2. поднимает vite и ждёт, пока отдаст HTML;
 *   3. последовательно запускает зонды из scripts/probes/*.mjs;
 *   4. гасит всё в finally, даже при падении зонда или Ctrl+C.
 *
 * Требует chromium и puppeteer-core:
 *   npm install --no-save puppeteer-core
 *   CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const probesDir = path.join(here, 'probes');

const SERVER_PORT = Number(process.env.OASIS_SERVER_PORT ?? 2567);
const CLIENT_PORT = Number(process.env.OASIS_CLIENT_PORT ?? 5173);
const HEALTH_URL = `http://localhost:${SERVER_PORT}/health`;
const CLIENT_URL = `http://localhost:${CLIENT_PORT}/`;
const BOOT_TIMEOUT_MS = 90_000;
const PROBE_TIMEOUT_MS = Number(process.env.OASIS_PROBE_TIMEOUT_MS ?? 300_000);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [];
let shuttingDown = false;

function log(message) {
  process.stdout.write(`[browser-test] ${message}\n`);
}

/** Гасит всё, что подняли. Идемпотентно: можно звать из finally и из сигналов. */
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}

function spawnChild(name, args, color, extraEnv = {}) {
  const child = spawn(npm, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FORCE_COLOR: '1',
      OASIS_STORAGE: 'memory',
      // Зондам нужен тестовый перенос игрока между зонами (POST /debug/move):
      // так переход между мирами проверяется без пешего маршрута по пропам.
      OASIS_TEST_HOOKS: '1',
      ...extraEnv,
    },
    shell: false,
    detached: false,
  });
  children.push(child);

  const prefix = (chunk) => {
    if (!process.env.OASIS_VERBOSE) return;
    for (const line of chunk.toString().split('\n')) {
      if (line.length > 0) process.stdout.write(`${color}[${name}]${line}\x1b[0m\n`);
    }
  };
  child.stdout.on('data', prefix);
  child.stderr.on('data', prefix);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    // Сервер или vite умерли сами — ждать зонды бессмысленно.
    log(`${name} завершился до конца прогона (code=${code ?? '—'})`);
    shutdown();
  });
  return child;
}

/** Ждёт, пока probe вернёт true, до таймаута. */
async function waitFor(label, probe, timeoutMs = BOOT_TIMEOUT_MS) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    if (shuttingDown) throw new Error(`остановлено: ${label}`);
    try {
      if (await probe()) {
        log(`${label} готов за ${((Date.now() - started) / 1000).toFixed(1)} с`);
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timeout ${timeoutMs} мс: ${label}${lastError ? ` (${lastError})` : ''}`);
}

async function fetchOk(url, expectBody) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) return false;
  if (expectBody) {
    const text = await response.text();
    return text.length > 0;
  }
  return true;
}

/** Запускает один зонд как отдельный процесс: зонды изолированы друг от друга. */
function runProbe(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(probesDir, file), CLIENT_URL], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
      shell: false,
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
      process.stderr.write(chunk);
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ file, code: 124, output, note: `таймаут ${PROBE_TIMEOUT_MS} мс` });
    }, PROBE_TIMEOUT_MS);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ file, code: code ?? 1, output });
    });
  });
}

/** Порт занят кем-то ещё — тестировать будем не тот код. */
async function assertPortFree(port) {
  try {
    await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) });
  } catch {
    return; // никто не ответил — порт свободен
  }
  throw new Error(
    `порт ${port} уже занят. Остановите старый dev-сервер: прогон иначе проверит чужой процесс.`,
  );
}

async function main() {
  if (!existsSync(probesDir)) {
    throw new Error(`нет каталога зондов: ${probesDir}`);
  }
  // Preflight: иначе vite с strictPort упадёт, а зонды пойдут в старый
  // процесс — и зелёный результат будет врать.
  await assertPortFree(SERVER_PORT);
  await assertPortFree(CLIENT_PORT);

  // `_`-файлы — общие помощники, а не зонды.
  const probes = (await readdir(probesDir))
    .filter((name) => name.endsWith('.mjs') && !name.startsWith('_'))
    .sort();
  if (probes.length === 0) throw new Error(`в ${probesDir} нет зондов`);

  log(`зондов к запуску: ${probes.length} — ${probes.join(', ')}`);

  spawnChild('server', ['run', 'start'], '\x1b[36m', {
    // Сервер обязан слушать порт, который ждёт раннер. Без этого
    // OASIS_SERVER_PORT меняет только health-URL, а процесс садится на
    // дефолтный 2567: в CI они совпадают случайно, при любом оффсете
    // прогон падает «fetch failed» — а зонды звали бы хук не на тот сервер.
    PORT: String(SERVER_PORT),
  });
  await waitFor('сервер', () => fetchOk(HEALTH_URL));

  spawnChild('client', ['run', 'dev:client'], '\x1b[35m', {
    // Клиент должен ходить на «наш» сервер, а не на дефолтный 2567: без
    // этого при OASIS_SERVER_PORT ≠ 2567 зонды проверили бы чужой процесс.
    VITE_SERVER_URL: `ws://localhost:${SERVER_PORT}`,
  });
  await waitFor('клиент', () => fetchOk(CLIENT_URL, true));

  // Даём серверу секунду на полную инициализацию комнаты до первого зонда.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const results = [];
  for (const probe of probes) {
    if (shuttingDown) break;
    log(`── зонд ${probe} ──`);
    const result = await runProbe(probe);
    results.push(result);
    log(`${probe}: ${result.code === 0 ? 'ок' : `ПРОВАЛ (code=${result.code})`}`);
  }

  const failed = results.filter((result) => result.code !== 0);
  log('');
  log(`итог: ${results.length - failed.length}/${results.length} зондов прошло`);
  if (failed.length > 0) {
    for (const result of failed) log(`  ✖ ${result.file}${result.note ? ` — ${result.note}` : ''}`);
  }
  return failed.length === 0 ? 0 : 1;
}

process.on('SIGINT', () => {
  shutdown();
  process.exit(130);
});
process.on('SIGTERM', () => {
  shutdown();
  process.exit(143);
});

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  log(`ошибка прогона: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  shutdown();
}

// Даём детям умереть, но не висим, если кто-то заупрямился.
await new Promise((resolve) => setTimeout(resolve, 500));
for (const child of children) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
process.exit(exitCode);
