/**
 * Генератор мира.
 *
 * Мир — данные. Этот скрипт превращает seed + описание зон в world.json,
 * который коммитится в git и является единственным источником правды о мире.
 *
 * Запуск:  npm run generate:world -w @oasis/server
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorldDef, ZoneDef } from '@oasis/protocol';

import { generateZoneProps } from '../src/world/procedural.ts';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const SEED = 20261021;

const ZONE_BLUEPRINTS: Array<{
  id: string;
  sectorId: string;
  name: string;
  kind: ZoneDef['kind'];
  cx: number;
  cz: number;
  w: number;
  d: number;
  count: number;
  clearRadius: number;
  groundColor: number;
}> = [
  {
    id: 'z_plaza',
    sectorId: 's_plaza',
    name: 'Плаза',
    kind: 'plaza',
    cx: 0,
    cz: 0,
    w: 64,
    d: 64,
    count: 90,
    clearRadius: 7,
    groundColor: 0x6f7a8c,
  },
  {
    id: 'z_grove',
    sectorId: 's_plaza',
    name: 'Роща',
    kind: 'grove',
    cx: 120,
    cz: 0,
    w: 72,
    d: 72,
    count: 110,
    clearRadius: 6,
    groundColor: 0x3f6b46,
  },
  {
    id: 'z_arena',
    sectorId: 's_plaza',
    name: 'Арена',
    kind: 'arena',
    cx: -120,
    cz: 0,
    w: 56,
    d: 56,
    count: 70,
    clearRadius: 8,
    groundColor: 0x5c4a52,
  },
];

function buildWorld(): WorldDef {
  const zones: ZoneDef[] = ZONE_BLUEPRINTS.map((blueprint) => {
    const props = generateZoneProps({
      zoneId: blueprint.id,
      seed: SEED,
      cx: blueprint.cx,
      cz: blueprint.cz,
      w: blueprint.w,
      d: blueprint.d,
      count: blueprint.count,
      clearRadius: blueprint.clearRadius,
      kind: blueprint.kind,
    });
    return {
      id: blueprint.id,
      sectorId: blueprint.sectorId,
      name: blueprint.name,
      kind: blueprint.kind,
      bounds: { x: blueprint.cx, z: blueprint.cz, w: blueprint.w, d: blueprint.d },
      groundColor: blueprint.groundColor,
      props,
    };
  });

  return {
    id: 'default',
    version: 1,
    seed: SEED,
    generator: 'oasis-v1',
    sectors: [
      {
        id: 's_plaza',
        name: 'Сектор Плаза',
        flags: { pvp: false, magic: false, tech: true, teleport: true, comms: true },
        spawn: { x: 0, y: 0, z: 4 },
      },
    ],
    zones,
    portals: [
      { id: 'p_grove', fromZone: 'z_plaza', toZone: 'z_grove', x: 26, z: 0, radius: 3 },
      { id: 'p_arena', fromZone: 'z_plaza', toZone: 'z_arena', x: -26, z: 0, radius: 3 },
      { id: 'p_back_grove', fromZone: 'z_grove', toZone: 'z_plaza', x: 92, z: 0, radius: 3 },
      { id: 'p_back_arena', fromZone: 'z_arena', toZone: 'z_plaza', x: -92, z: 0, radius: 3 },
    ],
  };
}

async function main(): Promise<void> {
  const world = buildWorld();
  const target = resolve(REPO_ROOT, 'content/default/world.json');
  await mkdir(resolve(REPO_ROOT, 'content/default'), { recursive: true });
  await writeFile(target, `${JSON.stringify(world, null, 2)}\n`, 'utf8');

  const propCount = world.zones.reduce((sum, zone) => sum + zone.props.length, 0);
  console.log(
    `[oasis] мир записан: ${target} (секторов: ${world.sectors.length}, зон: ${world.zones.length}, объектов: ${propCount})`,
  );
}

main().catch((error: unknown) => {
  console.error('[oasis] генератор мира упал', error);
  process.exit(1);
});
