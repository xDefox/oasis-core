/**
 * Автопроверка мира под коллизии (F1-20).
 *
 * Два вида тестов и оба нужны:
 *  - «мир чист» — регрессия: закоммиченный world.json проходит правила;
 *  - «проверка падает» — проверка сама. Тест, который проходит всегда,
 *    хуже отсутствующего: он даёт ложную уверенность. Поэтому каждое
 *    правило ломается руками и ожидается конкретный вердикт.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { propCollider } from '@oasis/protocol';
import type { PropDef, WorldDef, ZoneDef } from '@oasis/protocol';

import { buildWorld } from '../src/world/buildWorld.ts';
import { checkWorld, clearingHit, zoneClearings } from '../src/world/worldCheck.ts';
import type { Clearing, WorldIssue } from '../src/world/worldCheck.ts';

const WORLD_URL = new URL('../../../content/default/world.json', import.meta.url);

async function loadWorld(): Promise<WorldDef> {
  return JSON.parse(await readFile(WORLD_URL, 'utf8')) as WorldDef;
}

function zoneOf(world: WorldDef, id: string): ZoneDef {
  const zone = world.zones.find((candidate) => candidate.id === id);
  assert.ok(zone, `зона ${id} должна быть в мире`);
  return zone;
}

function propOf(zone: ZoneDef, id: string): PropDef {
  const prop = zone.props.find((candidate) => candidate.id === id);
  assert.ok(prop, `проп ${id} должен быть в зоне`);
  return prop;
}

function rulesOf(issues: WorldIssue[]): string[] {
  return issues.map((issue) => `${issue.rule}:${issue.where}`);
}

/**
 * Ставим проп внутрь защищённого круга, но **не в центр**: ближайшая точка
 * габарита — на полрадиуса от центра. Правильное правило держит весь диск
 * и ловит, ослабленное до точки — не ловит.
 *
 * Почему не центр: при мутации `radius: 0` центр круга остаётся внутри
 * пропа, правило срабатывает, тест проходит — и дыра не видна. Проверять
 * надо край диска, а не его точку: именно в краю и стоит игрок, который
 * заходит в портал или появляется на спавне.
 *
 * Направление — по одной оси к центру зоны: по этой оси опора габарита
 * считается точно (AABB совпадает с повёрнутым прямоугольником).
 */
function placeInside(prop: PropDef, clearing: Clearing, zone: ZoneDef): void {
  const collider = propCollider(prop);
  const dx = zone.bounds.x - clearing.x || 1;
  const dz = zone.bounds.z - clearing.z || 1;
  const alongX = Math.abs(dx) >= Math.abs(dz);
  const half = alongX ? (collider.maxX - collider.minX) / 2 : (collider.maxZ - collider.minZ) / 2;
  const distance = clearing.radius / 2 + half;
  prop.x = clearing.x + (alongX ? Math.sign(dx) * distance : 0);
  prop.z = clearing.z + (alongX ? 0 : Math.sign(dz) * distance);
}

test('генератор собирает мир без ловушек', () => {
  assert.deepEqual(
    checkWorld(buildWorld()).map((issue) => issue.message),
    [],
    'регрессия генератора: перегенерация не должна ломать правила коллизий',
  );
});

test('закоммиченный world.json совпадает с выводом генератора', async () => {
  const committed = await readFile(WORLD_URL, 'utf8');
  const generated = `${JSON.stringify(buildWorld(), null, 2)}\n`;
  assert.equal(
    committed,
    generated,
    'мир правится генератором (npm run generate:world), а не руками в JSON',
  );
});

test('закоммиченный мир проходит автопроверку коллизий', async () => {
  const world = await loadWorld();
  assert.deepEqual(
    checkWorld(world).map((issue) => issue.message),
    [],
    'в мире не должно быть щелей-ловушек, забитых порталов и пропов на спавне',
  );
});

test('щель-ловушка между двумя пропами ловится проверкой', async () => {
  const world = await loadWorld();
  const zone = zoneOf(world, 'z_plaza');
  // Две колонны ставим в 1.4 м друг от друга: полуразмер 0.45, поворот
  // произвольный, поэтому зазор гарантированно попадает в диапазон
  // 0.05–1 м — ровно то, в чём игрок застревает.
  const a = propOf(zone, 'z_plaza:col1');
  const b = propOf(zone, 'z_plaza:col2');
  b.x = a.x + 1.4;
  b.z = a.z;

  const issues = checkWorld(world);
  assert.ok(
    rulesOf(issues).includes('gap:z_plaza'),
    `ожидалась щель в z_plaza, получено: ${rulesOf(issues).join(', ') || 'ничего'}`,
  );
  assert.ok(propCollider(a), 'ссылка на проп сохраняется');
});

test('проп в диске портала ловится проверкой', async () => {
  const world = await loadWorld();
  const zone = zoneOf(world, 'z_plaza');
  const clearing = zoneClearings(world, zone).find(
    (candidate) => candidate.rule === 'portal' && candidate.id === 'p_grove',
  );
  assert.ok(clearing, 'в плазе должен быть диск портала p_grove');
  const prop = propOf(zone, 'z_plaza:col1');
  placeInside(prop, clearing, zone);
  assert.ok(
    clearingHit(clearing, propCollider(prop)),
    'проп стоит в диске: полрадиуса от центра, а не в самом центре',
  );

  const issues = checkWorld(world);
  assert.ok(
    rulesOf(issues).includes('portal:p_grove'),
    `ожидался забитый портал, получено: ${rulesOf(issues).join(', ') || 'ничего'}`,
  );
});

test('проп в точке прибытия из портала ловится проверкой', async () => {
  const world = await loadWorld();
  const zone = zoneOf(world, 'z_arena');
  const arrival = zoneClearings(world, zone).find((clearing) => clearing.rule === 'arrival');
  assert.ok(arrival, 'в арене должна быть точка прибытия');
  const prop = propOf(zone, 'z_arena:prop1');
  placeInside(prop, arrival, zone);
  assert.ok(
    clearingHit(arrival, propCollider(prop)),
    'проп стоит в точке прибытия: полрадиуса от центра, а не в самом центре',
  );

  const issues = checkWorld(world);
  assert.ok(
    rulesOf(issues).includes(`arrival:${arrival.id}`),
    `ожидалась забитая точка прибытия, получено: ${rulesOf(issues).join(', ') || 'ничего'}`,
  );
});

test('проп в кольце спавна ловится проверкой', async () => {
  const world = await loadWorld();
  const zone = zoneOf(world, 'z_plaza');
  const spawn = world.sectors[0]!.spawn!;
  const clearing = zoneClearings(world, zone).find(
    (candidate) => candidate.rule === 'spawn' && candidate.id === world.sectors[0]!.id,
  );
  assert.ok(clearing, 'в плазе должно быть кольцо спавна');
  assert.equal(clearing.x, spawn.x, 'кольцо считается от той же точки, что и спавн');
  const prop = propOf(zone, 'z_plaza:col1');
  placeInside(prop, clearing, zone);
  assert.ok(
    clearingHit(clearing, propCollider(prop)),
    'проп стоит в кольце спавна: полрадиуса от центра, а не в самом центре',
  );

  const issues = checkWorld(world);
  assert.ok(
    rulesOf(issues).includes(`spawn:${world.sectors[0]!.id}`),
    `ожидался забитый спавн, получено: ${rulesOf(issues).join(', ') || 'ничего'}`,
  );
});
