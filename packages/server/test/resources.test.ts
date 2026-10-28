/**
 * Узлы добычи (F1-21): поиск узла.
 *
 * Проверяется чистая логика без сервера: как проп становится узлом и как
 * выбирается ближайший. Здесь это ловится за миллисекунды, а не в
 * интеграции на живом сокете.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { GATHER_DAILY_CAP, GATHER_NODE_COOLDOWN_MS, GATHER_RADIUS } from '@oasis/protocol';
import type { PropDef, WorldDef, ZoneDef } from '@oasis/protocol';

import { parseCommand } from '../src/chat/commands.ts';
import { GatherTracker, dayKey, findResourceNear } from '../src/world/resources.ts';

const NOW = Date.parse('2026-10-28T10:00:00.000Z');
const TOMORROW = NOW + 24 * 60 * 60 * 1000;

function prop(id: string, x: number, z: number): PropDef {
  return { id, type: 'sphere', x, y: 0.2, z, sx: 0.2, sy: 0.2, sz: 0.2, rot: 0, color: 0x8be04b };
}

function zoneOf(props: PropDef[]): Pick<ZoneDef, 'props'> {
  return { props };
}

describe('добыча: поиск узла (findResourceNear)', () => {
  it('добыча: узлом считается только проп с префиксом :res', () => {
    const zone = zoneOf([prop('z_grove:trunk0', 0, 0), prop('z_grove:res0', 4, 0)]);
    // Дерево ближе, но узлом не является — иначе /gather драл бы награду за пропы.
    assert.equal(findResourceNear(zone, 0, 0, 10)?.id, 'z_grove:res0');
  });

  it('добыча: обычный проп не считается узлом', () => {
    const zone = zoneOf([prop('z_grove:trunk0', 1, 0), prop('z_grove:crown0', 2, 0)]);
    assert.equal(findResourceNear(zone, 0, 0, GATHER_RADIUS), null);
  });

  it('добыча: вне радиуса узла нет', () => {
    // Узел в 3.5 м: дальше GATHER_RADIUS = 3 м — сбора быть не должно.
    const zone = zoneOf([prop('z_grove:res0', 3.5, 0)]);
    assert.equal(findResourceNear(zone, 0, 0), null);
    assert.ok(findResourceNear(zone, 1, 0), 'а в радиусе — находится');
  });

  it('добыча: берётся ближайший узел, а не первый по списку', () => {
    const zone = zoneOf([prop('z_grove:res0', 2.5, 0), prop('z_grove:res1', 0.8, 0)]);
    assert.equal(findResourceNear(zone, 0, 0)?.id, 'z_grove:res1');
  });

  it('добыча: закоммиченный мир содержит учебный узел у спавна', () => {
    // Регрессия на генератор: узел в 2.2 м от спавна сектора — это то, с чего
    // игрок начинает знакомство с добычей. Перегенерация без него молча
    // отбрасывает игрока от фичи.
    const world = JSON.parse(
      readFileSync(new URL('../../../content/default/world.json', import.meta.url), 'utf8'),
    ) as WorldDef;
    const spawn = world.sectors[0]?.spawn;
    assert.ok(spawn, 'в секторе должна быть точка спавна');
    const zone = world.zones.find((candidate) => candidate.id === 'z_plaza');
    assert.ok(zone, 'в мире должна быть плаза');
    const node = findResourceNear(zone, spawn.x, spawn.z, GATHER_RADIUS);
    assert.ok(node, 'учебный узел должен быть в радиусе добычи от спавна');
    assert.equal(node.type, 'sphere', 'узел должен рисоваться сферой');
  });
});

describe('добыча: разбор команды чата', () => {
  it('добыча: команда узнаётся и имя приводится к нижнему регистру', () => {
    assert.deepEqual(parseCommand('/GATHER'), { name: 'gather', args: [] });
    assert.deepEqual(parseCommand('/  pay   Иван 10 '), { name: 'pay', args: ['Иван', '10'] });
  });

  it('добыча: обычный текст и один слэш — не команда', () => {
    assert.equal(parseCommand('привет, оазис'), null);
    assert.equal(parseCommand('/'), null);
    assert.equal(parseCommand(' / '), null);
  });
});

describe('добыча: кулдаун узла и суточный кап (GatherTracker)', () => {
  it('добыча: собранный узел уходит в кулдаун и выдаёт остаток', () => {
    const tracker = new GatherTracker();
    assert.deepEqual(tracker.consume('res0', 'a1', NOW), { ok: true, usedToday: 1 });
    assert.deepEqual(tracker.consume('res0', 'a1', NOW + 1000), {
      ok: false,
      reason: 'cooldown',
      retryMs: GATHER_NODE_COOLDOWN_MS - 1000,
    });
  });

  it('добыча: кулдаун проходит и узел снова доступен', () => {
    const tracker = new GatherTracker();
    tracker.consume('res0', 'a1', NOW);
    assert.equal(tracker.consume('res0', 'a1', NOW + GATHER_NODE_COOLDOWN_MS).ok, true);
  });

  it('добыча: кулдаун узла общий для всех игроков', () => {
    const tracker = new GatherTracker();
    tracker.consume('res0', 'a1', NOW);
    // Второй игрок к тому же узлу — тоже кулдаун: слизень один на всех.
    assert.equal(tracker.consume('res0', 'a2', NOW + 1000).ok, false);
  });

  it('добыча: суточный кап считается по аккаунту', () => {
    const tracker = new GatherTracker();
    for (let i = 0; i < GATHER_DAILY_CAP; i += 1) {
      assert.equal(tracker.consume(`res${i}`, 'a1', NOW).ok, true, `сбор ${i + 1} должен пройти`);
    }
    assert.deepEqual(tracker.consume('res0', 'a1', NOW + GATHER_NODE_COOLDOWN_MS), {
      ok: false,
      reason: 'cap',
    });
    // Другой аккаунт своим лимитом не ограничен (узел для него свежий).
    assert.equal(tracker.consume('res_free', 'a2', NOW).ok, true);
  });

  it('добыча: на следующие сутки кап сбрасывается', () => {
    const tracker = new GatherTracker();
    for (let i = 0; i < GATHER_DAILY_CAP; i += 1) tracker.consume(`res${i}`, 'a1', NOW);
    assert.equal(tracker.consume('res0', 'a1', TOMORROW).ok, true);
  });

  it('добыча: сутки капа — ключ UTC, а не локальная дата', () => {
    assert.equal(dayKey(Date.parse('2026-10-28T23:59:59.999Z')), '2026-10-28');
    assert.equal(dayKey(Date.parse('2026-10-29T00:00:00.000Z')), '2026-10-29');
  });
});
