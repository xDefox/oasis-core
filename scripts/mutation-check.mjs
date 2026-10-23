#!/usr/bin/env node
/**
 * Мутационная проверка тестов: ломаем код и смотрим, какой тест упал.
 *
 * Тест, который проходит и на сломанном коде, хуже отсутствия теста:
 * он создаёт ложную уверенность. Плейтест 22.10 показал это дважды —
 * AOI-тест сначала проходил без своего фикса, а зонд движения не ловил
 * сломанный разгон.
 *
 *   node scripts/mutation-check.mjs
 *
 * Каждая мутация: (имя, файл, исходный текст, замена, ожидаемый тест).
 * Если ожидаемый тест НЕ упал — мутация выжила, и это дыра в тестах.
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const MUTATIONS = [
  {
    name: 'разгон мгновенный (нет инерции)',
    file: 'packages/protocol/src/movement.ts',
    from: `  if (delta <= maxDelta || delta === 0) {
    return { vx: targetVx, vz: targetVz };
  }`,
    to: `  if (true) {
    return { vx: targetVx, vz: targetVz };
  }`,
    expect: 'движение: разгон',
  },
  {
    name: 'торможение = разгону',
    file: 'packages/protocol/src/movement.ts',
    from: '  const maxDelta = (moving ? PLAYER_ACCEL : PLAYER_DECEL) * dt;',
    to: '  const maxDelta = PLAYER_ACCEL * dt;',
    expect: 'движение: разгон',
  },
  {
    name: 'ввод не нормализуется (форсаж)',
    file: 'packages/protocol/src/movement.ts',
    from: '    const scale = (length > 1 ? 1 / length : 1) * speed;',
    to: '    const scale = speed;',
    expect: 'движение: разгон',
  },
  {
    name: 'нет мёртвой зоны',
    file: 'packages/protocol/src/movement.ts',
    from: 'const DEAD_ZONE = 0.01;',
    to: 'const DEAD_ZONE = 0;',
    expect: 'движение: разгон',
  },
  {
    name: 'спринт не отличается от шага',
    file: 'packages/protocol/src/movement.ts',
    from: '    const speed = sprint ? PLAYER_SPRINT_SPEED : PLAYER_SPEED;',
    to: '    const speed = PLAYER_SPEED;',
    expect: 'движение: разгон',
  },
  {
    name: 'AOI не учитывает зоны',
    file: 'packages/server/src/rooms/SectorRoom.ts',
    from: '      if (other.zoneId !== session.zoneId) continue;',
    to: '      // мутация: зона не проверяется',
    expect: 'не показывает игрока из другой зоны',
  },
  {
    name: 'ник не разводится суффиксом',
    file: 'packages/server/src/rooms/SectorRoom.ts',
    from: '    const name = this.uniqueName(sanitizeName(hello.name));',
    to: '    const name = sanitizeName(hello.name);',
    expect: 'разводит игроков с одинаковым ником',
  },
  {
    name: 'портал: прибытие в центр обратного (пинг-понг)',
    file: 'packages/server/src/rooms/SectorRoom.ts',
    from: '      const step = (target?.radius ?? portal.radius) + 1.5;',
    to: '      const step = 0;',
    expect: 'телепортирует через портал',
  },
  {
    name: 'портал: кулдаун телепорта отключён',
    file: 'packages/server/src/rooms/SectorRoom.ts',
    from: '    if (now < session.teleportUntil) return;',
    to: '    // мутация: кулдаун телепорта отключён',
    expect: 'кулдаун портала',
  },
  {
    name: 'ввод клиента не протухает (TTL)',
    file: 'packages/server/src/rooms/SectorRoom.ts',
    from: '      if (input && now - session.lastInputAt > INPUT_TTL_MS) {',
    to: '      if (false && input && now - session.lastInputAt > INPUT_TTL_MS) {',
    expect: 'ввод клиента протухает',
  },
  {
    name: 'переименование не исключает самого себя',
    file: 'packages/server/src/rooms/SectorRoom.ts',
    from: '      if (session === exclude) continue;',
    to: '      // мутация: своё имя тоже считается занятым',
    expect: 'переименовывает игрока',
  },
  {
    name: 'потолок кадра срезан до 100 мс (симуляция зависит от fps)',
    file: 'packages/client/src/net/frameDelta.ts',
    from: 'export const MAX_FRAME_MS = 400;',
    to: 'export const MAX_FRAME_MS = 100;',
    expect: 'не обрезается до 100',
  },
  {
    name: 'переименование не рассылает ростер',
    file: 'packages/server/src/rooms/SectorRoom.ts',
    from: '      client.send(S2C.Renamed, { name: next });\n      this.broadcastRoster();',
    to: '      client.send(S2C.Renamed, { name: next });',
    expect: 'переименовывает игрока',
  },
];

async function runTests() {
  try {
    const { stdout } = await execFileAsync(
      'npm',
      ['test'],
      { cwd: root, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return { code: 0, stdout };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    };
  }
}

/** Имена упавших тестов из вывода node:test. */
function failedTests(output) {
  const names = new Set();
  for (const match of output.matchAll(/^\s*✖\s+(.+?)\s+\(\d/gmu)) {
    names.add(match[1].trim());
  }
  return names;
}

const results = [];
for (const mutation of MUTATIONS) {
  const filePath = path.join(root, mutation.file);
  const original = await readFile(filePath, 'utf8');
  if (!original.includes(mutation.from)) {
    results.push({ ...mutation, status: 'НЕ НАЙДЕНО', detail: 'фрагмент исходника не совпал' });
    continue;
  }

  await writeFile(filePath, original.replace(mutation.from, mutation.to));
  const { code, stdout } = await runTests();
  await writeFile(filePath, original);

  const failed = failedTests(stdout);
  const caught = [...failed].some((name) => name.includes(mutation.expect));
  results.push({
    ...mutation,
    status: caught ? 'поймана' : 'ВЫЖИЛА',
    detail: caught
      ? `упал: ${[...failed].find((n) => n.includes(mutation.expect))}`
      : `упали: ${[...failed].join('; ') || '(ничего)'}`,
  });
  process.stdout.write(`${caught ? '✓' : '✖'} ${mutation.name}\n`);
}

console.log('');
console.log('=== ИТОГ ===');
for (const result of results) {
  console.log(`${result.status.padEnd(10)} ${result.name}`);
  console.log(`           ${result.detail}`);
}
const survived = results.filter((result) => result.status !== 'поймана');
if (survived.length > 0) {
  console.log('');
  console.log(`ВЫЖИЛО МУТАЦИЙ: ${survived.length} из ${results.length} — это дыры в тестах.`);
  process.exitCode = 2;
} else {
  console.log('');
  console.log(`Все ${results.length} мутаций пойманы.`);
}
