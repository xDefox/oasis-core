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
    from: `    const speed = crouch
      ? PLAYER_CROUCH_SPEED
      : sprint
        ? PLAYER_SPRINT_SPEED
        : PLAYER_SPEED;`,
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
  {
    name: 'возобновление не пробует занять место раньше создания',
    file: 'packages/server/src/rooms/SectorRoom.ts',
    from: '    // Возврат на прежнее место — до всего остального: спавн, цвет и ник\n    // восстанавливаются из сессии, а не выдаются заново.\n    if (this.resume(client, hello)) return;\n\n    const sector = this.world.sectors[0];',
    to: '    const sector = this.world.sectors[0];',
    expect: 'возобновление места после обрыва',
  },
  {
    name: 'возобновление не забирает место у живого соединения',
    file: 'packages/server/src/rooms/SectorRoom.ts',
    from: '    if (session.disconnectedAt === null) {\n      // Место занято живым соединением. Токен однозначно указывает на него,\n      // а аккаунт совпал — это мы же. Старый сокет закрываем.\n      logInfo(`место ${session.name} забирает новое соединение`, {\n        players: this.sessions.size,\n      });\n      try {\n        session.client.leave(4003, \'место занято новым соединением\');\n      } catch {\n        // Сокет уже мёртв — ровно то, что нам нужно.\n      }\n    }',
    to: '    if (session.disconnectedAt === null) {\n      // мутация: живое соединение не выгоняется\n    }',
    expect: 'забирает своё место у живого соединения',
  },
  {
    name: 'возобновление не ротирует токен',
    file: 'packages/server/src/rooms/SectorRoom.ts',
    from: '    session.sent.clear();\n    session.resumeToken = randomUUID();\n    this.resumeTokens.set(session.resumeToken, session);\n    this.sessions.set(session.sessionId, session);\n\n    const welcome: WelcomeMsg = {\n      ...previous,\n      sessionId: session.sessionId,\n      // Клиент ставит предсказание ровно туда, где игрок пропал.\n      spawn: { x: session.x, y: session.y, z: session.z },\n      balance: session.balance,\n      resumeToken: session.resumeToken,\n      resumed: true,\n    };',
    to: '    session.sent.clear();\n    this.resumeTokens.set(session.resumeToken, session);\n    this.sessions.set(session.sessionId, session);\n\n    const welcome: WelcomeMsg = {\n      ...previous,\n      sessionId: session.sessionId,\n      // Клиент ставит предсказание ровно туда, где игрок пропал.\n      spawn: { x: session.x, y: session.y, z: session.z },\n      balance: session.balance,\n      resumeToken: session.resumeToken,\n      resumed: true,\n    };',
    expect: 'забирает своё место у живого соединения',
  },
  {
    name: 'возобновление не помечает resumed',
    file: 'packages/server/src/rooms/SectorRoom.ts',
    from: '      resumeToken: session.resumeToken,\n      resumed: true,\n    };',
    to: '      resumeToken: session.resumeToken,\n      resumed: false,\n    };',
    expect: 'возвращает на то же место',
  },
  {
    name: 'токен живого сокета не ищется',
    file: 'packages/server/src/rooms/SectorRoom.ts',
    from: '  private findResumable(hello: HelloMsg): Session | undefined {\n    if (hello.resume) {\n      const byToken = this.resumeTokens.get(hello.resume);\n      if (byToken) {\n        if (byToken.accountId !== hello.accountId) {\n          logWarn(\'токен возобновления от другого аккаунта\', {\n            token: hello.resume.slice(0, 8),\n          });\n          return undefined;\n        }\n        return byToken;\n      }\n    }',
    to: '  private findResumable(hello: HelloMsg): Session | undefined {\n    if (hello.resume) {\n      const byToken = this.resumeTokens.get(hello.resume);\n      if (byToken) {\n        if (byToken.disconnectedAt === null) return undefined;\n        if (byToken.accountId !== hello.accountId) {\n          logWarn(\'токен возобновления от другого аккаунта\', {\n            token: hello.resume.slice(0, 8),\n          });\n          return undefined;\n        }\n        return byToken;\n      }\n    }',
    expect: 'забирает своё место у живого соединения',
  },
  {
    name: 'шаг вверх игнорируется: низкий проп блокирует всегда',
    file: 'packages/protocol/src/collision.ts',
    from: '  return collider.y1 > feetY + stepUp && collider.y0 < feetY + height;',
    to: '  return collider.y0 < feetY + height;',
    expect: 'бордюр 0.3 м проходится ногой',
  },
  {
    name: 'высота тела игнорируется: крона над головой — стена',
    file: 'packages/protocol/src/collision.ts',
    from: '  return collider.y1 > feetY + stepUp && collider.y0 < feetY + height;',
    to: '  return collider.y1 > feetY + stepUp;',
    expect: 'конус над головой не блокирует',
  },
  {
    name: 'опора всегда пол: на проп не поднимает',
    file: 'packages/protocol/src/collision.ts',
    from: '  return best;\n}',
    to: '  return GROUND_Y; // мутация: опора не считается\n}',
    expect: 'опора меряется по центру ноги',
  },
  {
    name: 'сервер не передаёт высоту опоры в stepVertical',
    file: 'packages/server/src/rooms/SectorRoom.ts',
    from: '      const vertical = stepVertical(session.y, session.vy, wantJump, crouch, dt, groundY);',
    to: '      const vertical = stepVertical(session.y, session.vy, wantJump, crouch, dt);',
    expect: 'сервер ставит игрока на ступеньку',
  },

  {
    name: 'щель между пропами не считается ловушкой',
    file: 'packages/server/src/world/worldCheck.ts',
    from: '        if (gap > CONTACT_EPS && gap < GAP_MIN) traps.push(`${shortId(a.id)}↔${shortId(b.id)} ${gap.toFixed(2)} м`);',
    to: '        if (false) traps.push(`мутация: щель не считается`);',
    expect: 'щель-ловушка между двумя пропами',
  },
  {
    name: 'диск портала не защищён',
    file: 'packages/server/src/world/worldCheck.ts',
    from: '      radius: portal.radius + PLAYER_RADIUS,',
    to: '      radius: 0,',
    expect: 'проп в диске портала',
  },
  {
    name: 'точка прибытия не защищена',
    file: 'packages/server/src/world/worldCheck.ts',
    from: '      radius: ARRIVAL_CLEAR,',
    to: '      radius: 0,',
    expect: 'проп в точке прибытия из портала',
  },
  {
    name: 'кольцо спавна не защищено',
    file: 'packages/server/src/world/worldCheck.ts',
    from: '      radius: SPAWN_RING_MAX + PLAYER_RADIUS,',
    to: '      radius: 0,',
    expect: 'проп в кольце спавна',
  },
  {
    name: 'генератор не раздвигает ловушки',
    file: 'packages/server/src/world/repairGaps.ts',
    from: '      if (openGap < GAP_MIN) traps.push({ a, b, gap: openGap });',
    to: '      if (false) traps.push({ a: units[0], b: units[1], gap: 0 });',
    expect: 'генератор собирает мир без ловушек',
  },
  {
    name: 'генератор строит в запретных кругах',
    file: 'packages/server/src/world/procedural.ts',
    from: '    return Math.hypot(dx, dz) >= options.clearRadius && !inClearing(prop);',
    to: '    return Math.hypot(dx, dz) >= options.clearRadius;',
    expect: 'генератор собирает мир без ловушек',
  },

  // ── F0-6/F0-7: авторизация-lite ────────────────────────────────────────
  {
    name: 'подпись не сверяется (любой хвост подходит)',
    file: 'packages/server/src/auth/session.ts',
    from: '    if (!timingSafeEqual(expected, got)) return null;',
    to: '    if (false) return null;',
    expect: 'подделка подписи',
  },
  {
    name: 'короткий accountId принимается',
    file: 'packages/server/src/auth/session.ts',
    from: "    if (typeof parsed.accountId !== 'string' || parsed.accountId.length < 8) return null;",
    to: "    if (typeof parsed.accountId !== 'string') return null;",
    expect: 'короткий accountId',
  },
  {
    name: 'кука выдаётся без HttpOnly',
    file: 'packages/server/src/auth/session.ts',
    from: '  const cookie = `${COOKIE_NAME}=${signed}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;',
    to: '  const cookie = `${COOKIE_NAME}=${signed}; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;',
    expect: 'HttpOnly',
  },
  {
    name: 'cookie не читается из HTTP-контекста colyseus',
    file: 'packages/server/src/rooms/SectorRoom.ts',
    from: '      (options as any)?.rawHeaders?.cookie ??\n      cookieFromContext(context);',
    to: '      (options as any)?.rawHeaders?.cookie;',
    expect: 'AuthContext',
  },
  {
    name: 'accountCreatedAt снова берётся из hello (D-009 открыт)',
    file: 'packages/server/src/rooms/SectorRoom.ts',
    from: "    const accountCreatedAt: number =\n      hasServerAuth && typeof auth.issuedAt === 'number' ? auth.issuedAt : hello.accountCreatedAt;",
    to: '    const accountCreatedAt: number =\n      hello.accountCreatedAt;',
    expect: 'D-009',
  },
  {
    name: 'в production пропускают без cookie',
    file: 'packages/server/src/rooms/SectorRoom.ts',
    from: "    if (process.env.NODE_ENV === 'production') return false;",
    to: '    if (false) return false;',
    expect: 'production без cookie',
  },
  {
    name: 'валидная сессия перевыпускается при повторном запросе',
    file: 'packages/server/src/http/session.ts',
    from: `  const existing = readSessionFromCookieHeader(getCookieHeader(req));
  if (existing) {
    // Сессия есть и валидна — просто возвращаем её, не перевыпускаем.
    sendJson(res, 200, { accountId: existing.accountId, issuedAt: existing.issuedAt });
    return true;
  }
`,
    to: '',
    expect: 'повторно не перевыпускается',
  },
  {
    name: 'добыча: узел без фильтра по префиксу',
    file: 'packages/server/src/world/resources.ts',
    from: '    if (!prop.id.includes(RESOURCE_PROP_PREFIX)) continue;',
    to: '    if (false) continue;',
    expect: 'добыча: обычный проп не считается узлом',
  },
  {
    name: 'добыча: радиус не проверяется',
    file: 'packages/server/src/world/resources.ts',
    from: '    if (distance <= bestDistance) {',
    to: '    if (true) {',
    expect: 'добыча: вне радиуса',
  },
  {
    name: 'добыча: кулдаун узла отключён',
    file: 'packages/server/src/world/resources.ts',
    from: "    if (now < readyAt) return { ok: false, reason: 'cooldown', retryMs: readyAt - now };",
    to: '',
    expect: 'добыча: собранный узел',
  },
  {
    name: 'добыча: суточный кап отключён',
    file: 'packages/server/src/world/resources.ts',
    from: "    if (usedToday >= GATHER_DAILY_CAP) return { ok: false, reason: 'cap' };",
    to: '',
    expect: 'добыча: суточный кап',
  },
  {
    name: 'добыча: награда не начисляется',
    file: 'packages/server/src/rooms/SectorRoom.ts',
    from: '      amount: GATHER_REWARD,',
    to: '      amount: 0,',
    expect: 'F1-21: /gather',
  },
  {
    name: 'добыча: команды чата не обрабатываются',
    file: 'packages/server/src/rooms/SectorRoom.ts',
    from: `      if (command) {
        this.runCommand(client, session, command);
        return;
      }`,
    to: '',
    expect: 'F1-21: /gather',
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
